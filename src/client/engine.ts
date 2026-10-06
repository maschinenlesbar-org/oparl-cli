// The request engine: turns absolute OParl URLs into HTTP GET requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), follows
// redirects on the same host only, and decodes JSON responses.
//
// OParl has no single API host — every municipality runs its own server — so the
// engine works on absolute URLs instead of a base URL plus paths. URLs come from the
// user (a System URL) and from the servers themselves (list and pagination links),
// which is why redirects and links are kept on the host they came from (see
// resolveLink).

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
  redactUrl,
} from "./errors.js";
import { assertValid, intRangeProblem } from "./validate.js";

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
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Extra headers sent on every request. The values of credential headers (Authorization,
   * Proxy-Authorization, X-API-Key, Cookie) are kept out of logged clients and errors, and
   * go only to the origin of the URL a request starts at (see fetchJson).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables). Defaults to 120 s: some
   * council systems take well over 30 s to render a single list page. A non-negative
   * integer, capped at MAX_TIMEOUT_MS. The engine enforces it for every transport.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient 429/503 responses and reset connections
   * (ECONNRESET, EPIPE, ECONNABORTED, UND_ERR_SOCKET): 0 to MAX_RETRIES. Timeouts are
   * not retried.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (default 500), 0 to MAX_RETRY_AFTER_MS
   * (30 000). Grows linearly per attempt for a 503 and a reset; a 429 waits at least 1 s,
   * doubling per attempt. A Retry-After header (seconds or an HTTP date) can lengthen a
   * wait, never shorten it; every wait is capped at 30 s.
   */
  retryDelayMs?: number;
  /**
   * Redirects (301/302/303/307/308) followed per request, same host only. Defaults to 3;
   * 0 disables; at most MAX_REDIRECTS. Any other 3xx, one without a Location, and one
   * past this limit surface as an OparlApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. A
   * non-negative integer.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
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
export const MAX_SERVER_TEXT_LENGTH = 200;

/**
 * Make a string that originates in an attacker-controlled response body safe to put
 * into an error message printed raw to stderr by run.ts — an error `detail` snippet,
 * an object `type`, a link, a `Content-Type`. Three things happen:
 *
 * - Control characters are dropped (all C0/C1 plus DEL). Without this, a hostile or
 *   spoofed server could drive ANSI/OSC escape sequences (display spoofing, terminal
 *   title changes) into the user's terminal.
 * - Every run of whitespace — newlines and Unicode line separators included — becomes
 *   a single space, so the result is one line and a server cannot forge a second
 *   `Error:` line of its own next to ours.
 * - The result is capped at `maxLength` characters, so a 3 KB "message" cannot bury
 *   the diagnostic the CLI printed.
 *
 * Every server-supplied string that reaches a message goes through here. The CLI's
 * JSON output is escaped separately (escapeControlChars in cli/shared.ts):
 * JSON.stringify alone leaves DEL and the C1 range raw.
 *
 * Written as a char-code filter so no raw control byte ever appears in this source.
 */
export function sanitizeServerText(text: string, maxLength: number = MAX_SERVER_TEXT_LENGTH): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Tab, LF, VT, FF and CR become spaces (collapsed below) so words stay apart;
    // every other control character is dropped.
    if (n === 0x09 || (n >= 0x0a && n <= 0x0d)) out += " ";
    else if (n <= 0x1f || (n >= 0x7f && n <= 0x9f)) continue;
    else out += ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
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
    throw new OparlValidationError(`"${sanitizeServerText(name, 40)}" is not a valid HTTP header name.`);
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
    throw new OparlValidationError(`Only http: and https: URLs are supported: ${shown}.${hint}`);
  }
  return url;
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
      `Refusing to follow ${sanitizeServerText(target.href)} from ${base.href}: it points to another host. ` +
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
      `Refusing to follow ${sanitizeServerText(target.href)} from ${base.href}: it points to another port.`,
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
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
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
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: ResponseHeaders = {};
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

function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (node === null || typeof node !== "object") continue;
    if (depth > max) max = depth;
    if (max > MAX_JSON_DEPTH) return max;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
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
 * `user:password` and the password.
 */
