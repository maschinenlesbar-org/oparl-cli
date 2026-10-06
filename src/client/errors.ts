// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

import type { JsonObject, ListResult } from "./types.js";

/**
 * A URL-like value without the credentials it carries: a parsed URL loses its userinfo,
 * and a value that doesn't parse — or parses only with a fake scheme, as `user:pw@host`
 * does (scheme `user:`) — has the exact userinfo `credentialsIn` finds replaced by `***`.
 * OParl access is anonymous: the client drops every `user:password@` before it sends a
 * request, and this keeps it out of messages too.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactCredentials(url, credentialsIn(url));
  }
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--registry-url=https://u:p@h`): the
 * userinfo is everything between `://` and the last `@` before the host. A value without a
 * scheme counts when it reads `user:password@host`. Used to redact those exact strings
 * from text that echoes the value (usage errors, help), whatever characters the password
 * contains — a pattern can't delimit one holding a space, `/`, `#`, `?` or `@`.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--registry-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that
 * is followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?`, `/` or `@`.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/** Base class for every error originating from this client. */
export class OparlError extends Error {
  /**
   * Set when a list walk failed on page 2 or later: the walk up to that point — the
   * objects of the pages fetched before the failure, `next` set to the URL of the page
   * that failed, and a `note` saying so. The CLI prints it before the error.
   */
  partial?: ListResult<JsonObject>;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The server responded with a non-2xx HTTP status (or a redirect this client does
 * not follow). `detail` holds a short, sanitised snippet of the response body when
 * a useful textual one is present. For a 3xx that was not followed (not a followable
 * status, no Location, or past `maxRedirects`), `location` holds the redirect target
 * (absolute, sanitised, without userinfo) and the message names it; after the redirect
 * limit it also says how many redirects were followed, so a loop reads as one.
 */
export class OparlApiError extends OparlError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Set when the redirect limit stopped the request: the redirects followed. */
    redirectsFollowed?: number;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      const limit =
        args.redirectsFollowed !== undefined
          ? ` (stopped after ${args.redirectsFollowed} redirect${args.redirectsFollowed === 1 ? "" : "s"})`
          : "";
      parts.push(
        args.location ? `redirect to ${args.location} not followed${limit}` : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
  }

  /** True for HTTP statuses treated as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for an HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, size cap, ...). */
export class OparlNetworkError extends OparlError {}

/** A client-side validation error (e.g. a non-http URL) — no request made. */
export class OparlValidationError extends OparlError {}

/**
 * The response was not what OParl promises: not JSON, an HTML page, an empty body,
 * an OParl error object, or an object of the wrong type (e.g. no `data` array on a
 * list page).
 */
export class OparlParseError extends OparlError {}

/**
 * A link or redirect the server handed out points somewhere this client refuses to
 * follow — another host, or a downgrade from https to http. Links are only followed
 * on the server they came from.
 */
export class OparlLinkError extends OparlError {}
