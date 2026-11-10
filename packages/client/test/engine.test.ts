import { test } from "node:test";
import { TextDecoder, inspect } from "node:util";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  MAX_REDIRECTS,
  MAX_RETRIES,
  RequestEngine,
  assertHeaderValue,
  bigIntegerKeysOption,
  carryQuery,
  cleartextProblem,
  encodeTimestampPlus,
  firstInexactNumber,
  headerValueProblem,
  userAgentProblem,
  parseHttpUrl,
  resolveLink,
  sanitizeServerText,
  scanNumbers,
  withQuery,
  type EngineOptions,
} from "../src/engine.js";
import {
  OparlApiError,
  OparlLinkError,
  OparlNetworkError,
  OparlParseError,
  OparlValidationError,
  TextBuilder,
  credentialsIn,
  cutText,
  redactUrl,
  redactUrlUserinfo,
  toWellFormed,
} from "../src/errors.js";
import { OparlClient, normalizeTimestamp } from "../src/client.js";
import { nodeHttpTransport } from "../src/http.js";
import { hasControlChar, hostileText, jsonResponse, makeMockTransport, queryOf, rawResponse, redirect } from "./helpers.js";

const URL_1 = "https://ris.example.de/oparl/system";

test("getJson decodes JSON and sends Accept and User-Agent", async () => {
  const mt = makeMockTransport(() => jsonResponse({ id: URL_1 }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson(URL_1), { id: URL_1 });
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["User-Agent"], "oparl-cli");
  assert.equal(mt.last().timeoutMs, 120_000);
});

test("getJson keeps the parameters the URL already has and replaces the ones it sets", async () => {
  const mt = makeMockTransport(() => jsonResponse({ data: [] }));
  const e = new RequestEngine({ transport: mt.transport });
  // limit=5 is the server's own; the caller's 50 replaces it instead of being appended
  // (which sent limit twice and let the server pick).
  await e.getJson(`${URL_1}?page=2&limit=5`, { modified_since: "2026-09-01T00:00:00+00:00", limit: 50 });
  const q = queryOf(mt.last());
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("modified_since"), "2026-09-01T00:00:00+00:00");
  assert.deepEqual(q.getAll("limit"), ["50"]);
});

test("credentials in a URL are never sent nor echoed in errors", async () => {
  const mt = makeMockTransport((req) =>
    req.url.endsWith("/old") ? redirect("https://admin:hunter2@ris.example.de/new", 302) : jsonResponse({ error: "nope" }, 404),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("https://user:s3cret@ris.example.de/old"),
    (err) => err instanceof OparlApiError && !/s3cret|hunter2|user:|admin:/.test(err.message),
  );
  assert.deepEqual(mt.calls.map((c) => c.url), ["https://ris.example.de/old", "https://ris.example.de/new"]);
  assert.ok(mt.calls.every((c) => c.headers?.["Authorization"] === undefined));
  assert.equal(resolveLink("https://u:p@a.de/x", "https://v:q@a.de/y"), "https://a.de/y");
});

test("a non-http URL is rejected before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("ftp://ris.example.de/x"), OparlValidationError);
  await assert.rejects(() => e.getJson("not a url"), OparlValidationError);
  assert.equal(mt.calls.length, 0);
});

test("a 503 is retried up to maxRetries, then surfaces as OparlApiError", async () => {
  const mt = makeMockTransport(() => rawResponse("busy", "text/plain", 503));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => e.getJson(URL_1), (err) => err instanceof OparlApiError && err.status === 503 && err.isRetryable);
  assert.equal(mt.calls.length, 3);
});

test("Retry-After (seconds) is honoured and capped at 30 s", async () => {
  const waits: number[] = [];
  let n = 0;
  const mt = makeMockTransport(() => {
    n += 1;
    if (n === 1) return rawResponse("", "text/plain", 429, { "retry-after": "2" });
    if (n === 2) return rawResponse("", "text/plain", 429, { "retry-after": "3600" });
    return jsonResponse({ ok: true });
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await e.getJson(URL_1), { ok: true });
  assert.deepEqual(waits, [2000, 30_000]);
});

test("a redirect on the same host is followed, including a relative Location", async () => {
  const mt = makeMockTransport((req) =>
    req.url === URL_1 ? redirect("/oparl/v2/system", 302) : jsonResponse({ id: req.url }),
  );
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson(URL_1), { id: "https://ris.example.de/oparl/v2/system" });
});

test("an http-to-https redirect on the same host is followed", async () => {
  const mt = makeMockTransport((req) =>
    req.url.startsWith("http:") ? redirect(req.url.replace("http:", "https:")) : jsonResponse({ ok: true }),
  );
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("http://ris.example.de/oparl"), { ok: true });
  assert.equal(mt.last().url, "https://ris.example.de/oparl");
});

