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

test("an error object served as a list page is reported with its message", async () => {
  const ESC = String.fromCharCode(0x1b);
  const error = { type: "https://schema.oparl.org/1.0/Error", message: `Datenbank nicht erreichbar${ESC}[2J`, debug: "ORA-12541" };
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(error) });
  await assert.rejects(
    () => c.list(fx.BODY_URL, "meeting"),
    (err) => err instanceof OparlParseError && err.message.endsWith("answered with an error object: Datenbank nicht erreichbar[2J"),
  );
  const bare = client({ [fx.SYSTEM_URL]: jsonResponse({ type: "https://schema.oparl.org/1.1/Error" }) });
  await assert.rejects(() => bare.c.get(fx.SYSTEM_URL), (err) => err instanceof OparlParseError && /error object: \(no message\)/.test(err.message));
  await assert.rejects(() => bare.c.page(fx.SYSTEM_URL), (err) => err instanceof OparlParseError && /error object/.test(err.message));
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

test("list sends the filters on every page", async () => {
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), ...pages });
  await c.list(fx.BODY_URL, "meeting", { maxPages: 2, modifiedSince: "2026-09-01", limit: 50, omitInternal: true });
  for (const call of [mt.calls[1]!, mt.calls[2]!]) {
    const q = queryOf(call);
    assert.equal(q.get("modified_since"), "2026-09-01T00:00:00+00:00");
    assert.equal(q.get("limit"), "50");
    assert.equal(q.get("omit_internal"), "true");
  }
  assert.equal(queryOf(mt.calls[2]!).get("page"), "2");
});

test("list re-applies filters to next links that echo them unencoded or drop them", async () => {
  // Somacos servers (e.g. Münster) put `modified_since=…+00:00` into `next` unencoded,
  // so the `+` reaches the server as a space and page 2 comes back unfiltered.
  const since = "2026-09-10T00:00:00+00:00";
  const table = {
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.MEETINGS_URL]: (req: { url: string }) => {
      const page = new URL(req.url).searchParams.get("page");
      if (page === "2") return jsonResponse({ data: [fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=3` } });
      if (page === "3") return jsonResponse({ data: [fx.meeting(3)], links: {} });
      return jsonResponse({ data: [fx.meeting(1)], links: { next: `${fx.MEETINGS_URL}?page=2&modified_since=${since}` } });
    },
  };
  const walked = client(table);
  const result = await walked.c.list(fx.BODY_URL, "meeting", { maxPages: 0, modifiedSince: since });
  assert.equal(result.pages, 3);
  for (const call of walked.mt.calls.slice(1)) {
    assert.equal(queryOf(call).getAll("modified_since").join("|"), since, call.url);
  }

  const onePage = client(table);
  const first = await onePage.c.list(fx.BODY_URL, "meeting", { modifiedSince: since });
  const next = new URL(first.next!);
  assert.equal(next.searchParams.get("page"), "2");
  assert.equal(next.searchParams.getAll("modified_since").join("|"), since);
});

test("list on a 1.0 body without that list names what the body links", async () => {
  const { c, mt } = client({ [fx.body10.id]: jsonResponse(fx.body10) });
  await assert.rejects(
    () => c.list(fx.body10.id, "consultation"),
    (err) => err instanceof OparlParseError && /organization, person, meeting, paper/.test(err.message) && /OParl 1\.0/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("list consultation and file follow the plural Body fields some servers use", async () => {
  // Düsseldorf's Somacos server links `consultations` and `files` instead of the spec's
  // `consultation` and `file`.
  const { consultation, file, ...rest } = fx.body;
  const plural = { ...rest, consultations: consultation, files: file };
  const page = { data: [{ id: `${consultation}/1`, type: "https://schema.oparl.org/1.1/Consultation" }], links: {} };
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(plural), [consultation]: jsonResponse(page), [file]: jsonResponse({ data: [], links: {} }) });
  assert.deepEqual((await c.list(fx.BODY_URL, "consultation")).data, page.data);
  assert.equal(mt.last().url, consultation);
  await c.list(fx.BODY_URL, "file");
  assert.equal(mt.last().url, file);

  // The spec field wins when a body has both, and the error lists the fallbacks as available.
  const both = client({ [fx.BODY_URL]: jsonResponse({ ...fx.body, files: `${fx.BODY_URL}/other-files` }), [file]: jsonResponse({ data: [], links: {} }) });
  await both.c.list(fx.BODY_URL, "file");
  assert.equal(both.mt.last().url, file);
  const { membership: _m, ...noMembership } = plural;
  const missing = client({ [fx.BODY_URL]: jsonResponse(noMembership) });
  await assert.rejects(
    () => missing.c.list(fx.BODY_URL, "membership"),
    (err) => err instanceof OparlParseError && /agenda-item, consultation, file, location/.test(err.message),
  );
});

test("list legislative-term returns the terms a body embeds instead of linking a list", async () => {
  // OParl 1.0 bodies (e.g. Castrop-Rauxel) embed legislativeTerm and have no legislativeTermList.
  const { c, mt } = client({ [fx.body10.id]: jsonResponse(fx.body10) });
  assert.deepEqual(await c.list(fx.body10.id, "legislative-term"), { data: fx.body10.legislativeTerm, pages: 0, next: null });
  assert.equal(mt.calls.length, 1);

  const terms = [
    { id: `${fx.HOST}/oparl/LegislativeTerm/1`, name: "2014 - 2020", modified: "2020-11-01T00:00:00+01:00" },
    { id: `${fx.HOST}/oparl/LegislativeTerm/2`, name: "2020 - 2025", modified: "2025-11-01T00:00:00+01:00" },
    { id: `${fx.HOST}/oparl/LegislativeTerm/3`, name: "undated" },
  ];
  const filtered = client({ [fx.body10.id]: jsonResponse({ ...fx.body10, legislativeTerm: terms }) });
  const since = await filtered.c.list(fx.body10.id, "legislative-term", { modifiedSince: "2021-01-01" });
  assert.deepEqual(since.data.map((t) => t["name"]), ["2020 - 2025"]);
  const until = await filtered.c.list(fx.body10.id, "legislative-term", { modifiedUntil: "2021-01-01" });
  assert.deepEqual(until.data.map((t) => t["name"]), ["2014 - 2020"]);
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

test("normalizeTimestamp accepts the other ISO 8601 forms and writes the spec form", () => {
  // What `date --iso-8601=ns`, JavaScript's toISOString() and PostgreSQL print.
  const cases: Array<[string, string]> = [
    ["2026-09-01T12:30:00.123Z", "2026-09-01T12:30:00+00:00"],
    ["2026-09-01T12:30:00,5+02:00", "2026-09-01T12:30:00+02:00"],
    ["2026-09-01T12:30:00.123456789+02:00", "2026-09-01T12:30:00+02:00"],
    ["2026-09-01T12:30Z", "2026-09-01T12:30:00+00:00"],
    ["2026-09-01T12:30:00+0200", "2026-09-01T12:30:00+02:00"],
    ["2026-09-01T12:30:00-05", "2026-09-01T12:30:00-05:00"],
    ["2026-09-01t12:30:00z", "2026-09-01T12:30:00+00:00"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeTimestamp(input), expected, input);
  for (const bad of ["2026-09-01T12:30:00", "2026-09-01T12:30:00+2400", "2026-09-01T12:30:00+02:60", "2026-09-01T12:30:00.Z", "2026-09-01T12Z"]) {
    assert.throws(() => normalizeTimestamp(bad), OparlValidationError, bad);
  }
});
