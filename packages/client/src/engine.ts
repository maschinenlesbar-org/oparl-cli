// The request engine: turns absolute OParl URLs into HTTP GET requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), follows
// redirects on the same host only, and decodes JSON responses.
//
// OParl has no single API host — every municipality runs its own server — so the
// engine works on absolute URLs instead of a base URL plus paths. URLs come from the
// user (a System URL) and from the servers themselves (list and pagination links),
// which is why redirects and links are kept on the host they came from (see
// resolveLink).

import { constants } from "node:buffer";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage, type HttpRequest, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  OparlApiError,
  OparlError,
  OparlLinkError,
  OparlNetworkError,
  OparlParseError,
  OparlValidationError,
  MAX_SERVER_TEXT_LENGTH,
  TextBuilder,
  cutForMessage,
  cutText,
  quoteValue,
  redactUrl,
} from "./errors.js";
import { assertValid, intRangeProblem, urlArgumentProblem } from "./validate.js";

const DEFAULT_USER_AGENT = "oparl-cli";

/** The most retries `maxRetries` may ask for (and `--max-retries` takes). */
export const MAX_RETRIES = 10;
/** The most redirects `maxRedirects` may ask for (and `--max-redirects` takes). */
export const MAX_REDIRECTS = 10;

export interface EngineOptions {
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` on any transport and checks the shape of
   * what it returns (see HttpResponse).
   */
  transport?: Transport | undefined;
  /** Value of the User-Agent header. */
  userAgent?: string | undefined;
  /**
   * Extra headers sent on every request. The values of credential headers (Authorization,
   * Proxy-Authorization, X-API-Key, Cookie) are kept out of logged clients and errors, and
   * go only to the origin of the URL a request starts at (see fetchJson).
   */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables). Defaults to 120 s: some
   * council systems take well over 30 s to render a single list page. A non-negative
   * integer, capped at MAX_TIMEOUT_MS. The engine enforces it for every transport.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient 429/503 responses and reset connections
   * (ECONNRESET, EPIPE, ECONNABORTED, UND_ERR_SOCKET): 0 to MAX_RETRIES. Timeouts are
   * not retried.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (default 500), 0 to MAX_RETRY_AFTER_MS
   * (30 000). Grows linearly per attempt for a 503 and a reset; a 429 waits at least 1 s,
   * doubling per attempt. A Retry-After header (seconds or an HTTP date) can lengthen a
   * wait, never shorten it; every wait is capped at 30 s.
   */
  retryDelayMs?: number | undefined;
  /**
   * Redirects (301/302/303/307/308) followed per request, same host only. Defaults to 3;
   * 0 disables; at most MAX_REDIRECTS. Any other 3xx, one without a Location, and one
   * past this limit surface as an OparlApiError naming the target.
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. A
   * non-negative integer.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `oparl.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a 64-bit id). The value of a declared
   * member is delivered as its exact literal, as written, as a JSON string (`"5"`), so its type
   * never depends on its size. A declared member whose value is not a number (a string, `null`,
   * an object) is left as it is. Every undeclared number keeps the rule: exact, or an
   * OparlParseError. Matched by name anywhere in a JSON answer, an escaped name
   * (`"\u0073ize"`) included. Defaults to none (OParl declares none); anything but a set or list
   * of non-empty strings is an OparlValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a cache
 * answer to a conditional request this client never sends) and 305/306 (deprecated) are
 * not redirects to follow; they surface as an OparlApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Longest wait honoured from a Retry-After header, so a hostile 429 can't stall us. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Shortest wait before retrying a 429: a rate limit is not lifted in half a second. */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds: the delta-seconds form
 * (`Retry-After: 120`) or the HTTP-date form (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`;
 * a date in the past is 0). Undefined when the header is absent or unparseable, so the
 * caller falls back to its own backoff. Only an IMF-fixdate reaches `Date.parse`: V8 reads
 * "1.5" or "-5" as dates in 2001.
 */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  if (!IMF_FIXDATE.test(raw)) return undefined;
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}
/** Deepest JSON nesting accepted; OParl objects are a handful of levels deep. */
const MAX_JSON_DEPTH = 256;

/** Characters of server text kept in one error message; the rest is cut with an ellipsis. */
export { MAX_SERVER_TEXT_LENGTH };

/**
 * The most server text (in UTF-16 units) `sanitizeServerText` reads; a longer text is cut first.
 * Every message keeps far less of it (`maxLength`, MAX_SERVER_TEXT_LENGTH: 200 characters), and
 * cleaning all of a 16 MB error detail, one string node per character, exhausted a small heap.
 */
const MAX_SERVER_TEXT = 16 * 1024;

/**
 * A whole terminal escape sequence: a CSI (`ESC [` or the 8-bit U+009B, parameters,
 * intermediates, final byte), a terminated control string (OSC/DCS/SOS/PM/APC, `ESC ]` …
 * up to BEL or ST, or their 8-bit forms) or a short `ESC` sequence. Dropping only the
 * control bytes left the printable rest behind (`ESC ] 0 ; title BEL` became `]0;title`).
 * An unterminated control string is left to the per-character filter, so it cannot
 * swallow the rest of the message. A control string's body ends at an ESC or at another
 * introducer: with the introducers allowed inside it, an unterminated run of them was matched
 * from each one to the end of the text, quadratic (100 000 × U+009D took 16 s). Written with
 * escapes, so the source holds no control bytes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[\u0020-\u002f]*[\u0030-\u007e]/g;

/**
 * What `sanitizeServerText` drops once the escape sequences are gone: the C0 controls but the
 * whitespace ones (TAB to CR), DEL, the C1 controls, and every format character (General
 * Category Cf: bidi controls, zero-width characters, U+00AD, U+FEFF, …).
 */
const DROPPED_CHAR = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

/**
 * Make a string that originates in an attacker-controlled response body safe to put
 * into an error message printed raw to stderr by run.ts — an error `detail` snippet,
 * an object `type`, a link, a `Content-Type`:
 *
 * - Whole escape sequences (CSI, OSC and other control strings) are dropped first, then any
 *   remaining control character (all C0 and C1 but the whitespace ones, plus DEL). Without
 *   this, a hostile or spoofed server could drive ANSI/OSC escape sequences (display
 *   spoofing, terminal title changes) into the user's terminal.
 * - Unicode format characters (General Category Cf) are dropped: the bidi controls, so
 *   server text cannot reorder the visible message, and the invisible ones (zero-width
 *   space and joiners, word joiner, soft hyphen, BOM), so two messages that look identical
 *   are identical.
 * - Every run of whitespace — newlines and Unicode line separators included — becomes
 *   a single space, so the result is one line and a server cannot forge a second
 *   log record of its own next to ours.
 * - The result is capped at `maxLength` characters, so a 3 KB "message" cannot bury
 *   the diagnostic the CLI printed. The cut never splits a surrogate pair (`cutText`),
 *   so the message stays well-formed.
 * - Only the first MAX_SERVER_TEXT (16 384) units are read, and every step is a linear regex
 *   replace: a hostile error body costs neither seconds nor the heap. A caller that scrubs
 *   credentials does so first, so a cut never splits one.
 *
 * Every server-supplied string that reaches a message goes through here. The CLI's
 * JSON output is escaped separately (escapeControlChars in cli/shared.ts):
 * JSON.stringify alone leaves DEL and the C1 range raw. Written with escapes so no raw
 * control byte appears in this source.
 */
export function sanitizeServerText(text: string, maxLength: number = MAX_SERVER_TEXT_LENGTH): string {
  const clean = cutText(text, MAX_SERVER_TEXT).replace(ESCAPE_SEQUENCE, "").replace(DROPPED_CHAR, "").replace(/\s+/g, " ").trim();
  // Never cut inside a surrogate pair: half a character makes the message ill-formed.
  return cutForMessage(clean, maxLength);
}

/**
 * True for a bidi formatting character: the Arabic letter mark (U+061C), LRM and RLM
 * (U+200E, U+200F), the embeddings and overrides (U+202A–U+202E) and the isolates
 * (U+2066–U+2069). A terminal acts on them: they reorder the text that follows.
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** HTTP header field name grammar (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Why a value cannot be sent in the `name` header, or undefined when it can. Node throws
 * an opaque, synchronous `ERR_INVALID_CHAR` from inside `request()` for a value outside
 * `\t`, 0x20–0x7e and obs-text (0x80–0xff) — a `--user-agent` holding an emoji or an en
 * dash surfaced as "Unexpected error". Latin-1 is left through: the grammar deprecates
 * it but Node sends it and servers read it. Checked by code point so the source stays
 * free of control bytes.
 */
export function headerValueProblem(name: string, value: string): string | undefined {
  // A JavaScript caller may pass anything; iterating a number was a raw TypeError.
  if (typeof value !== "string") return `The ${name} header value must be a string.`;
  for (const ch of value) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x09) continue;
    if (n <= 0x1f || n === 0x7f) return `The ${name} header value contains control characters.`;
    if (n > 0xff) {
      return (
        `The ${name} header value contains U+${n.toString(16).toUpperCase().padStart(4, "0")}, which cannot be sent ` +
        "in an HTTP header: header values are limited to ASCII and Latin-1 characters."
      );
    }
  }
  return undefined;
}

/** True for a loopback host name: `localhost`, `127.0.0.0/8`, `::1` (as `URL.hostname` gives them). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * What travels unencrypted when requests go to `baseUrl`, as one sentence for the
 * cleartext warning (a WARN record of `oparl.http`) — or `undefined` when nothing does: an `https:` URL, a URL that does
 * not parse (the base-URL check reports that), or a loopback host (`localhost`,
 * `127.0.0.0/8`, `::1`). The sentence names the host (`url.host`, host and port) and what
 * is sent with each request: the base URL's own credentials (userinfo) and any other
 * secret passed as a noun phrase in `secrets` (e.g. `"the API key"`). It never contains
 * a password or key. The CLI prints it once per run, before the first request.
 *
 * oparl has no base URL: every command names the URL it starts from (a System, Body or
 * object URL, or the endpoint registry), so the CLI passes that start URL here, once per
 * run; the links a server hands out on the way are not checked again.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const sent = [...secrets];
  if (url.username !== "" || url.password !== "") sent.push("the base URL's credentials");
  if (sent.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  // "the base URL's credentials" and any pair are plural; a single secret phrase is not.
  const verb = sent.length === 1 && secrets.length === 1 ? "is" : "are";
  return `${sent.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * Return `value` when it can be sent in the `name` header, else throw an
 * OparlValidationError with the reason from headerValueProblem. The CLI's
 * `--user-agent` parser calls this too, so both reject the same values alike.
 */
export function assertHeaderValue(name: string, value: string): string {
  const reason = headerValueProblem(name, value);
  if (reason !== undefined) throw new OparlValidationError(reason);
  return value;
}

/**
 * Why a value cannot be the User-Agent, or undefined when it can: a blank value
 * (empty or whitespace only) is refused before the header-value rule. Only an absent
 * `userAgent` means the default; a blank one would otherwise be sent as is. The
 * CLI's `--user-agent` parser calls this too.
 */
export function userAgentProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return headerValueProblem("User-Agent", value);
}