test("a filtered request keeps its filters when a redirect drops the query", async () => {
  const mt = makeMockTransport((req) =>
    req.url.startsWith("https://ris.example.de/meetings?") ? redirect("/meetings/") : jsonResponse({ data: [] }),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await e.getJson("https://ris.example.de/meetings", { modified_since: "2026-09-01T00:00:00+00:00" });
  // The redirect target used to be requested without the filter, and the unfiltered
  // list came back presented as the filtered one.
  assert.equal(mt.last().url, "https://ris.example.de/meetings/?modified_since=2026-09-01T00%3A00%3A00%2B00%3A00");
});

test("fetchJson reports the URL a request ended on, so relative links resolve against it", async () => {
  const mt = makeMockTransport((req) => (req.url === URL_1 ? redirect("/oparl/v2/system", 302) : jsonResponse({ body: "bodies" })));
  const e = new RequestEngine({ transport: mt.transport });
  const response = await e.fetchJson<{ body: string }>(URL_1);
  assert.equal(response.url, "https://ris.example.de/oparl/v2/system");
  assert.equal(resolveLink(response.url, response.value.body), "https://ris.example.de/oparl/v2/bodies");
});

test("a redirect to another host is refused with OparlLinkError", async () => {
  const mt = makeMockTransport(() => redirect("https://evil.example.com/oparl"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson(URL_1), OparlLinkError);
  assert.equal(mt.calls.length, 1);
});

test("redirects stop after maxRedirects with a 3xx OparlApiError", async () => {
  let n = 0;
  const mt = makeMockTransport(() => redirect(`/hop/${(n += 1)}`));
  const e = new RequestEngine({ transport: mt.transport, maxRedirects: 2 });
  await assert.rejects(
    () => e.getJson(URL_1),
    (err) =>
      err instanceof OparlApiError &&
      err.status === 301 &&
      err.location === "https://ris.example.de/hop/3" &&
      err.message.endsWith(": redirect to https://ris.example.de/hop/3 not followed (stopped after 2 redirects)"),
  );
  assert.equal(mt.calls.length, 3);
});

test("only real redirects with a Location are followed, and the error names what happened", async () => {
  const cases: Array<[number, Record<string, string>, string]> = [
    [301, {}, ": redirect not followed (no Location header)"],
    [302, { location: "  " }, ": redirect not followed (no Location header)"],
    [304, {}, ": redirect not followed (no Location header)"],
    // 304 answers a conditional request this client never sends; 300 is a choice.
    [304, { location: "/system" }, ": redirect to https://ris.example.de/system not followed"],
    [300, { location: "/system" }, ": redirect to https://ris.example.de/system not followed"],
  ];
  for (const [status, headers, tail] of cases) {
    const mt = makeMockTransport(() => ({ status, headers, body: Buffer.alloc(0) }));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.getJson(URL_1),
      (err) => err instanceof OparlApiError && err.status === status && err.message === `HTTP ${status} for GET ${URL_1}${tail}`,
      `${status} ${JSON.stringify(headers)}`,
    );
    assert.equal(mt.calls.length, 1);
  }
});

test("a 404 carries the server's error text as detail", async () => {
  const mt = makeMockTransport(() => jsonResponse({ error: "Die angeforderte Ressource wurde nicht gefunden.", code: 802 }, 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson(URL_1),
    (err) => err instanceof OparlApiError && err.isNotFound && err.detail === "Die angeforderte Ressource wurde nicht gefunden.",
  );
});

test("non-JSON bodies surface as OparlParseError with a pointed message", async () => {
  const cases: Array<[string, RegExp]> = [
    ["<!DOCTYPE html><html><body>Portal</body></html>", /HTML page/],
    ["   ", /^GET https:\/\/ris\.example\.de\/oparl\/system: empty response body/],
    ["{not json", /^GET https:\/\/ris\.example\.de\/oparl\/system: the answer is not valid JSON/],
  ];
  for (const [body, message] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, "text/html"));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(() => e.getJson(URL_1), (err) => err instanceof OparlParseError && message.test(err.message));
  }
});

test("a non-JSON answer says what the server actually sent", async () => {
  // All of these were reported as "the answer is not valid JSON": Aachen's error page
  // starts with an HTML comment and Apache's with an XML declaration, so the prefix test
  // missed them, and a file URL answers with the file.
  const cases: Array<[string | Buffer, string, RegExp]> = [
    ["<!-- ERROR REFERENCE -->\n<!doctype html><html>oops</html>", "text/html; charset=utf-8", /an HTML page \(content-type: text\/html\)/],
    ['<?xml version="1.0"?>\n<html><body>Bad Gateway!</body></html>', "text/html", /an HTML page/],
    ['<?xml version="1.0"?><error>no</error>', "application/xml", /an XML document/],
    [Buffer.from("%PDF-1.4\ntrailer\n"), "application/pdf", /a PDF file .*does not download files/],
    ["Not found", "text/plain", /: the answer is not valid JSON \(content-type: text\/plain\)\.$/],
  ];
  for (const [body, type, message] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, type));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.getJson(URL_1),
      (err) => err instanceof OparlParseError && message.test(err.message),
      `${type}: ${message}`,
    );
  }
  // A server serving good OParl JSON under an HTML content type is still accepted.
  const html = makeMockTransport(() => rawResponse('{"id":"x"}', "text/html"));
  assert.deepEqual(await new RequestEngine({ transport: html.transport }).getJson(URL_1), { id: "x" });
});

test("a compressed response is decoded, whatever the coding", async () => {
  const served = { id: URL_1, name: "Ratsinformationssystem" };
  const body = Buffer.from(JSON.stringify(served), "utf8");
  const cases: Array<[string, Buffer]> = [
    ["gzip", zlib.gzipSync(body)],
    ["x-gzip", zlib.gzipSync(body)],
    ["deflate", zlib.deflateSync(body)],
    ["deflate", zlib.deflateRawSync(body)], // servers that skip the zlib wrapper
    ["br", zlib.brotliCompressSync(body)],
    ["identity", body],
    ["gzip, br", zlib.brotliCompressSync(zlib.gzipSync(body))],
  ];
  for (const [coding, compressed] of cases) {
    const mt = makeMockTransport(() => rawResponse(compressed, "application/json", 200, { "content-encoding": coding }));
    const e = new RequestEngine({ transport: mt.transport });
    assert.deepEqual(await e.getJson(URL_1), served, coding);
  }
});

test("an undecodable or oversized compressed response says so", async () => {
  const unknown = makeMockTransport(() => rawResponse("xx", "application/json", 200, { "content-encoding": "exotic" }));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson(URL_1),
    (err) => err instanceof OparlParseError && /content encoding "exotic"/.test(err.message),
  );

  const broken = makeMockTransport(() => rawResponse("not gzip at all", "application/json", 200, { "content-encoding": "gzip" }));
  await assert.rejects(
    () => new RequestEngine({ transport: broken.transport }).getJson(URL_1),
    (err) => err instanceof OparlParseError && /^GET \S+: the gzip-compressed answer could not be decompressed/.test(err.message),
  );

  // maxResponseBytes has to hold for the decompressed size too: the transport only ever
  // sees the bytes on the wire, which a compression bomb keeps small on purpose.
  const bomb = zlib.gzipSync(Buffer.alloc(200_000, 0x20));
  const big = makeMockTransport(() => rawResponse(bomb, "application/json", 200, { "content-encoding": "gzip" }));
  await assert.rejects(
    () => new RequestEngine({ transport: big.transport, maxResponseBytes: 1000 }).getJson(URL_1),
    (err) => err instanceof OparlNetworkError && /^GET \S+ failed: the gzip answer exceeded maxResponseBytes \(1000\)/.test(err.message),
  );
});

