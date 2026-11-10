// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

import type { JsonObject, ListResult } from "./types.js";

/** A value that starts with a URL scheme (`https://`, `ftp://`, …). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * A URL without the credentials it carries: a parsed URL loses its userinfo, and a value
 * that doesn't parse — or parses only with a fake scheme, as `user:pw@host` does (scheme
 * `user:`) — has the exact userinfo replaced by `***`. The value is a URL by definition
 * here, so one typed without its scheme is read as if it had one (`credentialsIn` alone
 * takes a bare `a:b@c` for no credential). OParl access is anonymous: the client drops
 * every `user:password@` before it sends a request, and this keeps it out of messages too.
 */
export function redactUrl(url: string): string {
  // A value with a special scheme but not "//" (`http:///u:pw@h`, `https:\\u:pw@h`) has one:
  // credentialsIn reads its userinfo as WHATWG does, where a prefixed `http://` would end the
  // authority at "http:".
  const found = (): string[] => (SCHEME.test(url) || credentialsIn(url).length > 0 ? credentialsIn(url) : credentialsIn(`http://${url}`));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactCredentials(url, found());
  }
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, found());
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme counts (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with
 * any slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`): a bare `a:b@c` is a file name (`-o run:2026-10-09@x.json`), a search
 * text or a User-Agent as often as a credential, and every URL oparl takes has a scheme
 * (`parseHttpUrl` requires `http:`/`https:`). It works on URLs that don't parse too: the
 * userinfo is everything between the scheme's slashes and the last `@` before the host. Used
 * to redact those exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains — a pattern can't delimit one holding a space, `/`, `#`,
 * `?` or `@`.
 */
export function credentialsIn(value: string): string[] {
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? SCHEME.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` has the userinfo `u:pw` and the host
  // a.example); in one that doesn't, at the last "@" of the value.
  const end = special !== null ? /[/?#\\]|$/ : /[/?#]|$/;
  const authority = parses ? rest.slice(0, rest.search(end)) : rest;
  const at = authority.lastIndexOf("@");
  return at > 0 ? [rest.slice(0, at)] : [];
}

/** A scheme character (RFC 3986: letters, digits, `+`, `.`, `-`). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches (the CLI's
 * stderr). Text-based, so it also covers a URL that does not parse; the userinfo ends at the
 * last `@` before the first whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`,
 * however many URLs it holds: each `://` is found with `indexOf`, its scheme by walking back no
 * further than the previous `://`, and the search goes on right after each `://`, not after the
 * authority it read: a URL glued onto the one before it (`https://host://u:p@h`,
 * `https://u:p@x://v:q@w`) starts inside that authority, which ends at its `/`. An authority
 * holds no `/`, so no `://` lies wholly inside one, and every character is read a bounded number
 * of times: by the authority loop and `indexOf` forwards, by `schemeStart` backwards. The regex
 * it replaces (a scheme tried at every word start) was quadratic on a run of scheme characters.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a server answer and their replacements),
 * joined in batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text,
 * not to the number of pieces. One `+=` per piece made a rope node each, and one array of every
 * piece a slot each: millions of lone-surrogate repairs in a large answer exhausted a small heap
 * either way.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
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

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest piece of a server answer or of the user's input (in characters) an own
 * message quotes: an error detail, an object `type`, a link, a redirect target, a URL or
 * a key. A longer one is cut (`cutText`) and ends in "…", so a library caller's
 * `err.message` stays bounded too.
 */
export const MAX_SERVER_TEXT_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_SERVER_TEXT_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_SERVER_TEXT_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it, or a reader can't see: DEL, the C1 controls,
 * every Unicode format character (bidi overrides, zero-width characters, a soft hyphen) and
 * the line and paragraph separators U+2028/U+2029. A refused value with a zero-width space in
 * it read exactly like a valid one; an override in it would reorder the rest of the line
 * ("Trojan Source"). A lone surrogate comes out as its escape (`JSON.stringify` writes it so).
 * A value longer than `max` characters (MAX_SERVER_TEXT_LENGTH, 200) is cut, and the "…" goes
 * after the closing quote (`"AAAA"…`), so it does not read as part of the value. The quoted
 * part stays a valid JSON string.
 */
export function quoteValue(value: string, max = MAX_SERVER_TEXT_LENGTH): string {
  const cut = value.length > max;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, max) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
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
  /**
   * The answer's body as text, the credential headers' secrets scrubbed. As sent, unless it is
   * JSON whose decoded text still holds one behind an escape (`\u0041`, `\"`): then the decoded
   * JSON written again (other escapes, no insignificant whitespace) with it replaced by `***`, and
   * `""` for such a body nested too deeply to write again.
   */
  readonly body: string;
  readonly location: string | undefined;
  /**
   * Set when a redirect led to another origin (in OParl, only an http→https upgrade on
   * the same host), so the credential headers of `defaultHeaders` were not sent to the
   * server that answered. A 401/403 then says nothing about them; the message says what
   * happened.
   */
  readonly credentialsDropped: { from: string; to: string } | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Set when the redirect limit stopped the request: the redirects followed. */
    redirectsFollowed?: number;
    /** Set when a redirect to another origin dropped the credential headers. */
    credentialsDropped?: { from: string; to: string };
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
    const dropped = args.credentialsDropped;
    if (dropped !== undefined && (args.status === 401 || args.status === 403)) {
      parts.push(credentialsDroppedHint(dropped));
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    // The URL may be a link the server chose (a `next` link): quoted cut, kept whole in `url`.
    super(`HTTP ${args.status} for ${args.method} ${cutForMessage(args.url)}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.credentialsDropped = dropped;
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

/**
 * Why a 401/403 after a redirect to another origin is not about the credential headers:
 * they were never sent to the server that answered. In OParl the only such redirect the
 * client follows is an http→https upgrade on the same host.
 */
export function credentialsDroppedHint(dropped: { from: string; to: string }): string {
  let upgrade = false;
  try {
    const from = new URL(dropped.from);
    const to = new URL(dropped.to);
    upgrade = from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname;
  } catch {
    // fall through to the general text
  }
  return upgrade
    ? `the server redirected ${dropped.from} to ${dropped.to}, and credential headers are not sent across a ` +
        `change of scheme, so the request arrived without them: use an https URL (${dropped.to})`
    : `a redirect led from ${dropped.from} to ${dropped.to}, another origin, so the credential headers were ` +
        "not sent there";
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