/**
 * Check a header this client is about to send: a name that is not a token
 * (`ERR_INVALID_HTTP_TOKEN` in Node) or a value assertHeaderValue refuses becomes an
 * OparlValidationError, which the CLI reports as the usage error it is (exit 2) and
 * library callers can catch.
 */
function checkHeader(name: string, value: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new OparlValidationError(`${quoteValue(name, 40)} is not a valid HTTP header name.`);
  }
  assertHeaderValue(name, value);
}

/**
 * Parse a user-supplied URL, accepting only http: and https: (a blank or malformed
 * value, or another scheme, is an OparlValidationError). Any `user:password@`
 * part is removed: OParl access is anonymous, and credentials in a URL would
 * otherwise be sent as Basic auth to whatever server the URL names and be echoed in
 * error messages.
 */
export function parseHttpUrl(value: string): URL {
  if (typeof value === "string" && value.trim() === "") throw new OparlValidationError("Expected a non-empty URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OparlValidationError("Not a valid URL.");
  }
  url.username = "";
  url.password = "";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // A URL typed without its scheme (`bob:hunter2@ris.example/oparl`) parses with the
    // scheme `bob:` and its password in the path, so the userinfo is cut out by text.
    // `href` keeps control characters percent-encoded.
    const shown = redactUrl(url.href);
    const hint = typeof value === "string" && !value.includes("://") ? " Is the https:// missing?" : "";
    throw new OparlValidationError(`Only http: and https: URLs are supported: ${cutForMessage(shown)}.${hint}`);
  }
  return url;
}