test("a compressed error body is decoded before its detail is taken", async () => {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ error: "Ressource nicht gefunden" }), "utf8"));
  const mt = makeMockTransport(() => rawResponse(body, "application/json", 404, { "content-encoding": "gzip" }));
  await assert.rejects(
    () => new RequestEngine({ transport: mt.transport }).getJson(URL_1),
    (err) => err instanceof OparlApiError && err.detail === "Ressource nicht gefunden",
  );
});

test("a header value Node would refuse is a validation error, not an internal fault", async () => {
  // A --user-agent with an emoji or an en dash used to reach Node's HTTP layer and die
  // as "Unexpected error" (exit 1) instead of a usage error.
  for (const userAgent of ["bot \u{1f680}", "oparl-cli/a–b", `bad${String.fromCharCode(0x0d)}${String.fromCharCode(0x0a)}X: y`]) {
    assert.throws(() => new RequestEngine({ userAgent }), OparlValidationError, userAgent);
  }
  assert.throws(() => new RequestEngine({ defaultHeaders: { "X Bad Name": "v" } }), OparlValidationError);
  // Latin-1 is deprecated in the grammar but Node sends it and servers read it.
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "oparl-cli/Köln" });
  assert.deepEqual(await e.getJson(URL_1), { ok: true });
  assert.equal(mt.last().headers?.["User-Agent"], "oparl-cli/Köln");
});

test("sanitizeServerText leaves one capped line, whatever the server sent", () => {
  const clean = sanitizeServerText(hostileText());
  assert.ok(!hasControlChar(clean), clean);
  assert.equal(clean.includes("\n"), false);
  assert.ok(clean.length <= 201, `${clean.length} characters`);
  assert.ok(clean.endsWith("…"));
  // Unicode line and paragraph separators count as whitespace, too.
  assert.equal(sanitizeServerText("a b  \tc"), "a b c");
  assert.equal(sanitizeServerText("", 10), "");
  assert.equal(sanitizeServerText("kurz und gut"), "kurz und gut");
});

test("a UTF-8 byte order mark is tolerated", async () => {
  const mt = makeMockTransport(() => rawResponse(`﻿{"id":"x"}`, "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson(URL_1), { id: "x" });
});

test("pathologically deep JSON is rejected as OparlParseError", async () => {
  const deep = "[".repeat(1000) + "]".repeat(1000);
  const mt = makeMockTransport(() => rawResponse(deep, "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson(URL_1), (err) => err instanceof OparlParseError && /nested too deeply/.test(err.message));
});

test("error detail is stripped of terminal control characters", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI = String.fromCharCode(0x9b);
  const mt = makeMockTransport(() => jsonResponse({ error: `boom${ESC}[31mred${BEL}${CSI}2J` }, 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson(URL_1),
    (err) => {
      assert.ok(err instanceof OparlApiError);
      const hasControl = (s: string): boolean =>
        [...s].some((c) => {
          const n = c.charCodeAt(0);
          return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
        });
      assert.ok(!hasControl(err.message));
      // Whole escape sequences go, not only their control bytes.
      assert.equal(err.detail, "boomred");
      return true;
    },
  );
});

test("resolveLink keeps links on the same host and upgrades http to https", () => {
  assert.equal(resolveLink("https://a.de/x", "/list?page=2"), "https://a.de/list?page=2");
  assert.equal(resolveLink("https://a.de/x", "http://a.de/y"), "https://a.de/y");
  assert.equal(resolveLink("http://a.de/x", "https://a.de/y"), "https://a.de/y");
  assert.equal(resolveLink("https://A.de/x", "https://a.DE/y"), "https://a.de/y");
  for (const [from, to] of [
    ["https://a.de/x", "https://b.de/y"],
    ["https://a.de/x", "https://a.de:8443/y"],
    ["http://a.de:8080/x", "https://a.de/y"],
    ["https://a.de/x", "javascript:alert(1)"],
    ["https://a.de/x", "file:///etc/passwd"],
  ] as const) {
    assert.throws(() => resolveLink(from, to), OparlLinkError, `${from} -> ${to}`);
  }
});

test("http:// URLs on the host of an https response are printed as https://", async () => {
  const served = {
    id: "http://ris.example.de/oparl/bodies/0001",
    meeting: "HTTP://RIS.EXAMPLE.DE:80/oparl/bodies/0001/meetings?page=2",
    legislativeTerm: [{ id: "http://ris.example.de/oparl/terms/1", body: "http://ris.example.de" }],
    website: "http://www.example.de/",
    other: "http://ris.example.de:8080/x",
    note: "see http://ris.example.de/oparl",
  };
  const e = new RequestEngine({ transport: makeMockTransport(() => jsonResponse(served)).transport });
  assert.deepEqual(await e.getJson("https://ris.example.de/oparl/bodies/0001"), {
    id: "https://ris.example.de/oparl/bodies/0001",
    meeting: "https://ris.example.de/oparl/bodies/0001/meetings?page=2",
    legislativeTerm: [{ id: "https://ris.example.de/oparl/terms/1", body: "https://ris.example.de" }],
    website: "http://www.example.de/", // another host
    other: "http://ris.example.de:8080/x", // another port
    note: "see http://ris.example.de/oparl", // not a URL value
  });

  // An authority that isn't a plain host[:port] is left alone: a backslash or a space
  // ends the authority for URL parsing but not for the scan, so rewriting such a string
  // used to drop everything after it.
  const odd = { a: "http://ris.example.de\\evil.example/x", b: "http://ris.example.de evil", c: "http://user@ris.example.de/x" };
  const oddEngine = new RequestEngine({ transport: makeMockTransport(() => jsonResponse(odd)).transport });
  assert.deepEqual(await oddEngine.getJson("https://ris.example.de/oparl"), odd);

  const overHttp = new RequestEngine({ transport: makeMockTransport(() => jsonResponse(served)).transport });
  assert.deepEqual(await overHttp.getJson("http://ris.example.de/oparl/bodies/0001"), served);
});

test("a __proto__ key in an https answer is an ordinary member, never the prototype of the object (bug 1)", async () => {
  // JSON.parse makes "__proto__" an own key; the https rewrite rebuilt every object with
  // `out[key] =`, where that key called the prototype setter: the key was dropped and its
  // value became the object's prototype (`o.evil === 1`), a nested `{"__proto__":[1,2]}` became `{}`.
  const raw =
    '{"id":"https://ris.example.de/oparl/file/1","type":"https://schema.oparl.org/1.1/File","__proto__":{"evil":1},' +
    '"constructor":"x","nested":{"__proto__":[1,2],"link":"http://ris.example.de/oparl/x"},"name":"p"}';
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(raw, "application/json")).transport });
  const value = await e.getJson<Record<string, unknown>>("https://ris.example.de/oparl/file/1");
  assert.deepEqual(Object.keys(value), ["id", "type", "__proto__", "constructor", "nested", "name"]);
  assert.equal((value as { evil?: unknown }).evil, undefined, "a member of __proto__ is read through the prototype");
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, "__proto__")?.value, { evil: 1 });
  const nested = value["nested"] as Record<string, unknown>;
  assert.deepEqual(Object.getOwnPropertyDescriptor(nested, "__proto__")?.value, [1, 2]);
  assert.equal(nested["link"], "https://ris.example.de/oparl/x", "the rewrite still applies");
  assert.equal(JSON.stringify(value), JSON.stringify(JSON.parse(raw.replace("http://ris", "https://ris"))));
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("Not found") }) });
  // With the prototype set, "text/html" was read as the Content-Type: "an HTML page (content-type: text/html)".
  await assert.rejects(e.getJson(URL_1), (err: Error) => err instanceof OparlParseError && !/html/i.test(err.message));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson(URL_1), { a: 1 });
});