function credentialSecrets(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) continue;
    secrets.add(value.trim());
    const token = value.trim().replace(/^\S+\s+/, "");
    secrets.add(token);
    if (/^basic\s/i.test(value.trim())) {
      const pair = Buffer.from(token, "base64").toString("latin1");
      secrets.add(pair);
      if (pair.includes(":")) secrets.add(pair.slice(pair.indexOf(":") + 1));
    }
  }
  // The longest first, so a value is replaced before a part of it.
  return [...secrets].filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
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
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.toNetworkError(current, cause);
      }

      // An injected transport may resolve with anything; a malformed response would
      // otherwise surface below as a raw TypeError, or — without a status — as a success.
      const invalid = responseProblem(raw);
      if (invalid !== undefined) {
        throw new OparlNetworkError(`GET ${current} failed: the transport returned an invalid response (${invalid}).`);
      }
      const response = raw as HttpResponse;
      // A transport that followed a redirect itself (fetch's default) took the request to a
      // server the engine never checked — credential headers and all: fetch strips
      // Authorization across origins, but not X-API-Key or Cookie. Don't trust it.
      const reported = (response as { url?: unknown }).url;
      if (typeof reported === "string" && reported !== "" && originOf(reported) !== originOf(current)) {
        throw new OparlNetworkError(
          `GET ${current} failed: the transport followed a redirect to ${originOf(reported) ?? "an unparseable URL"}, ` +
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
        throw new OparlNetworkError(`GET ${current} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }

      if ((status === 429 || status === 503) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelay(status, responseHeaders["retry-after"], attempt));
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
    const body = this.decompress(url, rawBody, headers);
    const text = decodeText(body, headers, url);
    if (text.trim().length === 0) {
      throw new OparlParseError(`Empty response from ${url} (expected OParl JSON).`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      // Only now that it is certain the body is not JSON: a server may serve perfectly
      // good OParl JSON as text/html, and that is accepted.
      const type = contentType(headers);
      const what = nonJsonBody(body, text, type);
      const typePart = type === "" ? "" : ` (content-type: ${type})`;
      throw new OparlParseError(
        what === null
          ? `Failed to parse JSON response from ${url}${typePart}`
          : `Expected OParl JSON from ${url} but received ${what}${typePart}` +
            (what === "a PDF file"
              ? " — this CLI prints file metadata, it does not download files."
              : " — is this an OParl URL?"),
        // V8's SyntaxError quotes the body, which may echo the request's headers.
        { cause: this.scrubCause(cause) },
      );
    }
    if (jsonDepth(value) > MAX_JSON_DEPTH) {
      throw new OparlParseError(`The response from ${url} is nested too deeply to be OParl JSON.`);
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
          `The ${coding} response from ${url} exceeded maxResponseBytes (${this.maxResponseBytes}) when decompressed`,
        );
      }
      throw new OparlParseError(`The ${coding}-compressed response from ${url} could not be decompressed.`, { cause });
    }
    throw new OparlParseError(
      `The response from ${url} uses the content encoding "${sanitizeServerText(coding, 40)}", which this client ` +
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
   * What a transport threw, as the error the engine raises. The built-in transport rejects
   * with OparlNetworkError only, and that passes through; an injected one may throw
   * anything (a string, fetch's TypeError, an AbortError), which is wrapped into an
   * OparlNetworkError naming the request, with the original (scrubbed) as `cause` — a
   * caller (and the CLI) can rely on every failure being an OparlError. Any other
   * OparlError passes through.
   */
  private toNetworkError(url: string, cause: unknown): OparlError {
    if (cause instanceof OparlError) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new OparlNetworkError(`GET ${url} failed: ${sanitizeServerText(this.redact(reason))}`, {
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
    let raw: string;
    try {
      raw = decodeText(decoded, headers, url);
    } catch {
      raw = decoded.toString("utf8"); // an unknown charset label: still report the status
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
      // sanitizeServerText collapses the whitespace and caps the length.
      detail = sanitizeServerText(detail);
      if (detail === "") detail = undefined;
    }
    const target = status >= 300 && status < 400 && location !== undefined ? redirectTarget(url, location) : undefined;
    return new OparlApiError({
      status,
      url,
      method: "GET",
      body: text,
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
 * OparlParseError.
 */
function decodeText(body: Buffer, headers: ResponseHeaders, url: string): string {
  const raw = headers["content-type"];
  const type = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new OparlParseError(`The response from ${url} declares the charset "${sanitizeServerText(charset, 40)}", which this client cannot decode.`);
  }
  return decoder.decode(body);
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