/**
 * A URL a caller gives (a System, Body, object or registry URL), checked: `urlArgumentProblem`
 * (no control, format or half character, which URL parsing would percent-encode silently),
 * then `parseHttpUrl`. The client and the CLI's URL arguments use it; links a server hands out
 * go through `resolveLink`.
 */
export function parseUrlArgument(value: string): URL {
  const problem = urlArgumentProblem(value);
  if (problem !== undefined) throw new OparlValidationError(problem);
  return parseHttpUrl(value);
}

const effectivePort = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

/**
 * Resolve a link the server handed out (a pagination `next` link, a Body's list URL,
 * a redirect `Location`) against the URL it came from, and decide whether to follow
 * it. Links stay on the same host: another hostname or port is refused. An `http:`
 * link on the same host as an `https:` page is upgraded to `https:` — several
 * servers publish `http://` ids while serving https — and a downgrade is never
 * followed.
 */
export function resolveLink(from: string, link: string): string {
  const base = new URL(from);
  base.username = "";
  base.password = "";
  let target: URL;
  try {
    target = new URL(link, base);
  } catch {
    throw new OparlLinkError(`The server returned an invalid link: ${sanitizeServerText(link)}`);
  }
  target.username = "";
  target.password = "";
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new OparlLinkError(`Refusing to follow a non-http link: ${sanitizeServerText(target.href)}`);
  }
  if (target.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    throw new OparlLinkError(
      `Refusing to follow ${sanitizeServerText(target.href)} from ${cutForMessage(base.href)}: it points to another host. ` +
        "Links are only followed on the server they came from; fetch it directly with `get` if you trust it.",
    );
  }
  if (base.protocol === "https:" && target.protocol === "http:") {
    const port = target.port;
    target.protocol = "https:";
    if (port === "80" || port === "") target.port = "";
  }
  // An upgrade from http to https on the default ports (e.g. a 301 to the https site)
  // changes the port from 80 to 443; that is the same server, not another port.
  const upgradedOnDefaultPorts =
    base.protocol === "http:" && target.protocol === "https:" && effectivePort(base) === "80" && effectivePort(target) === "443";
  if (!upgradedOnDefaultPorts && effectivePort(target) !== effectivePort(base)) {
    throw new OparlLinkError(
      `Refusing to follow ${sanitizeServerText(target.href)} from ${cutForMessage(base.href)}: it points to another port.`,
    );
  }
  return target.href;
}

/**
 * Rewrite `http://` URLs on the host a response was fetched from over https to
 * `https://`, everywhere in the decoded JSON. Several servers (Somacos in Dresden and
 * Düsseldorf) publish `http://` ids while serving https; printed as-is, passing such an
 * id back to the CLI — the documented `bodies` → `list` workflow — sent every later
 * request in plain text, or hung where port 80 is closed. Only default ports are
 * rewritten; other hosts and responses fetched over http are left alone.
 */