test("withQuery leaves the URL alone when no parameter survives", () => {
  assert.equal(withQuery("https://a.de/x?page=1", { limit: undefined }), "https://a.de/x?page=1");
  assert.equal(withQuery("https://a.de/x", { omit_internal: true }), "https://a.de/x?omit_internal=true");
});

test("encodeTimestampPlus sends a literal + in the OParl timestamp parameters as %2B, and nothing else", () => {
  // Köln's raw links.next, as `oparl get` prints it: the + reached the server as a space.
  const somacos = "https://ris.example.de/papers?page=4&modified_since=2026-09-20T00:00:00+00:00&limit=5";
  assert.equal(encodeTimestampPlus(somacos), "https://ris.example.de/papers?page=4&modified_since=2026-09-20T00:00:00%2B00:00&limit=5");
  assert.equal(
    encodeTimestampPlus("https://a.de/x?created_since=2026-01-01T00:00:00+01:00&created_until=2026-02-01T00:00:00+01:00&modified_until=2026-03-01T00:00:00+01:00#f+g"),
    "https://a.de/x?created_since=2026-01-01T00:00:00%2B01:00&created_until=2026-02-01T00:00:00%2B01:00&modified_until=2026-03-01T00:00:00%2B01:00#f+g",
  );
  // Other parameters, already encoded values and URLs without a query are left as they are.
  for (const url of [
    "https://a.de/x?q=a+b&flag&modified_since=2026-09-20T00:00:00%2B00:00",
    "https://a.de/x?modified_since=2026-09-20T00:00:00Z",
    "https://a.de/x",
  ]) {
    assert.equal(encodeTimestampPlus(url), url);
  }
});

test("a URL with an unencoded + in a timestamp filter is requested with %2B", async () => {
  const requested: string[] = [];
  const engine = new RequestEngine({
    transport: async (req) => {
      requested.push(req.url);
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"data":[]}') };
    },
  });
  await engine.getJson("https://ris.example.de/papers?page=3&modified_since=2026-09-20T00:00:00+00:00&limit=5");
  assert.deepEqual(requested, ["https://ris.example.de/papers?page=3&modified_since=2026-09-20T00:00:00%2B00:00&limit=5"]);
});

test("carryQuery sets the client's parameters and leaves the server's byte for byte", () => {
  // The server's own `next`: a %20, a bare flag and a + that is not a space for every server.
  assert.equal(
    carryQuery("https://a.de/w?page=2&q=a%20b&flag&x=1+2", { limit: 5 }),
    "https://a.de/w?page=2&q=a%20b&flag&x=1+2&limit=5",
  );
  // A parameter the client sets replaces the server's copy, however the server spelled it.
  assert.equal(
    carryQuery("https://a.de/papers.asp?body=1&limit=100&modified_since=2026-01-01T00:00:00+00:00", {
      limit: 5,
      modified_since: "2026-09-01T00:00:00+00:00",
    }),
    "https://a.de/papers.asp?body=1&limit=5&modified_since=2026-09-01T00%3A00%3A00%2B00%3A00",
  );
  assert.equal(carryQuery("https://a.de/x?page=2", { limit: undefined }), "https://a.de/x?page=2");
  assert.equal(carryQuery("https://a.de/x", { omit_internal: true }), "https://a.de/x?omit_internal=true");
});

