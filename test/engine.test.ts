import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, resolveLink, withQuery } from "../src/client/engine.js";
import { OparlApiError, OparlLinkError, OparlParseError, OparlValidationError } from "../src/client/errors.js";
import { jsonResponse, makeMockTransport, queryOf, rawResponse, redirect } from "./helpers.js";

const URL_1 = "https://ris.example.de/oparl/system";

test("getJson decodes JSON and sends Accept and User-Agent", async () => {
  const mt = makeMockTransport(() => jsonResponse({ id: URL_1 }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson(URL_1), { id: URL_1 });
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["User-Agent"], "oparl-cli");
  assert.equal(mt.last().timeoutMs, 120_000);
});

test("getJson appends query parameters and keeps those the URL already has", async () => {
  const mt = makeMockTransport(() => jsonResponse({ data: [] }));
  const e = new RequestEngine({ transport: mt.transport });
  await e.getJson(`${URL_1}?page=2`, { modified_since: "2026-09-01T00:00:00+00:00", limit: undefined });
  const q = queryOf(mt.last());
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("modified_since"), "2026-09-01T00:00:00+00:00");
  assert.equal(q.has("limit"), false);
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

test("withQuery leaves the URL alone when no parameter survives", () => {
  assert.equal(withQuery("https://a.de/x?page=1", { limit: undefined }), "https://a.de/x?page=1");
  assert.equal(withQuery("https://a.de/x", { omit_internal: true }), "https://a.de/x?omit_internal=true");
});
