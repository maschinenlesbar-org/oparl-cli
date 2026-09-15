import { test } from "node:test";
import assert from "node:assert/strict";
import { OparlClient, normalizeTimestamp } from "../src/client/client.js";
import { OparlLinkError, OparlParseError, OparlValidationError } from "../src/client/errors.js";
import { jsonResponse, queryOf, routes } from "./helpers.js";
import * as fx from "./fixtures.js";

const pages = {
  [fx.MEETINGS_URL]: jsonResponse(fx.meetingPages[1]),
  [`${fx.MEETINGS_URL}?page=2`]: jsonResponse(fx.meetingPages[2]),
  [`${fx.MEETINGS_URL}?page=3`]: jsonResponse(fx.meetingPages[3]),
};

function client(table: Parameters<typeof routes>[0]) {
  const mt = routes(table);
  return { c: new OparlClient({ transport: mt.transport, registryUrl: fx.REGISTRY_URL }), mt };
}

test("system returns the System object", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse(fx.system) });
  const system = await c.system(fx.SYSTEM_URL);
  assert.equal(system.body, fx.BODIES_URL);
});

test("system rejects an object that is not a System", async () => {
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body) });
  await assert.rejects(() => c.system(fx.BODY_URL), (err) => err instanceof OparlParseError && /not an OParl System/.test(err.message));
});

test("an OParl/vendor error object is reported, not returned", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse({ error: "OParl is not active." }) });
  await assert.rejects(() => c.get(fx.SYSTEM_URL), (err) => err instanceof OparlParseError && /OParl is not active/.test(err.message));
});

test("get rejects a JSON array", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse([1, 2]) });
  await assert.rejects(() => c.get(fx.SYSTEM_URL), OparlParseError);
});

test("bodies follows System.body and returns every body", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse(fx.system), [fx.BODIES_URL]: jsonResponse(fx.bodyList) });
  const result = await c.bodies(fx.SYSTEM_URL);
  assert.deepEqual(
    { pages: result.pages, next: result.next, ids: result.data.map((b) => b.id) },
    { pages: 1, next: null, ids: [fx.BODY_URL] },
  );
});

test("list fetches one page by default and reports the next link", async () => {
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), ...pages });
  const result = await c.list(fx.BODY_URL, "meeting");
  assert.equal(result.pages, 1);
  assert.equal(result.data.length, 2);
  assert.equal(result.next, `${fx.MEETINGS_URL}?page=2`);
  assert.equal(mt.calls.length, 2); // body + one page
});

test("list with maxPages 0 walks every page, resolving relative next links", async () => {
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), ...pages });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(
    { pages: result.pages, next: result.next, n: result.data.length },
    { pages: 3, next: null, n: 5 },
  );
});

test("list maps CLI type names to Body fields", async () => {
  const { c, mt } = client({
    [fx.BODY_URL]: jsonResponse(fx.body),
    [`${fx.BODY_URL}/agendaitems`]: jsonResponse({ data: [], links: {} }),
    [`${fx.BODY_URL}/legislativeterms`]: jsonResponse({ data: [], links: {} }),
  });
  await c.list(fx.BODY_URL, "agenda-item");
  assert.equal(mt.last().url, `${fx.BODY_URL}/agendaitems`);
  await c.list(fx.BODY_URL, "legislative-term");
  assert.equal(mt.last().url, `${fx.BODY_URL}/legislativeterms`);
});

test("list sends the filters on the first page only", async () => {
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), ...pages });
  await c.list(fx.BODY_URL, "meeting", { maxPages: 2, modifiedSince: "2026-09-01", limit: 50, omitInternal: true });
  const first = queryOf(mt.calls[1]!);
  assert.equal(first.get("modified_since"), "2026-09-01T00:00:00+00:00");
  assert.equal(first.get("limit"), "50");
  assert.equal(first.get("omit_internal"), "true");
  assert.equal(mt.calls[2]!.url, `${fx.MEETINGS_URL}?page=2`);
});

test("list on a 1.0 body without that list names what the body links", async () => {
  const { c, mt } = client({ [fx.body10.id]: jsonResponse(fx.body10) });
  await assert.rejects(
    () => c.list(fx.body10.id, "consultation"),
    (err) => err instanceof OparlParseError && /organization, person, meeting, paper/.test(err.message) && /OParl 1\.0/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("list rejects a URL that is not a Body", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse(fx.system) });
  await assert.rejects(() => c.list(fx.SYSTEM_URL, "meeting"), (err) => err instanceof OparlParseError && /not an OParl Body/.test(err.message));
});

test("a list page without a data array is rejected", async () => {
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(fx.system) });
  await assert.rejects(() => c.list(fx.BODY_URL, "meeting"), (err) => err instanceof OparlParseError && /not an OParl object list/.test(err.message));
});

test("a Body list URL or next link on another host is refused", async () => {
  const foreignBody = { ...fx.body, meeting: "https://tracker.example.com/meetings" };
  const one = client({ [fx.BODY_URL]: jsonResponse(foreignBody) });
  await assert.rejects(() => one.c.list(fx.BODY_URL, "meeting"), OparlLinkError);
  assert.equal(one.mt.calls.length, 1);

  const foreignNext = { data: [fx.meeting(1)], links: { next: "https://tracker.example.com/page2" } };
  const two = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(foreignNext) });
  await assert.rejects(() => two.c.list(fx.BODY_URL, "meeting", { maxPages: 0 }), OparlLinkError);
});

test("a next link pointing back at a fetched page ends the walk", async () => {
  const loop = { data: [fx.meeting(1)], links: { next: fx.MEETINGS_URL } };
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(loop) });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual({ pages: result.pages, next: result.next }, { pages: 1, next: null });
  assert.equal(mt.calls.length, 2);
});

test("an invalid timestamp filter is rejected before any request", async () => {
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body) });
  await assert.rejects(() => c.list(fx.BODY_URL, "meeting", { createdSince: "yesterday" }), OparlValidationError);
  assert.equal(mt.calls.length, 0);
});

test("endpoints walks the registry pages and projects each entry", async () => {
  const { c, mt } = client({
    [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse(fx.registryPage1),
    [`${fx.REGISTRY_URL}?page=2&limit=100`]: jsonResponse(fx.registryPage2),
  });
  const entries = await c.endpoints();
  assert.equal(mt.calls.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.title, e.working, e.oparlVersion, e.systemName]),
    [
      ["Stadt Beispiel", true, "1.1", "Stadt Beispiel - OParl 1.1"],
      ["Amt Irgendwo", false, null, null],
      ["Gemeinde Musterdorf", true, "1.0", "SD.NET RIM"],
    ],
  );
});

test("normalizeTimestamp accepts dates and ISO 8601 date-times", () => {
  assert.equal(normalizeTimestamp("2026-09-01"), "2026-09-01T00:00:00+00:00");
  assert.equal(normalizeTimestamp("2026-09-01T12:30:00Z"), "2026-09-01T12:30:00+00:00");
  assert.equal(normalizeTimestamp("2026-09-01T12:30:00+02:00"), "2026-09-01T12:30:00+02:00");
  for (const bad of ["2026-13-01", "2026-02-30", "2026-09-01T25:00:00Z", "01.09.2026", "2026-09-01 12:00", ""]) {
    assert.throws(() => normalizeTimestamp(bad), OparlValidationError, bad);
  }
});