test("the constructor rejects a numeric option that is not a non-negative integer in range", () => {
  const bad: Array<[keyof EngineOptions, number]> = [];
  for (const option of ["timeoutMs", "maxRetries", "retryDelayMs", "maxRedirects", "maxResponseBytes"] as const) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) bad.push([option, value]);
  }
  bad.push(["maxRetries", MAX_RETRIES + 1], ["maxRedirects", MAX_REDIRECTS + 1]);
  for (const [option, value] of bad) {
    assert.throws(
      () => new RequestEngine({ [option]: value }),
      (err: unknown) => err instanceof OparlValidationError && err.message.startsWith(`Invalid ${option}: `),
      `${option} ${value}`,
    );
  }
  assert.equal(MAX_RETRIES, 10);
  assert.equal(MAX_REDIRECTS, 10);
  // In range: 0, the bounds, and a timeout beyond Node's timer range (the transport caps it).
  for (const options of [
    { timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxRedirects: 0, maxResponseBytes: 0 },
    { maxRetries: MAX_RETRIES, maxRedirects: MAX_REDIRECTS },
    { timeoutMs: 3_000_000_000 },
  ]) {
    assert.doesNotThrow(() => new RequestEngine(options));
  }
});

test("headerValueProblem and assertHeaderValue hold the header-value rule", () => {
  assert.equal(headerValueProblem("User-Agent", "oparl-cli/Köln\t(1)"), undefined);
  assert.equal(
    headerValueProblem("User-Agent", `a${String.fromCharCode(0x0d)}b`),
    "The User-Agent header value contains control characters.",
  );
  assert.equal(headerValueProblem("X-Test", String.fromCharCode(0x7f)), "The X-Test header value contains control characters.");
  assert.match(headerValueProblem("User-Agent", "€") ?? "", /^The User-Agent header value contains U\+20AC, which cannot be sent/);
  assert.equal(assertHeaderValue("User-Agent", "ok"), "ok");
  assert.throws(() => assertHeaderValue("User-Agent", "€"), OparlValidationError);
});

test("parseHttpUrl rejects a blank URL as such", () => {
  for (const blank of ["", "   "]) {
    assert.throws(() => parseHttpUrl(blank), (err: unknown) => err instanceof OparlValidationError && err.message === "Expected a non-empty URL.");
  }
  assert.throws(() => parseHttpUrl("not a url"), (err: unknown) => err instanceof OparlValidationError && err.message === "Not a valid URL.");
});

test("userAgentProblem rejects a blank value, then applies the header-value rule", () => {
  for (const blank of ["", "   ", "\t"]) assert.equal(userAgentProblem(blank), "Expected a non-empty value.", JSON.stringify(blank));
  assert.equal(userAgentProblem(" x "), undefined);
  assert.equal(userAgentProblem("oparl-cli/Köln\t(1)"), undefined);
  assert.equal(userAgentProblem(`a${String.fromCharCode(0x0a)}b`), "The User-Agent header value contains control characters.");
  assert.match(userAgentProblem("€") ?? "", /^The User-Agent header value contains U\+20AC/);
  // The engine enforces it: an explicit blank is an error, only undefined means the default.
  for (const userAgent of ["", "  "]) {
    assert.throws(
      () => new RequestEngine({ userAgent }),
      (err: unknown) => err instanceof OparlValidationError && err.message === "Invalid userAgent: Expected a non-empty value.",
    );
  }
  assert.doesNotThrow(() => new RequestEngine({ userAgent: undefined }));
});

test("a Location from a Headers object or in any case is followed (custom transports)", async () => {
  for (const headers of [new Headers({ Location: "/moved" }), { Location: "/moved" }, new Map([["location", "/moved"]])]) {
    const mt = makeMockTransport((req) =>
      req.url.endsWith("/moved")
        ? jsonResponse({ id: "x" })
        : { status: 302, headers: headers as unknown as Record<string, string>, body: Buffer.alloc(0) },
    );
    const engine = new RequestEngine({ transport: mt.transport });
    assert.deepEqual(await engine.getJson(URL_1), { id: "x" }, headers.constructor.name);
    assert.equal(mt.calls[1]?.url, "https://ris.example.de/moved");
  }
});

test("a transport response without a status, or with status 0, is a network error, not data", async () => {
  for (const status of [undefined, 0]) {
    const engine = new RequestEngine({
      transport: async () => ({ status, headers: {}, body: Buffer.from('{"id":"x"}') }) as never,
      maxRetries: 0,
    });
    await assert.rejects(engine.getJson(URL_1), OparlNetworkError, String(status));
  }
});

test("a Retry-After HTTP date is honoured, and retryDelayMs is bounded at 30 s", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const when = new Date(Date.now() + 20_000).toUTCString();
  const engine = new RequestEngine({
    transport: async () => (n++ === 0 ? rawResponse("", "text/plain", 503, { "retry-after": when }) : jsonResponse({ id: "x" })),
    sleep: async (ms) => void sleeps.push(ms),
  });
  await engine.getJson(URL_1);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! > 15_000 && sleeps[0]! <= 20_000, String(sleeps[0]));
  assert.throws(() => new RequestEngine({ retryDelayMs: 30_001 }), OparlValidationError);
  assert.doesNotThrow(() => new RequestEngine({ retryDelayMs: 30_000 }));
});

test("a body is decoded by its declared charset; an unknown one is a parse error", async () => {
  const latin1 = Buffer.from(JSON.stringify({ id: "x", name: "Bürgermeister" }), "latin1");
  const engine = (contentType: string, body: Buffer) =>
    new RequestEngine({ transport: async () => rawResponse(body, contentType) });
  assert.deepEqual(await engine("application/json; charset=ISO-8859-1", latin1).getJson(URL_1), { id: "x", name: "Bürgermeister" });
  assert.deepEqual(await engine('application/json; charset="utf-8"', Buffer.from('﻿{"id":"ü"}')).getJson(URL_1), { id: "ü" });
  await assert.rejects(engine("application/json; charset=x-no-such", latin1).getJson(URL_1), OparlParseError);
});

