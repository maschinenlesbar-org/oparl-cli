import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { RequestEngine, encodeTimestampPlus, resolveLink, sanitizeServerText, withQuery } from "../src/client/engine.js";
import {
  OparlApiError,
  OparlLinkError,
  OparlNetworkError,
  OparlParseError,
  OparlValidationError,
} from "../src/client/errors.js";
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
  await assert.rejects(() => e.getJson(URL_1), (err) => err instanceof OparlApiError && err.status === 301);
  assert.equal(mt.calls.length, 3);
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
    ["   ", /Empty response/],
    ["{not json", /Failed to parse JSON/],
  ];
  for (const [body, message] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, "text/html"));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(() => e.getJson(URL_1), (err) => err instanceof OparlParseError && message.test(err.message));
  }
});

test("a non-JSON answer says what the server actually sent", async () => {
  // All of these were reported as "Failed to parse JSON response": Aachen's error page
  // starts with an HTML comment and Apache's with an XML declaration, so the prefix test
  // missed them, and a file URL answers with the file.
  const cases: Array<[string | Buffer, string, RegExp]> = [
    ["<!-- ERROR REFERENCE -->\n<!doctype html><html>oops</html>", "text/html; charset=utf-8", /an HTML page \(content-type: text\/html\)/],
    ['<?xml version="1.0"?>\n<html><body>Bad Gateway!</body></html>', "text/html", /an HTML page/],
    ['<?xml version="1.0"?><error>no</error>', "application/xml", /an XML document/],
    [Buffer.from("%PDF-1.4\ntrailer\n"), "application/pdf", /a PDF file .*does not download files/],
    ["Not found", "text/plain", /Failed to parse JSON response .* \(content-type: text\/plain\)/],
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
    (err) => err instanceof OparlParseError && /gzip-compressed response .* could not be decompressed/.test(err.message),
  );

  // maxResponseBytes has to hold for the decompressed size too: the transport only ever
  // sees the bytes on the wire, which a compression bomb keeps small on purpose.
  const bomb = zlib.gzipSync(Buffer.alloc(200_000, 0x20));
  const big = makeMockTransport(() => rawResponse(bomb, "application/json", 200, { "content-encoding": "gzip" }));
  await assert.rejects(
    () => new RequestEngine({ transport: big.transport, maxResponseBytes: 1000 }).getJson(URL_1),
    (err) => err instanceof OparlNetworkError && /maxResponseBytes \(1000\)/.test(err.message),
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
      assert.equal(err.detail, "boom[31mred2J");
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
