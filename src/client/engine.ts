// The request engine: turns absolute OParl URLs into HTTP GET requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), follows
// redirects on the same host only, and decodes JSON responses.
//
// OParl has no single API host — every municipality runs its own server — so the
// engine works on absolute URLs instead of a base URL plus paths. URLs come from the
// user (a System URL) and from the servers themselves (list and pagination links),
// which is why redirects and links are kept on the host they came from (see
// resolveLink).

import zlib from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { OparlApiError, OparlLinkError, OparlNetworkError, OparlParseError, OparlValidationError } from "./errors.js";

const DEFAULT_USER_AGENT = "oparl-cli";

export interface EngineOptions {
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables). Defaults to 120 s: some
   * council systems take well over 30 s to render a single list page.
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Redirects followed per request (same host only). Defaults to 3; 0 disables. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
/** Longest wait honoured from a Retry-After header, so a hostile 429 can't stall us. */
const MAX_RETRY_AFTER_MS = 30_000;
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
 * Check a header this client is about to send. Node throws an opaque, synchronous
 * `ERR_INVALID_CHAR` / `ERR_INVALID_HTTP_TOKEN` from inside `request()` for a value
 * outside `\t`, 0x20–0x7e and obs-text (0x80–0xff) or a name that is not a token —
 * a `--user-agent` holding an emoji or an en dash surfaced as "Unexpected error".
 * Rejecting it here makes it an OparlValidationError, which the CLI reports as the
 * usage error it is (exit 2) and library callers can catch. Latin-1 is left through:
 * the grammar deprecates it but Node sends it and servers read it.
 */
function checkHeader(name: string, value: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new OparlValidationError(`"${sanitizeServerText(name, 40)}" is not a valid HTTP header name.`);
  }
  for (const ch of value) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x09) continue;
    if (n <= 0x1f || n === 0x7f) {
      throw new OparlValidationError(`The ${name} header value contains control characters.`);
    }
    if (n > 0xff) {
      throw new OparlValidationError(
        `The ${name} header value contains U+${n.toString(16).toUpperCase().padStart(4, "0")}, which cannot be sent ` +
          "in an HTTP header: header values are limited to ASCII and Latin-1 characters.",
      );
    }
  }
}

/**
 * Parse a user-supplied URL, accepting only http: and https:. Any `user:password@`
 * part is removed: OParl access is anonymous, and credentials in a URL would
 * otherwise be sent as Basic auth to whatever server the URL names and be echoed in
 * error messages.
 */
export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OparlValidationError("Not a valid URL.");
  }
  url.username = "";
  url.password = "";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OparlValidationError(`Only http: and https: URLs are supported: ${url.href}`);
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
function contentType(headers: IncomingHttpHeaders): string {
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

export class RequestEngine {
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    checkHeader("User-Agent", this.userAgent);
    for (const [name, value] of Object.entries(this.defaultHeaders)) checkHeader(name, value);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
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
   */
  async fetchJson<T = unknown>(url: string, query?: QueryParams): Promise<JsonResponse<T>> {
    const requested = encodeTimestampPlus(carryQuery(parseHttpUrl(url).href, query));
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };

    let current = requested;
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      const response = await this.transport({
        method: "GET",
        url: current,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });
      const status = response.status;

      if ((status === 429 || status === 503) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelay(response.headers["retry-after"], attempt));
        continue;
      }

      if (status >= 300 && status < 400) {
        const location = response.headers["location"];
        if (typeof location === "string" && location !== "" && redirects < this.maxRedirects) {
          redirects += 1;
          current = encodeTimestampPlus(carryQuery(resolveLink(current, location), query));
          continue;
        }
        throw this.toApiError(current, status, response.body, response.headers);
      }

      if (status < 200 || status >= 300) {
        throw this.toApiError(current, status, response.body, response.headers);
      }

      const value = upgradeSameHostUrls(this.decode<T>(current, response.body, response.headers), current);
      return { value, url: current };
    }
  }

  private retryDelay(retryAfter: string | string[] | undefined, attempt: number): number {
    const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    if (value !== undefined && /^[0-9]+$/.test(value.trim())) {
      return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
    }
    return this.retryDelayMs * attempt;
  }

  private decode<T>(url: string, rawBody: Buffer, headers: IncomingHttpHeaders): T {
    const body = this.decompress(url, rawBody, headers);
    const text = body.toString("utf8").replace(/^﻿/, "");
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
        { cause },
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
  private decompress(url: string, body: Buffer, headers: IncomingHttpHeaders): Buffer {
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

  private toApiError(url: string, status: number, body: Buffer, headers: IncomingHttpHeaders): OparlApiError {
    let decoded = body;
    try {
      decoded = this.decompress(url, body, headers);
    } catch {
      // A body this client cannot decompress is still an error body; report the status
      // rather than replacing it with a decoding complaint.
      decoded = body;
    }
    const text = decoded.toString("utf8");
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
    if (status >= 300 && status < 400) {
      detail = detail ?? "redirect not followed";
    }
    return new OparlApiError({ status, url, method: "GET", body: text, ...(detail ? { detail } : {}) });
  }
}