test("cleartextProblem: exact wording, host with port, loopback range, never the secret", () => {
  assert.equal(cleartextProblem("http://mirror.example:8080/api"), "requests to mirror.example:8080 are sent unencrypted (http:, not https:)");
  assert.equal(
    cleartextProblem("http://alice:pw@mirror.example"),
    "the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:pw@mirror.example", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(cleartextProblem("http://mirror.example", ["the login"]), "the login is sent unencrypted to mirror.example (http:, not https:)");
  for (const url of ["https://alice:pw@mirror.example", "http://127.8.9.10", "http://localhost:1", "http://[::1]/", "not a url"]) {
    assert.equal(cleartextProblem(url), undefined, url);
  }
  assert.notEqual(cleartextProblem("http://128.0.0.1"), undefined);
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("server text cut at 200 characters keeps the message well-formed (sanitizeServerText)", async () => {
  // At 199 "a"s the emoji's high half is unit 200: the cut must not keep it alone.
  for (const message of ["a".repeat(199) + "\u{1f600}", "\u{1f600}".repeat(150)]) {
    const clean = sanitizeServerText(message);
    assert.equal(toWellFormed(clean), clean, JSON.stringify(clean.slice(-4)));
    assert.match(clean, /…$/);
    const e = new RequestEngine({ transport: async () => jsonResponse({ message }, 500) });
    await assert.rejects(e.getJson(URL_1), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      return true;
    });
  }
});

test("own messages quote a user value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  assert.throws(() => parseHttpUrl(`ftp://ris.example/${long}`), (err: Error) => err.message.length < 400 && /ftp:\/\/ris\.example\/x+…\./.test(err.message));
  assert.throws(() => normalizeTimestamp(`2026-${long}`), (err: Error) => err.message.length < 400 && /^Invalid timestamp "2026-x+"…: /.test(err.message));
  const client = new OparlClient({ transport: async () => jsonResponse({}) });
  await assert.rejects(client.list(URL_1, "meeting", { [`k${long}`]: 1 } as never), (err: Error) => err.message.length < 400 && /Unknown list option "kx+"…/.test(err.message));
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2 ? rawResponse("{}", "application/json", 503, n === 1 ? { "retry-after": "2" } : {}) : jsonResponse({ id: URL_1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("https://user:pw@ris.example.de/oparl/system");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 1000"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://ris.example.de/oparl/system" },
    { retry: 2, maxRetries: 3, delayMs: 1000, status: 503, url: "https://ris.example.de/oparl/system" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ id: URL_1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson(URL_1);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
  assert.equal((events[0] as { delayMs: number }).delayMs, 500);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.getJson(URL_1);
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ error: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson(URL_1), OparlApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => rawResponse("{}", "application/json", 503)).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson(URL_1), OparlApiError);
  assert.equal(events.length, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const e = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? rawResponse("{}", "application/json", 503) : jsonResponse({}))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.getJson(URL_1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), OparlValidationError);
  assert.throws(() => new OparlClient({ onRetry: 5 as never }), OparlValidationError);
});

test("a number JSON.parse can't carry exactly is an OparlParseError, never a changed value", async () => {
  const inexact = [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: below 2.2250738585072014e-308 a double has fewer digits (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ];
  for (const literal of inexact) {
    const mt = makeMockTransport(() => rawResponse(`{"id":"${URL_1}","n":${literal},"s":"12345678901234567890"}`, "application/json"));
    await assert.rejects(
      () => new RequestEngine({ transport: mt.transport }).getJson(URL_1),
      (err) =>
        err instanceof OparlParseError &&
        err.message === `GET ${URL_1}: the number ${literal} cannot be represented exactly.`,
      literal,
    );
  }
});

test("a number a double carries is decoded as the same value, also in a string and past 2^53 in shortest form", async () => {
  const exact: Array<[string, number]> = [
    ["0", 0], ["-0", -0], ["42", 42], ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53],
    ["9007199254740992e0", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0.1", 0.1], ["1.10", 1.1],
    ["-2.5e-3", -0.0025], ["5e-324", 5e-324], ["0.0e-500", 0],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
  ];
  for (const [literal, value] of exact) {
    const mt = makeMockTransport(() => rawResponse(`{"s":"1e400 \\" 12345678901234567890","n":${literal}}`, "application/json"));
    const got = await new RequestEngine({ transport: mt.transport }).getJson<{ n: number; s: string }>(URL_1);
    assert.equal(got.n, value, literal);
    assert.equal(got.s, '1e400 " 12345678901234567890', literal);
  }
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request; the original is the cause", async () => {
  const page = "https://ris.example.de/oparl/papers?limit=5";
  // The engine's own deadline, with a transport that never answers.
  const hanging = makeMockTransport(() => new Promise<never>(() => {}));
  await assert.rejects(
    () => new RequestEngine({ transport: hanging.transport, timeoutMs: 5 }).getJson(page),
    (err) =>
      err instanceof OparlNetworkError &&
      err.message === `GET ${page} failed: Request timed out after 5ms` &&
      err.cause instanceof OparlNetworkError &&
      err.cause.message === "Request timed out after 5ms",
  );
  // What the default transport raises for the size cap and a failed lookup.
  const lookup = Object.assign(new Error("getaddrinfo ENOTFOUND ris.example.de"), { code: "ENOTFOUND" });
  for (const raised of [
    new OparlNetworkError("Response exceeded the size limit of 10 bytes (maxResponseBytes; --max-response-bytes on the CLI)"),
    new OparlNetworkError(lookup.message, { cause: lookup }),
  ]) {
    const mt = makeMockTransport(() => Promise.reject(raised));
    await assert.rejects(
      () => new RequestEngine({ transport: mt.transport, maxRetries: 0 }).getJson(page),
      (err) => err instanceof OparlNetworkError && err.message === `GET ${page} failed: ${raised.message}` && err.cause === raised,
    );
  }
  // A refused connection, from the real transport on a loopback port nobody listens on.
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  const closed = `http://127.0.0.1:${port}/oparl/system`;
  await assert.rejects(
    () => new RequestEngine({ transport: nodeHttpTransport, maxRetries: 0 }).getJson(closed),
    (err) =>
      err instanceof OparlNetworkError &&
      err.message.startsWith(`GET ${closed} failed: connect ECONNREFUSED`) &&
      err.cause instanceof OparlNetworkError,
  );
});

test("a network error that already names the request is not prefixed twice", async () => {
  const mt = makeMockTransport(() => ({ status: 200, headers: {}, body: "not bytes" }) as never);
  await assert.rejects(
    () => new RequestEngine({ transport: mt.transport }).getJson(URL_1),
    (err) => err instanceof OparlNetworkError && /^GET \S+ failed: the transport returned an invalid response/.test(err.message) && !/failed: GET/.test(err.message),
  );
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson(URL_1), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson(URL_1), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson(URL_1), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof OparlValidationError && err.message === "Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
  // The client takes the option too.
  const client = new OparlClient({ bigIntegerKeys: new Set(["size"]), transport: makeMockTransport(() => rawResponse('{"id":"x","size":12345678901234567890}', "application/json")).transport });
  assert.deepEqual(await client.get(URL_1), { id: "x", size: "12345678901234567890" });
});

test("a number with a long run of zeros is checked in linear time (security audit 2026-10-27, class A)", async () => {
  // decimalOf trimmed trailing zeros with /0+$/, which V8 retries from every zero of a run that
  // doesn't end the text: 1.<100 000 zeros>1e300 took about 15 s, past --timeout (the scan runs
  // once the answer is in). The same answer through the engine is refused in milliseconds.
  const start = performance.now();
  const literal = `1${"0".repeat(100_000)}1e-100400`;
  assert.equal(scanNumbers(`{"x":${literal}}`).inexact, literal);
  assert.equal(scanNumbers(`{"x":1.${"0".repeat(100_000)}1e300}`).inexact, `1.${"0".repeat(100_000)}1e300`);
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(`{"x":1.${"0".repeat(100_000)}1e300}`, "application/json")).transport });
  await assert.rejects(() => e.getJson(URL_1), (err: unknown) => err instanceof OparlParseError && /cannot be represented exactly/.test(err.message) && err.message.length < 1000);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  // Leading and trailing zeros still don't count: these are exact.
  assert.equal(firstInexactNumber('{"a":0.000,"b":-0e5,"c":10000000000000000000000,"d":5e-324,"e":0.00500e-321}'), undefined);
  assert.equal(firstInexactNumber('{"a":12345678901234567890}'), "12345678901234567890");
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson(URL_1, { limit: 5 });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET ${URL_1}?limit=5: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson(URL_1), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson(URL_1), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), OparlValidationError);
  // The client takes the hook too.
  const seen: string[] = [];
  const client = new OparlClient({ onWarning: (m) => seen.push(m), transport: makeMockTransport(() => rawResponse('{"id":"\\ud800"}', "application/json")).transport });
  assert.deepEqual(await client.get(URL_1), { id: "\ufffd" });
  assert.equal(seen.length, 1);
});

