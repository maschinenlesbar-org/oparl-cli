// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { OparlNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Timeout for the whole request, response body included, in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects on transport-level failures (connection
 * errors, timeouts, malformed URLs, headers Node refuses to send) and on a request
 * that ends without a response at all; it never resolves with nothing.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new OparlNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new OparlNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // The timeout covers the whole exchange — connecting, waiting and reading the body.
    // A socket idle timeout alone would let a server that trickles a byte now and then
    // hold the request open indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        { method: request.method, headers: request.headers },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              res.destroy();
              fail(new OparlNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (aborted) return;
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", (err) => {
            if (aborted) return;
            fail(new OparlNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      // Node validates the URL, the method and the headers synchronously and throws
      // (ERR_INVALID_CHAR, ERR_INVALID_HTTP_TOKEN, ERR_UNESCAPED_CHARACTERS). A throw
      // here would escape the promise and reach the caller as an internal fault.
      fail(new OparlNetworkError(err instanceof Error ? err.message : String(err), { cause: err }));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = request.timeoutMs;
      timer = setTimeout(() => {
        const err = new OparlNetworkError(`Request timed out after ${timeoutMs}ms`);
        fail(err);
        req.destroy(err);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }

    req.on("error", (err) => {
      fail(err instanceof OparlNetworkError ? err : new OparlNetworkError(err.message, { cause: err }));
    });

    // A server that answers with 101 Switching Protocols sends no response body, and
    // Node reports it as an `upgrade` rather than a response. Nothing is listening on
    // the new protocol here, so close the socket and report the failure.
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      fail(new OparlNetworkError(`The server answered with HTTP ${res.statusCode ?? 101} (protocol upgrade), not a response`));
    });

    // Last line of defence: the request ended without a response and without an error
    // (an unanswered upgrade, a socket the server closed after the headers). Without
    // this the promise stays pending for ever, and with no timeout to fire the CLI
    // exited 0 with no output — a caller could not tell success from silence.
    req.on("close", () => {
      fail(new OparlNetworkError(`The server at ${url.host} closed the connection without sending a response`));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
