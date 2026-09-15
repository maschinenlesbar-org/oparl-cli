// The request engine: turns absolute OParl URLs into HTTP GET requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), follows
// redirects on the same host only, and decodes JSON responses.
//
// OParl has no single API host — every municipality runs its own server — so the
// engine works on absolute URLs instead of a base URL plus paths. URLs come from the
// user (a System URL) and from the servers themselves (list and pagination links),
// which is why redirects and links are kept on the host they came from (see
// resolveLink).

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { OparlApiError, OparlLinkError, OparlParseError, OparlValidationError } from "./errors.js";

const DEFAULT_USER_AGENT = "oparl-cli";

export interface EngineOptions {
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Per-request timeout in milliseconds (0 disables). Defaults to 120 s: some
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

/**
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response body — the error
 * `detail` snippet that ends up in an OparlApiError.message printed raw to stderr by
 * run.ts. Without this, a hostile or spoofed server could drive ANSI/OSC escape
 * sequences (display spoofing, terminal title changes) into the user's terminal.
 * The success path is already safe (JSON.stringify escapes these).
 *
 * Written as a char-code filter so no raw control byte ever appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
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

/** Append query parameters to a URL, keeping any it already carries. */
export function withQuery(url: string, query?: QueryParams): string {
  if (!query) return url;
  const qs = buildQueryString(query);
  if (!qs) return url;
  const parsed = new URL(url);
  for (const [key, value] of new URLSearchParams(qs)) parsed.searchParams.append(key, value);
  return parsed.href;
}

/**
 * Set the client's query parameters on a server-supplied `next` link, replacing any
 * copy the server put there. Servers build these links themselves and get it wrong:
 * Somacos servers echo `modified_since=…+00:00` unencoded, so the `+` arrives as a
 * space and every page after the first is silently unfiltered; others drop the
 * parameters altogether. Setting them again keeps every page filtered alike.
 */
export function carryQuery(url: string, query?: QueryParams): string {
  if (!query) return url;
  const wanted = new URLSearchParams(buildQueryString(query));
  if ([...wanted.keys()].length === 0) return url;
  const parsed = new URL(url);
  for (const key of new Set(wanted.keys())) {
    parsed.searchParams.delete(key);
    for (const value of wanted.getAll(key)) parsed.searchParams.append(key, value);
  }
  return parsed.href;
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
    const requested = withQuery(parseHttpUrl(url).href, query);
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
          current = resolveLink(current, location);
          continue;
        }
        throw this.toApiError(current, status, response.body);
      }

      if (status < 200 || status >= 300) {
        throw this.toApiError(current, status, response.body);
      }

      return this.decode<T>(current, response.body);
    }
  }

  private retryDelay(retryAfter: string | string[] | undefined, attempt: number): number {
    const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    if (value !== undefined && /^[0-9]+$/.test(value.trim())) {
      return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
    }
    return this.retryDelayMs * attempt;
  }

  private decode<T>(url: string, body: Buffer): T {
    const text = body.toString("utf8").replace(/^﻿/, "");
    if (text.trim().length === 0) {
      throw new OparlParseError(`Empty response from ${url} (expected OParl JSON).`);
    }
    const head = text.trimStart().slice(0, 100).toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      throw new OparlParseError(
        `Expected OParl JSON from ${url} but received an HTML page — is this an OParl URL?`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new OparlParseError(`Failed to parse JSON response from ${url}`, { cause });
    }
    if (jsonDepth(value) > MAX_JSON_DEPTH) {
      throw new OparlParseError(`The response from ${url} is nested too deeply to be OParl JSON.`);
    }
    return value as T;
  }

  private toApiError(url: string, status: number, body: Buffer): OparlApiError {
    const text = body.toString("utf8");
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
      detail = sanitizeServerText(detail.replace(/\s+/g, " ").trim());
      if (detail.length > 200) detail = `${detail.slice(0, 200)}…`;
      if (detail === "") detail = undefined;
    }
    if (status >= 300 && status < 400) {
      detail = detail ?? "redirect not followed";
    }
    return new OparlApiError({ status, url, method: "GET", body: text, ...(detail ? { detail } : {}) });
  }
}