test("an answer longer than V8's longest string is an OparlParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"id":"x"}                  ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson(URL_1, { limit: 5 }), (err: unknown) => {
    assert.ok(err instanceof OparlParseError, String(err));
    assert.equal(
      err.message,
      `GET ${URL_1}?limit=5: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson(URL_1), (err: unknown) => err instanceof OparlApiError && err.status === 500 && err.body === "");
});

/** Milliseconds `work` takes. */
function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (T15b)", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece, 1000), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair (oparl's own cut,
  // `maxLength`, comes after; here it is set above the bound).
  assert.equal(sanitizeServerText("x".repeat(100_000), 20_000).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`, 20_000), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  // Linear: an unterminated run of introducers took seconds with the old control-string body.
  for (const opener of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    assert.ok(elapsed(() => sanitizeServerText(`${opener.repeat(100_000)} tail`)) < 1000, JSON.stringify(opener));
  }
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per repaired escape made a rope node each: 6 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 6_000_000;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from('{"x":"' + "\\\\ud800".repeat(${n}) + '"}');` +
    `const transport = async () => ({ status: 200, headers: { "content-type": "application/json" }, body });` +
    `const value = await new RequestEngine({ transport }).getJson("https://ris.example/x");` +
    `process.stdout.write(String(value.x.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n));
});

// Class D of .reviews/2026-10-27-security-audit (portfolio round): the credential headers'
// secrets were scrubbed from an error body as sent, then the body was decoded, so a JSON-escaped
// echo (`\"`, `\u00e4`, any `\uXXXX`) reached `.message`, `.detail` and the decoded `.body`.
const D_PW = 'pä"s\'s-W0rd';
const D_BASIC = Buffer.from(`alice:${D_PW}`, "utf8").toString("base64");
/** A key with inner spaces: scrubbed whole, never word by word (jobsuche-cli 5da338b). */
const D_KEY = "k3y with inner spaces";
const D_HEADERS = { Authorization: `Basic ${D_BASIC}`, "X-API-Key": D_KEY };
/** Every form of the secrets an error must not carry: decoded, and as a JSON string spells them. */
const D_SECRETS = [D_PW, `alice:${D_PW}`, D_BASIC, D_KEY, "k3y with"].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);

/** Everything a library user may log of an error: inspect, message, detail, location, and the decoded body. */
function loggedOf(err: unknown): string {
  let text = inspect(err, { depth: 10, showHidden: true });
  const e = err as { message?: unknown; detail?: unknown; location?: unknown; body?: unknown };
  text += [e.message, e.detail, e.location, e.body].map(String).join("\n");
  try {
    const walk = (v: unknown): void => {
      if (typeof v === "string") text += `\n${v}`;
      else if (v !== null && typeof v === "object") for (const [k, w] of Object.entries(v)) text += `\n${k}${walk(w) ?? ""}`;
    };
    walk(typeof e.body === "string" ? JSON.parse(e.body) : undefined);
  } catch {
    // not JSON: the body as sent is all a caller reads
  }
  return text;
}