export function upgradeSameHostUrls<T>(value: T, fetchedFrom: string): T {
  const base = new URL(fetchedFrom);
  if (base.protocol !== "https:" || base.port !== "") return value;
  const host = base.hostname.toLowerCase();
  const rewrite = (text: string): string => {
    if (text.length < 8 || text.slice(0, 7).toLowerCase() !== "http://") return text;
    const end = text.slice(7).search(/[/?#]/);
    const authority = end === -1 ? text.slice(7) : text.slice(7, 7 + end);
    // Only a plain host[:port] is rewritten. A backslash, whitespace or userinfo ends
    // the authority for WHATWG URL parsing but not for the scan above, so rewriting
    // such a string would drop the rest of it ("http://host\evil" → "https://host").
    if (!/^[a-z0-9.:[\]-]*$/i.test(authority)) return text;
    let parsed: URL;
    try {
      parsed = new URL(`http://${authority}`);
    } catch {
      return text;
    }
    if (parsed.hostname.toLowerCase() !== host || (parsed.port !== "" && parsed.port !== "80") || parsed.username !== "") {
      return text;
    }
    return `https://${base.host}${end === -1 ? "" : text.slice(7 + end)}`;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rewrite(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      // Each member is defined, not assigned: `out["__proto__"] = …` calls the prototype
      // setter, which dropped the key and made its value the object's prototype. JSON.parse
      // makes it an own member like any other, and so does this copy.
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        Object.defineProperty(out, key, { value: walk(child), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Append query parameters to a URL, keeping any it already carries — including a
 * second copy of a parameter the URL already has. Not what this client sends: every
 * request it makes goes through `carryQuery`, so the caller's filters replace the
 * server's copy on the first page, on a redirect target and on a `next` link alike.
 * Kept for callers building their own URLs.
 */
export function withQuery(url: string, query?: QueryParams): string {
  if (!query) return url;
  const qs = buildQueryString(query);
  if (!qs) return url;
  const parsed = new URL(url);
  for (const [key, value] of new URLSearchParams(qs)) parsed.searchParams.append(key, value);
  return parsed.href;
}

/**
 * Set the client's query parameters on a URL, replacing any copy already there. This
 * is the one rule for every request the engine makes — the URL the caller passed, the
 * target of a redirect, and a server-supplied `next` link are all treated alike, so
 * the caller's filters are the ones that apply to every page.
 *
 * Both halves of that matter in practice. Servers build their links themselves and get
 * it wrong: Somacos servers echo `modified_since=…+00:00` unencoded, so the `+` arrives
 * as a space and every page after the first would be silently unfiltered; others drop
 * the parameters altogether, or redirect to a URL without them. And list URLs that
 * already carry a query are common (ALLRIS links `papers.asp?body=1`), so appending
 * instead of replacing would send `limit` twice with different values — which server
 * wins is anyone's guess.
 */
export function carryQuery(url: string, query?: QueryParams): string {
  if (!query) return url;
  const wanted = buildQueryString(query);
  if (wanted === "") return url;
  const own = new Set(new URLSearchParams(wanted).keys());
  const parsed = new URL(url);
  // Only the client's own parameters are rewritten. The server's are kept byte for byte:
  // re-serialising them turned `%20` into `+` and a bare `flag` into `flag=`, which a
  // server that doesn't form-decode, or tells the two apart, reads differently.
  const kept = parsed.search
    .slice(1)
    .split("&")
    .filter((part) => part !== "" && !own.has(formDecode(part.split("=", 1)[0] ?? "")));
  parsed.search = [...kept, wanted].join("&");
  return parsed.href;
}

/** A query-string key as a server reads it: `+` is a space, then percent-decoding. */
function formDecode(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return text;
  }
}

/** The OParl list parameters that hold a timestamp (`2026-09-20T00:00:00+00:00`). */
const TIMESTAMP_PARAMS = new Set(["created_since", "created_until", "modified_since", "modified_until"]);

/**
 * Re-encode a literal `+` in the OParl timestamp parameters of a URL as `%2B`. Somacos
 * servers hand out `next` links with `modified_since=2026-09-20T00:00:00+00:00`
 * unencoded; sent as is, the server reads the `+` as a space, answers a different page,
 * and the `next` link of that page has lost the filter altogether. A timestamp never
 * holds a space, so in these four parameters a `+` can only mean a plus sign. Every
 * other part of the URL is left exactly as it was.
 */
export function encodeTimestampPlus(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return url;
  const hash = url.indexOf("#", start);
  const end = hash === -1 ? url.length : hash;
  let changed = false;
  const parts = url
    .slice(start + 1, end)
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1 || !TIMESTAMP_PARAMS.has(part.slice(0, eq)) || !part.includes("+", eq)) return part;
      changed = true;
      return `${part.slice(0, eq)}=${part.slice(eq + 1).replaceAll("+", "%2B")}`;
    });
  return changed ? `${url.slice(0, start + 1)}${parts.join("&")}${url.slice(end)}` : url;
}

/** Response headers as the engine reads them: a record with lower-case names. */
type ResponseHeaders = Record<string, string | string[] | undefined>;

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties: the
 * engine then saw no `Location` ("redirect not followed (no Location header)") and no
 * `Retry-After`. Such an object (anything with `get` and `forEach`, a `Map` included) is
 * copied into a record; a plain record gets its names lower-cased, as the engine reads
 * them (`{ Location: … }` type-checks as IncomingHttpHeaders).
 */
function plainHeaders(headers: object): ResponseHeaders {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record = Object.create(null) as ResponseHeaders;
  for (const [name, value] of Object.entries(headers as ResponseHeaders)) record[name.toLowerCase()] = value;
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * How deep `value` nests, counted up to just past MAX_JSON_DEPTH. Iterative, linear, and without
 * an allocation per value: only nested objects and arrays are kept for later, with their depth in
 * a parallel list (a pair per element, numbers included, took a gigabyte on an answer of 8M numbers).
 */
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const nodes: object[] = [value];
  const depths: number[] = [1];
  let max = 0;
  while (nodes.length > 0) {
    const node = nodes.pop() as object;
    const depth = depths.pop() as number;
    if (depth > max) max = depth;
    if (max > MAX_JSON_DEPTH) return max;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child: unknown = node[i];
        if (child !== null && typeof child === "object") {
          nodes.push(child);
          depths.push(depth + 1);
        }
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const key in record) {
      const child = record[key];
      if (child !== null && typeof child === "object") {
        nodes.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return max;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A decoded JSON response together with the URL it was finally read from. */
export interface JsonResponse<T> {
  /** The decoded body. */
  value: T;
  /**
   * The URL the request ended on: the last redirect target, or the requested URL when
   * there was none. Relative links inside the body are resolved against this, as RFC
   * 3986 §5.1.3 requires — a server that redirects `/oparl` to `/v1/system` and then
   * hands out `"body": "bodies"` means `/v1/bodies`.
   */
  url: string;
}

/** The `Content-Type` of a response, without parameters, lowercased and sanitised. */
function contentType(headers: ResponseHeaders): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return sanitizeServerText(value.split(";")[0]?.trim().toLowerCase() ?? "", 60);
}

/**
 * What the server sent instead of JSON, for the error message: council systems answer
 * list URLs with HTML error pages (Aachen's begins with an HTML comment, Apache's with
 * an XML declaration, so a prefix test alone misses them) and file URLs with the file
 * itself. Both the sniffed body and the declared `Content-Type` are consulted; null
 * when neither says anything useful.
 */
function nonJsonBody(body: Buffer, text: string, type: string): string | null {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  // A body that starts like JSON is broken JSON, whatever the server declared it to be.
  if (head.startsWith("{") || head.startsWith("[")) return null;
  if (head.includes("<!doctype html") || head.includes("<html")) return "an HTML page";
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") return "a PDF file";
  if (head.startsWith("<?xml")) return "an XML document";
  if (type === "text/html" || type === "application/xhtml+xml") return "an HTML page";
  if (type === "application/pdf") return "a PDF file";
  if (type.endsWith("/xml") || type.endsWith("+xml")) return "an XML document";
  if (head.startsWith("<")) return "a markup document";
  return null;
}

/**
 * A function option: `undefined` gives the default; anything else that is not a function
 * is an OparlValidationError. A string `transport` failed at the first request instead, and
 * a bad `sleep` as a raw TypeError on the first retry.
 */
function functionOption<F>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") throw new OparlValidationError(`Invalid ${name}: Expected a function, got ${typeof value}.`);
  return value;
}

/** The origin of `url` (scheme, host and port), or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Header names (lower-case) that carry credentials. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);

/** Whether `name` is a credential header (any case). */
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

/**
 * The secret parts of the credential headers among `headers`: the whole value, the part
 * after an auth scheme (`Bearer <token>` → the token), and for `Basic` the decoded
 * `user:password` and the password. Each is also kept as a URL (`encodeURIComponent`: a
 * redirect's Location, a link) and as a JSON string (`\"`, `\\`) spell it, so an echo in
 * those spellings is scrubbed too. A value with inner spaces is a secret whole, never word by
 * word.
 */
function credentialSecrets(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) continue;
    secrets.add(value.trim());
    const token = value.trim().replace(/^\S+\s+/, "");
    secrets.add(token);
    if (/^basic\s/i.test(value.trim())) {
      // The bytes as UTF-8 (how a server reads them today) and as Latin-1 (RFC 7617's old default).
      const bytes = Buffer.from(token, "base64");
      for (const pair of new Set([bytes.toString("utf8"), bytes.toString("latin1")])) {
        secrets.add(pair);
        if (pair.includes(":")) secrets.add(pair.slice(pair.indexOf(":") + 1));
      }
    }
  }
  const spelled = [...secrets].filter((secret) => secret.length >= 4).flatMap(urlSpellings).flatMap(jsonSpellings);
  // The longest first, so a value is replaced before a part of it.
  return [...new Set(spelled)].sort((a, b) => b.length - a.length);
}

/**
 * `form` and its spelling in a URL (`encodeURIComponent`): a server that puts a credential into
 * a URL, a redirect's Location, percent-encodes it. A form that has no such spelling (a lone
 * surrogate) is kept as it is.
 */
function urlSpellings(form: string): string[] {
  try {
    return [form, encodeURIComponent(form)];
  } catch {
    return [form];
  }
}

/**
 * `form` and its spelling inside a JSON string (`\"`, `\\`): an error body kept as its decoded
 * JSON written again (`scrubBody`) spells a credential with a quote in it with a backslash.
 */
function jsonSpellings(form: string): string[] {
  return [form, JSON.stringify(form).slice(1, -1)];
}

/**
 * `text` with every occurrence of each secret (a header value, which has no `@` to anchor
 * on) replaced by `***`. Secrets shorter than 4 characters are skipped: they are not
 * credentials, and replacing them would garble the rest of the text.
 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws an OparlValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new OparlValidationError("Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a credential a library caller put in
  // `defaultHeaders` can't be logged by accident.
  readonly #defaultHeaders: Record<string, string>;
  /** The secret parts of the credential headers, scrubbed from server and transport text. */
  readonly #secrets: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertValid("userAgent", options.userAgent, userAgentProblem);
    const given: unknown = options.defaultHeaders;
    if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
      throw new OparlValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) checkHeader(name, value);
    this.#secrets = credentialSecrets(this.#defaultHeaders);
    // Every numeric option is checked: NaN, Infinity, a fraction or a negative number
    // would silently defeat the comparisons below (no timeout, no cap, no end).
    const nonNegative = intRangeProblem(0);
    this.timeoutMs = assertValid("timeoutMs", options.timeoutMs ?? 120_000, nonNegative);
    this.maxRetries = assertValid("maxRetries", options.maxRetries ?? 2, intRangeProblem(0, MAX_RETRIES));
    this.retryDelayMs = assertValid("retryDelayMs", options.retryDelayMs ?? 500, intRangeProblem(0, MAX_RETRY_AFTER_MS));
    this.maxRedirects = assertValid("maxRedirects", options.maxRedirects ?? 3, intRangeProblem(0, MAX_REDIRECTS));
    this.maxResponseBytes = assertValid("maxResponseBytes", options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, nonNegative);
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry = options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning = options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * GET an absolute URL and decode the JSON reply. Retries 429/503 (honouring a
   * Retry-After in seconds, capped at 30 s), follows up to `maxRedirects` redirects on
   * the same host, and rejects non-JSON bodies with an OparlParseError.
   */
  async getJson<T = unknown>(url: string, query?: QueryParams): Promise<T> {
    return (await this.fetchJson<T>(url, query)).value;
  }

  /**
   * As `getJson`, but also reporting the URL the request ended on so that relative
   * links in the body can be resolved against the document they came from.
   *
   * `query` is set on the requested URL and again on every redirect target: a server
   * that redirects a filtered list URL to a path without the query would otherwise
   * answer the unfiltered list, and nothing in the result would say so. A literal `+`
   * in an OParl timestamp parameter is sent as `%2B` (see encodeTimestampPlus).
   *
   * Credential headers from `defaultHeaders` go to the origin the request starts at only:
   * a same-origin redirect (relative or absolute `Location`) keeps them, the http→https
   * upgrade resolveLink allows drops them for the rest of the chain (a 401/403 then says
   * so), and every other origin is refused anyway. The transport is told `redirect:
   * "manual"`; a response whose `url` shows the transport followed a redirect to another
   * origin itself fails the request.
   */
  async fetchJson<T = unknown>(url: string, query?: QueryParams): Promise<JsonResponse<T>> {
    const requested = encodeTimestampPlus(carryQuery(parseHttpUrl(url).href, query));
    const plain: Record<string, string> = {};
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      (isCredentialHeader(name) ? credentials : plain)[name] = value;
    }
    plain["Accept"] = "application/json";
    plain["User-Agent"] = this.userAgent;
    const hasCredentials = Object.keys(credentials).length > 0;
    // Credential headers belong to the origin the request starts at (scheme, host, port).
    const credentialOrigin = new URL(requested).origin;
    let dropped: { from: string; to: string } | undefined;

    let current = requested;
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      const sendCredentials = hasCredentials && dropped === undefined && new URL(current).origin === credentialOrigin;
      const headers = sendCredentials ? { ...plain, ...credentials } : plain;
      let raw: unknown;
      try {
        raw = await this.callTransport({
          method: "GET",
          url: current,
          headers,
          redirect: "manual",
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server reset is the network-level twin of a 503: the GET is
        // sent again, whichever transport reported it (Node's ECONNRESET, fetch's
        // UND_ERR_SOCKET). A timeout is not retried: a slow council system should not be
        // asked again at once.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, current);
          continue;
        }
        throw this.toNetworkError(current, cause);
      }

      // An injected transport may resolve with anything; a malformed response would
      // otherwise surface below as a raw TypeError, or — without a status — as a success.
      const invalid = responseProblem(raw);
      if (invalid !== undefined) {
        throw new OparlNetworkError(`GET ${cutForMessage(current)} failed: the transport returned an invalid response (${invalid}).`);
      }
      const response = raw as HttpResponse;
      // A transport that followed a redirect itself (fetch's default) took the request to a
      // server the engine never checked — credential headers and all: fetch strips
      // Authorization across origins, but not X-API-Key or Cookie. Don't trust it.
      const reported = (response as { url?: unknown }).url;
      if (typeof reported === "string" && reported !== "" && originOf(reported) !== originOf(current)) {
        throw new OparlNetworkError(
          `GET ${cutForMessage(current)} failed: the transport followed a redirect to ${originOf(reported) ?? "an unparseable URL"}, ` +
            'another origin. A transport must not follow redirects (HttpRequest.redirect is "manual"); the engine ' +
            "follows them and decides where credential headers may go.",
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the built-in one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new OparlNetworkError(`GET ${cutForMessage(current)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }

      if ((status === 429 || status === 503) && attempt < this.maxRetries) {
        attempt += 1;
        await this.backOff(attempt, this.retryDelay(status, responseHeaders["retry-after"], attempt), current, status);
        continue;
      }

      if (status >= 300 && status < 400) {
        const header = responseHeaders["location"];
        const location = typeof header === "string" && header.trim() !== "" ? header : undefined;
        if (location !== undefined && FOLLOWED_REDIRECTS.has(status)) {
          if (redirects >= this.maxRedirects) {
            // A loop or a long chain: say how far it got. (With maxRedirects 0 nothing
            // was followed, and the plain text says enough.)
            throw this.toApiError(current, status, body, responseHeaders, location, redirects || undefined, dropped);
          }
          redirects += 1;
          const next = encodeTimestampPlus(carryQuery(resolveLink(current, location), query));
          // resolveLink keeps a redirect on the same host and port, but upgrades http to
          // https: another origin, so the credential headers stay behind for the rest of
          // the chain, and a 401/403 there says why.
          const nextOrigin = new URL(next).origin;
          if (hasCredentials && dropped === undefined && nextOrigin !== credentialOrigin) {
            dropped = { from: new URL(current).origin, to: nextOrigin };
          }
          current = next;
          continue;
        }
        // Any other 3xx, or one without a Location: nothing to follow.
        throw this.toApiError(current, status, body, responseHeaders, location, undefined, dropped);
      }

      if (status < 200 || status >= 300) {
        throw this.toApiError(current, status, body, responseHeaders, undefined, undefined, dropped);
      }

      const value = upgradeSameHostUrls(this.decode<T>(current, body, responseHeaders), current);
      return { value, url: current };
    }
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<unknown> {
    const call = (signal?: AbortSignal): Promise<unknown> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new OparlNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The wait before retry `attempt` of a 429 or 503. The normal backoff is the floor: from
   * 1 s doubling per attempt for a 429 (or from retryDelayMs, if larger), linear from
   * retryDelayMs for a 503. A Retry-After header — seconds or an HTTP date — can ask for
   * longer, never for less: `Retry-After: 0` or a date in the past turned the retries into
   * a burst against a council server that had just asked for less load. Every wait is
   * capped at MAX_RETRY_AFTER_MS (30 s), so a hostile value can't stall the client.
   */
  private retryDelay(status: number, retryAfter: string | string[] | undefined, attempt: number): number {
    const backoff =
      status === 429
        ? Math.max(this.retryDelayMs, MIN_RATE_LIMIT_DELAY_MS) * 2 ** (attempt - 1)
        : this.retryDelayMs * attempt;
    const asked = parseRetryAfter(retryAfter);
    return Math.min(asked === undefined ? backoff : Math.max(asked, backoff), MAX_RETRY_AFTER_MS);
  }

  private decode<T>(url: string, rawBody: Buffer, headers: ResponseHeaders): T {
    const request = `GET ${cutForMessage(url)}`;
    const body = this.decompress(url, rawBody, headers);
    const decoded = decodeText(body, headers, request);
    const text = decoded.text;
    if (text.trim().length === 0) {
      throw new OparlParseError(`${request}: empty response body (expected OParl JSON).`);
    }
    const repaired = wellFormedEscapes(text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (cause) {
      // Only now that it is certain the body is not JSON: a server may serve perfectly
      // good OParl JSON as text/html, and that is accepted.
      const type = contentType(headers);
      const what = nonJsonBody(body, text, type);
      const typePart = type === "" ? "" : ` (content-type: ${type})`;
      throw new OparlParseError(
        what === null
          ? `${request}: the answer is not valid JSON${typePart}.`
          : `${request}: expected OParl JSON but received ${what}${typePart}` +
            (what === "a PDF file"
              ? " — this CLI prints file metadata, it does not download files."
              : " — is this an OParl URL?"),
        // V8's SyntaxError quotes the body, which may echo the request's headers.
        { cause: this.scrubCause(cause) },
      );
    }
    if (jsonDepth(value) > MAX_JSON_DEPTH) {
      throw new OparlParseError(`${request}: the answer is nested too deeply to be OParl JSON.`);
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new OparlParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return value as T;
  }

  /**
   * Undo the `Content-Encoding` of a response. This client sends no `Accept-Encoding`,
   * which per RFC 9110 §12.5.3 means "any content coding is acceptable", so a server
   * compressing anyway is within its rights — and a gzipped body reported only as
   * unparseable JSON left the user with nothing to go on. Decoded with node:zlib, so
   * no dependency is added.
   *
   * `maxResponseBytes` caps the decompressed size too; the transport can only see the
   * bytes on the wire, which a compression bomb makes small on purpose.
   */
  private decompress(url: string, body: Buffer, headers: ResponseHeaders): Buffer {
    const raw = headers["content-encoding"];
    const value = (Array.isArray(raw) ? raw.join(",") : raw ?? "").trim().toLowerCase();
    if (value === "" || value === "identity") return body;
    let out = body;
    // Codings are listed in the order they were applied, so undo them right to left.
    for (const coding of value.split(",").map((part) => part.trim()).reverse()) {
      if (coding === "" || coding === "identity") continue;
      out = this.inflate(url, out, coding);
    }
    return out;
  }

  private inflate(url: string, body: Buffer, coding: string): Buffer {
    const limit = this.maxResponseBytes > 0 ? { maxOutputLength: this.maxResponseBytes } : {};
    try {
      if (coding === "gzip" || coding === "x-gzip") return zlib.gunzipSync(body, limit);
      if (coding === "br") return zlib.brotliDecompressSync(body, limit);
      if (coding === "deflate") {
        // Some servers send a raw deflate stream without the zlib wrapper RFC 9110 asks for.
        try {
          return zlib.inflateSync(body, limit);
        } catch {
          return zlib.inflateRawSync(body, limit);
        }
      }
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new OparlNetworkError(
          `GET ${cutForMessage(url)} failed: the ${coding} answer exceeded maxResponseBytes (${this.maxResponseBytes}) when decompressed`,
        );
      }
      throw new OparlParseError(`GET ${cutForMessage(url)}: the ${coding}-compressed answer could not be decompressed.`, { cause });
    }
    throw new OparlParseError(
      `GET ${cutForMessage(url)}: the answer uses the content encoding "${sanitizeServerText(coding, 40)}", which this client ` +
        "cannot decode (gzip, deflate and br are supported).",
    );
  }

  /**
   * `text` without the secret parts of the credential headers in `defaultHeaders`: server
   * text (an error body that echoes the request) and transport text can carry them. Used for
   * every message the client builds from such text.
   */
  redact(text: string): string {
    return this.#secrets.length === 0 ? text : redactSecrets(text, this.#secrets);
  }

  /**
   * An error body, already scrubbed as sent, as `OparlApiError.body` keeps it: when it is JSON
   * with an escape in it, checked decoded too. An escape (`\"`, `\u00e4`) hides an echoed
   * credential from the scrub of the text as sent, while a caller who parses the body sees it.
   * Such a body is kept as the decoded JSON written again (`JSON.stringify`, one spelling per
   * character) with the credential scrubbed in that spelling. A body that doesn't parse is text
   * nobody decodes, and stays as sent; one too deeply nested to write again is left out.
   */
  private scrubBody(scrubbed: string): string {
    if (this.#secrets.length === 0 || !scrubbed.includes("\\")) return scrubbed;
    let decoded: unknown;
    try {
      decoded = JSON.parse(scrubbed);
    } catch {
      return scrubbed;
    }
    let rewritten: string;
    try {
      rewritten = JSON.stringify(decoded);
    } catch {
      return "";
    }
    const spelled = this.#secrets.map((form) => JSON.stringify(form).slice(1, -1));
    return spelled.some((form) => rewritten.includes(form)) ? redactSecrets(rewritten, spelled) : scrubbed;
  }

  /**
   * An error as the `cause` of the error the engine raises: the original when its text
   * carries no secret, otherwise a copy with them scrubbed (message, `code` and the cause
   * chain kept), so logging the error with its causes can't reveal a credential header.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#secrets.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.redact(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.redact(cause.message);
    const stack = cause.stack ?? "";
    if (message === cause.message && inner === cause.cause && this.redact(stack) === stack) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What a transport threw, as the error the engine raises: an OparlNetworkError naming the
   * request, `GET <url> failed: <reason>`, with the original (scrubbed) as `cause`. The
   * built-in transport's own errors (a timeout, the size cap, a refused connection, a failed
   * DNS lookup, a reset) and the engine's deadline say only what went wrong, not which of a
   * walk's pages it was; an injected transport may throw anything (a string, fetch's
   * TypeError, an AbortError). A caller (and the CLI) can rely on every failure being an
   * OparlError. A network error that already names the request, and any other OparlError,
   * pass through.
   */
  private toNetworkError(url: string, cause: unknown): OparlError {
    if (cause instanceof OparlError && !(cause instanceof OparlNetworkError)) return cause;
    if (cause instanceof OparlNetworkError && cause.message.startsWith("GET ")) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new OparlNetworkError(`GET ${cutForMessage(url)} failed: ${sanitizeServerText(this.redact(reason))}`, {
      cause: this.scrubCause(cause),
    });
  }

  private toApiError(
    url: string,
    status: number,
    body: Buffer,
    headers: ResponseHeaders,
    location?: string,
    redirectsFollowed?: number,
    credentialsDropped?: { from: string; to: string },
  ): OparlApiError {
    let decoded = body;
    try {
      decoded = this.decompress(url, body, headers);
    } catch {
      // A body this client cannot decompress is still an error body; report the status
      // rather than replacing it with a decoding complaint.
      decoded = body;
    }
    // A server that echoes the request (its headers included) must not put a credential
    // into `body`, `detail` or the message.
    let raw = "";
    try {
      raw = decodeText(decoded, headers, `GET ${cutForMessage(url)}`).text;
    } catch {
      // An unknown charset label: still report the status. A body too large to be a string
      // (maxResponseBytes lifted) is left out: the status is the error.
      try {
        raw = decoded.toString("utf8");
      } catch (err) {
        if (!isStringTooLong(err)) throw err;
      }
    }
    const text = this.redact(raw);
    let detail: string | undefined;
    try {
      // SD.NET answers { error, code }, others { message } / { detail }.
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["error", "message", "detail", "title"]) {
        if (parsed && typeof parsed[key] === "string") {
          detail = parsed[key] as string;
          break;
        }
      }
    } catch {
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) detail = snippet;
    }
    if (detail !== undefined) {
      // The detail came from the body decoded: scrubbed again (a JSON escape hid the credential
      // from the scrub above), then sanitizeServerText collapses the whitespace and caps the length.
      detail = sanitizeServerText(this.redact(detail));
      if (detail === "") detail = undefined;
    }
    const target = status >= 300 && status < 400 && location !== undefined ? redirectTarget(url, location) : undefined;
    return new OparlApiError({
      status,
      url,
      method: "GET",
      body: this.scrubBody(text),
      ...(detail ? { detail } : {}),
      ...(target !== undefined ? { location: target } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(credentialsDropped !== undefined ? { credentialsDropped } : {}),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names none).
 * JSON is UTF-8 by RFC 8259, but a server that declares `charset=ISO-8859-1` and sends
 * Latin-1 bytes had every umlaut turned into U+FFFD, silently. TextDecoder also drops a
 * leading byte order mark, which JSON.parse would reject. An unknown charset label is an
 * OparlParseError naming `request` (`GET <url>`). Bytes that are not valid in the charset
 * become U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte charsets;
 * for UTF-16 a U+FFFD the server sent counts too.
 */
function decodeText(body: Buffer, headers: ResponseHeaders, request: string): { text: string; replaced: number } {
  const raw = headers["content-type"];
  const type = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new OparlParseError(`${request}: unsupported response charset "${sanitizeServerText(charset, 40)}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** V8's longest string (2^29 − 24 characters on 64-bit). */
const MAX_STRING_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * True for V8's error for a string past its longest one (2^29 − 24 characters on 64-bit): a body
 * of 512 MB and more, possible once `maxResponseBytes` is lifted, can't be decoded into one.
 */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode: it used to escape as a plain Error ("Unexpected error"). */
function tooLargeForText(request: string, body: Buffer): OparlParseError {
  return new OparlParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest string is ${MAX_STRING_LENGTH} characters).`,
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  const out = new TextBuilder();
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out.push(json.slice(copied, i), "\\ufffd");
    copied = i + 6;
    replaced++;
    i += 5;
  }
  if (replaced === 0) return { json, replaced };
  out.push(json.slice(copied));
  return { json: out.toString(), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo removed, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let shown = location;
  try {
    const resolved = new URL(location, requestUrl);
    resolved.username = "";
    resolved.password = "";
    shown = resolved.href;
  } catch {
    // shown as it came, sanitised below
  }
  const clean = sanitizeServerText(shown);
  return clean === "" ? undefined : clean;
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  // The zeros are counted with index loops: `/0+$/` tried a match at every zero of a run that
  // doesn't end the text, quadratic in the run, and one `1.<64 000 zeros>1e300` in an answer held
  // the CLI for seconds, past --timeout (the scan runs once the answer is in).
  const all = whole + fraction;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 0x30) start++;
  let end = all.length;
  while (end > start && all.charCodeAt(end - 1) === 0x30) end--;
  return { negative: sign === "-", digits: all.slice(start, end), exponent: Number(exp) - fraction.length + (all.length - end) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
export interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"size":
 *   12345678901234567890` becomes `"size":"12345678901234567890"`), so JSON.parse delivers it
 *   exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted, so
 *   a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: TextBuilder | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out ??= new TextBuilder();
      out.push(json.slice(copied, at), '"', literal, '"');
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  if (out === undefined) return { json, inexact };
  out.push(json.slice(copied));
  return { json: out.toString(), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