/** `text` as a JSON writer that escapes every non-ASCII character writes it. */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** `text` with every character written as a \uXXXX escape: no spelling of it as sent matches. */
const escapedJson = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

test("a credential header echoed with JSON escapes is scrubbed from the message, the detail and the decoded body (D)", async () => {
  const echoes: Array<[string, string]> = [
    ["the password, ASCII-only JSON", asciiJson(`wrong password ${D_PW}`)],
    ["the user:password, minimal JSON", JSON.stringify(`bad login alice:${D_PW}`)],
    ["the password, every character escaped", escapedJson(D_PW)],
    ["the key, every character escaped", escapedJson(D_KEY)],
    ["the key, its spaces escaped", JSON.stringify(`bad key ${D_KEY}`).replace(/ /g, "\\u0020")],
  ];
  for (const status of [401, 500]) {
    for (const [label, json] of echoes) {
      const e = new RequestEngine({
        defaultHeaders: D_HEADERS,
        maxRetries: 0,
        transport: async () => rawResponse(`{"message":${json}}`, "application/json", status),
      });
      const err = await e.getJson(URL_1).catch((caught: unknown) => caught);
      assert.ok(err instanceof OparlApiError && err.status === status, `${label}: ${String(err)}`);
      const seen = loggedOf(err);
      for (const secret of D_SECRETS) assert.ok(!seen.includes(secret), `${status} ${label}: ${seen.slice(0, 2000)}`);
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape (D)", async () => {
  const bodyOf = async (body: string, headers: Record<string, string> = { "X-API-Key": "s3cret-key" }): Promise<string> => {
    const e = new RequestEngine({ defaultHeaders: headers, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson(URL_1).catch((caught: unknown) => caught);
    assert.ok(err instanceof OparlApiError, String(err));
    return err.body;
  };
  // No escape, or an escape that hides nothing: as sent (the plain echo scrubbed).
  assert.equal(await bodyOf('{ "message": "bad key s3cret-key" }'), '{ "message": "bad key ***" }');
  assert.equal(await bodyOf('{ "message": "Stra\\u00dfe", "n": 1 }'), '{ "message": "Stra\\u00dfe", "n": 1 }');
  // An escape that hides the key: the decoded JSON written again, the key scrubbed.
  assert.equal(await bodyOf('{ "message": "bad key s3cret\\u002dkey" }'), '{"message":"bad key ***"}');
  // Not JSON: text nobody decodes, as sent.
  assert.equal(await bodyOf("s3cret\\u002dkey <html>"), "s3cret\\u002dkey <html>");
  // Without a credential header nothing is rewritten.
  assert.equal(await bodyOf('{ "message": "s3cret\\u002dkey" }', {}), '{ "message": "s3cret\\u002dkey" }');
});

test("a credential header in a redirect's Location is scrubbed, in its path and its query (D2)", async () => {
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(D_PW)}`,
    `https://elsewhere.example/login?pw=${D_PW}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${D_PW}`)}/x`,
    `https://elsewhere.example/auth?basic=${D_BASIC}`,
    `ftp://ris.example.de/${D_KEY}`,
    `/relative/${D_PW}`,
    `/relative/${encodeURIComponent(D_KEY)}`,
  ];
  for (const location of locations) {
    // Refused (another host or scheme), and past the redirect limit on the same host.
    for (const maxRedirects of [3, 0]) {
      const e = new RequestEngine({ defaultHeaders: D_HEADERS, maxRetries: 0, maxRedirects, transport: async () => redirect(location, 302) });
      const err = await e.getJson(URL_1).catch((caught: unknown) => caught);
      assert.ok(err instanceof OparlLinkError || err instanceof OparlApiError, `${location}: ${String(err)}`);
      const seen = decodeURIComponentSafe(loggedOf(err));
      for (const secret of D_SECRETS) assert.ok(!seen.includes(secret), `${location} (${maxRedirects}): ${seen.slice(0, 2000)}`);
    }
  }
});

/** `text` with every run of percent escapes decoded where it is valid UTF-8. */
function decodeURIComponentSafe(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

test("a Basic credential without a password is a token: scrubbed in every echoed form (E)", async () => {
  // Basic `TOKEN:` (a token sent as the user name, as Node sends a URL's `https://TOKEN@host`)
  // gave the pair `TOKEN:` and an empty password, so the token alone was no secret.
  const TOKEN = "T0kenS3cret";
  const basic = Buffer.from(`${TOKEN}:`, "utf8").toString("base64");
  for (const value of [`Basic ${basic}`, `Basic ${Buffer.from(TOKEN, "utf8").toString("base64")}`]) {
    for (const echo of [`bad token ${TOKEN}`, `Authorization: ${value}`, `user ${TOKEN}: unknown`]) {
      const e = new RequestEngine({
        defaultHeaders: { Authorization: value },
        maxRetries: 0,
        transport: async () => rawResponse(JSON.stringify({ message: echo }), "application/json", 401),
      });
      const err = await e.getJson(URL_1).catch((caught: unknown) => caught);
      assert.ok(err instanceof OparlApiError, String(err));
      const seen = loggedOf(err);
      assert.ok(!seen.includes(TOKEN) && !seen.includes(basic), `${value} ${echo}: ${seen.slice(0, 1000)}`);
    }
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, as WHATWG does (F)", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
});

test("credentialsIn skips the slashes and backslashes WHATWG skips after a special scheme (F3)", () => {
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG; read
  // after "://", the userinfo was missed, so a refused URL echoed the password in clear.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
    assert.ok(!redactUrl(value).includes("pw"), redactUrl(value));
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
  assert.equal(new URL("foo:///u:p@h.example").password, "");
  // redactUrl reads a URL that doesn't parse the same way: no `http://` put in front of it.
  for (const value of ["https:\\\\alice:pw12@h.example:99999", "http:alice:pw12@h.example:99999", "http:///alice:pw12@h.example:99999/x"]) {
    assert.ok(!redactUrl(value).includes("pw12"), `${value}: ${redactUrl(value)}`);
  }
});
