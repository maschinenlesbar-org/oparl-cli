import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PAGES_HARD_LIMIT, OparlClient, endpointKey, normalizeTimestamp } from "../src/client/client.js";
import { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "../src/client/endpoints-list.js";
import { OparlApiError, OparlError, OparlLinkError, OparlParseError, OparlValidationError } from "../src/client/errors.js";
import type { CuratedEndpoint, RegistryCheck } from "../src/client/types.js";
import { hasControlChar, hostileText, jsonResponse, queryOf, rawResponse, redirect, routes } from "./helpers.js";
import * as fx from "./fixtures.js";

const pages = {
  [fx.MEETINGS_URL]: jsonResponse(fx.meetingPages[1]),
  [`${fx.MEETINGS_URL}?page=2`]: jsonResponse(fx.meetingPages[2]),
  [`${fx.MEETINGS_URL}?page=3`]: jsonResponse(fx.meetingPages[3]),
};

function client(
  table: Parameters<typeof routes>[0],
  lists: { curatedEndpoints?: CuratedEndpoint[]; registryChecks?: RegistryCheck[] } = {},
) {
  const mt = routes(table);
  const c = new OparlClient({
    transport: mt.transport,
    registryUrl: fx.REGISTRY_URL,
    curatedEndpoints: lists.curatedEndpoints ?? [],
    registryChecks: lists.registryChecks ?? [],
  });
  return { c, mt };
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

test("a System whose body is not a URL is reported as what it is", async () => {
  // A System that embeds its bodies, or leaves `body` out: telling the user it is not a
  // System and pointing at the URL they just used sends them looking for the wrong thing.
  const cases: Array<[unknown, RegExp]> = [
    [[fx.body], /is an OParl System, but its `body` is an array instead of the URL/],
    [undefined, /is an OParl System, but its `body` is missing instead of the URL/],
  ];
  for (const [value, expected] of cases) {
    const { body: _drop, ...rest } = fx.system;
    const served = value === undefined ? rest : { ...rest, body: value };
    const { c } = client({ [fx.SYSTEM_URL]: jsonResponse(served) });
    await assert.rejects(() => c.system(fx.SYSTEM_URL), (err) => err instanceof OparlParseError && expected.test(err.message));
  }
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

test("an unencoded + in a next link's timestamp is sent, and handed back, as %2B", async () => {
  // Without a filter of the caller's own, the server's next link is used as it came:
  // Somacos echoes modified_since with a raw +, which the server itself reads as a space.
  const raw = `${fx.MEETINGS_URL}?page=2&modified_since=2026-09-20T00:00:00+00:00`;
  const encoded = `${fx.MEETINGS_URL}?page=2&modified_since=2026-09-20T00:00:00%2B00:00`;
  const { c, mt } = client({
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.MEETINGS_URL]: (req) =>
      new URL(req.url).searchParams.has("page")
        ? jsonResponse({ data: [fx.meeting(2)], links: { next: `${raw.replace("page=2", "page=3")}` } })
        : jsonResponse({ data: [fx.meeting(1)], links: { next: raw } }),
  });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 2 });
  assert.equal(mt.calls[2]?.url, encoded);
  assert.equal(result.next, encoded.replace("page=2", "page=3"));
});

test("list on a 1.0 body without that list names what the body links", async () => {
  const { c, mt } = client({ [fx.body10.id]: jsonResponse(fx.body10) });
  await assert.rejects(
    () => c.list(fx.body10.id, "consultation"),
    (err) => err instanceof OparlParseError && /organization, person, meeting, paper/.test(err.message) && /OParl 1\.0/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("the 1.0 note is left out when the body links lists beyond the 1.0 four", async () => {
  // Politik bei Uns publishes a 1.0 `type` on bodies that link nine lists: the note then
  // contradicted the list of links right in front of it.
  const rich = { ...fx.body, type: "https://schema.oparl.org/1.0/Body", legislativeTermList: undefined };
  const { c } = client({ [fx.BODY_URL]: jsonResponse(rich) });
  await assert.rejects(
    () => c.list(fx.BODY_URL, "legislative-term"),
    (err) =>
      err instanceof OparlParseError &&
      /It links: organization, person, meeting, paper, agenda-item, consultation, file, membership, location\.$/.test(err.message),
  );
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
  assert.deepEqual(since.data.map((t) => t["name"]), ["2020 - 2025", "undated"]);
  const until = await filtered.c.list(fx.body10.id, "legislative-term", { modifiedUntil: "2021-01-01" });
  assert.deepEqual(until.data.map((t) => t["name"]), ["2014 - 2020", "undated"]);
});

test("a date filter keeps embedded terms the server left undated, and says so", async () => {
  // ALLRIS 1.0 (BVV Mitte) omits the mandatory created/modified on its embedded terms;
  // excluding them turns a filter into a silently empty answer.
  const terms = [
    { id: `${fx.HOST}/oparl/LegislativeTerm/1`, type: "https://schema.oparl.org/1.0/LegislativeTerm", name: "2016-2021" },
    { id: `${fx.HOST}/oparl/LegislativeTerm/2`, type: "https://schema.oparl.org/1.0/LegislativeTerm", name: "2021-2026" },
  ];
  const { c } = client({ [fx.body10.id]: jsonResponse({ ...fx.body10, legislativeTerm: terms }) });
  const result = await c.list(fx.body10.id, "legislative-term", { modifiedSince: "2000-01-01" });
  assert.deepEqual(result.data.map((t) => t["name"]), ["2016-2021", "2021-2026"]);
  assert.match(result.note ?? "", /2 of 2 embedded legislative terms carry no created\/modified/);

  // An object with a timestamp outside the window is still excluded, undated fields aside.
  const mixed = client({
    [fx.body10.id]: jsonResponse({ ...fx.body10, legislativeTerm: [{ ...terms[0], modified: "1999-01-01T00:00:00+01:00" }] }),
  });
  const excluded = await mixed.c.list(fx.body10.id, "legislative-term", { modifiedSince: "2000-01-01", createdSince: "2000-01-01" });
  assert.deepEqual({ data: excluded.data, note: excluded.note }, { data: [], note: undefined });
});

test("list rejects a URL that is not a Body", async () => {
  const { c } = client({ [fx.SYSTEM_URL]: jsonResponse(fx.system) });
  await assert.rejects(() => c.list(fx.SYSTEM_URL, "meeting"), (err) => err instanceof OparlParseError && /not an OParl Body/.test(err.message));
});

test("a list page without a data array is rejected", async () => {
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(fx.system) });
  await assert.rejects(() => c.list(fx.BODY_URL, "meeting"), (err) => err instanceof OparlParseError && /not an OParl object list/.test(err.message));
});

test("a server's type string cannot carry terminal escapes into a message", async () => {
  // The three type checks were the only server text not passed through the sanitiser,
  // so any endpoint a user named — 40 of the shipped ones speak http — could write the
  // terminal title, set colours or fake a second `Error:` line.
  const hostileType = { id: fx.BODY_URL, type: hostileText("/NotABody"), meeting: fx.MEETINGS_URL };
  const cases: Array<[Promise<unknown>, RegExp]> = [
    [client({ [fx.SYSTEM_URL]: jsonResponse({ ...hostileType, id: fx.SYSTEM_URL }) }).c.system(fx.SYSTEM_URL), /not an OParl System/],
    [client({ [fx.BODY_URL]: jsonResponse(hostileType) }).c.list(fx.BODY_URL, "meeting"), /not an OParl Body/],
    [
      client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(hostileType) }).c.list(fx.BODY_URL, "meeting"),
      /not an OParl object list/,
    ],
    [
      client({ [fx.SYSTEM_URL]: jsonResponse({ type: "https://schema.oparl.org/1.1/Error", message: hostileText() }) }).c.get(fx.SYSTEM_URL),
      /answered with an error object/,
    ],
  ];
  for (const [pending, message] of cases) {
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof OparlParseError);
      assert.match(err.message, message);
      assert.ok(!hasControlChar(err.message), err.message);
      assert.equal(err.message.split("\n").length, 1);
      assert.ok(err.message.length < 400, `${err.message.length} characters`);
      return true;
    });
  }
});

test("a Body list URL on another host is refused", async () => {
  const foreignBody = { ...fx.body, meeting: "https://tracker.example.com/meetings" };
  const one = client({ [fx.BODY_URL]: jsonResponse(foreignBody) });
  await assert.rejects(() => one.c.list(fx.BODY_URL, "meeting"), OparlLinkError);
  assert.equal(one.mt.calls.length, 1);
});

test("a next link this client won't follow ends the walk but keeps the pages fetched", async () => {
  // A server behind a proxy that publishes its `next` on another host, a javascript:
  // link, an unparseable one: none of them may cost the user the page already fetched.
  for (const link of ["https://tracker.example.com/page2", "javascript:alert(1)", "http://["]) {
    const table = {
      [fx.BODY_URL]: jsonResponse(fx.body),
      [fx.MEETINGS_URL]: jsonResponse({ data: [fx.meeting(1)], links: { next: link } }),
    };
    for (const maxPages of [1, 0]) {
      const { c } = client(table);
      const result = await c.list(fx.BODY_URL, "meeting", { maxPages });
      assert.deepEqual(
        { ids: result.data.map((m) => m["id"]), pages: result.pages, next: result.next, looped: result.looped },
        { ids: [fx.meeting(1).id], pages: 1, next: null, looped: undefined },
        `${link} with maxPages ${maxPages}`,
      );
      assert.match(result.note ?? "", /stopped after page 1: (Refusing to follow|The server returned an invalid link)/);
    }
  }
});

test("a redirect to another host on a later page ends the walk but keeps the pages fetched", async () => {
  // DEVELOPING promises that a refused link never costs the pages already fetched; a
  // redirect Location is such a link, just like a `next` link on another host.
  const { c, mt } = client({
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.MEETINGS_URL]: jsonResponse({ data: [fx.meeting(1)], links: { next: `${fx.MEETINGS_URL}?page=2` } }),
    [`${fx.MEETINGS_URL}?page=2`]: redirect("https://tracker.example.com/page2", 302),
  });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(
    { ids: result.data.map((m) => m["id"]), pages: result.pages, next: result.next, looped: result.looped },
    { ids: [fx.meeting(1).id], pages: 1, next: null, looped: undefined },
  );
  assert.match(result.note ?? "", /^stopped after page 1: Refusing to follow https:\/\/tracker\.example\.com\/page2 /);
  assert.equal(mt.calls.length, 3);
});

test("a failure on a later page is thrown with the pages fetched and the failing page as next", async () => {
  const failures = [
    { name: "HTTP 500", response: jsonResponse({ error: "boom" }, 500), type: OparlApiError },
    { name: "an HTML page", response: rawResponse("<html>down</html>", "text/html"), type: OparlParseError },
  ];
  for (const { name, response, type } of failures) {
    const page2 = `${fx.MEETINGS_URL}?page=2&modified_since=2026-01-01T00%3A00%3A00%2B00%3A00`;
    const { c } = client({
      [fx.BODY_URL]: jsonResponse(fx.body),
      [fx.MEETINGS_URL]: (req) =>
        new URL(req.url).searchParams.has("page")
          ? response
          : jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=2` } }),
    });
    const err = await c.list(fx.BODY_URL, "meeting", { maxPages: 0, modifiedSince: "2026-01-01" }).then(
      () => assert.fail(`${name}: expected a rejection`),
      (e: unknown) => e,
    );
    assert.ok(err instanceof type, `${name}: ${String(err)}`);
    const partial = (err as OparlError).partial;
    assert.deepEqual(
      { ids: partial?.data.map((m) => m["id"]), pages: partial?.pages, next: partial?.next },
      { ids: [fx.meeting(1).id, fx.meeting(2).id], pages: 1, next: page2 },
      name,
    );
    assert.match(partial?.note ?? "", /^stopped after page 1 because page 2 failed; .*next is the page that failed/, name);
  }
});

test("a failure on the first page is thrown without a partial result", async () => {
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse({ error: "boom" }, 500) });
  const err = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 }).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof OparlApiError);
  assert.equal(err.partial, undefined);
});

test("relative links are resolved against the URL a redirect led to", async () => {
  // /oparl 301s to /oparl/v2/system, whose `body` is the relative "bodies"; the Body
  // there links the relative "meetings", whose page 1 links the relative "meetings?page=2".
  // All of them used to be resolved against the URL before the redirect and 404.
  const { c, mt } = client({
    "https://ris.example.de/oparl": redirect("/oparl/v2/system"),
    "https://ris.example.de/oparl/v2/system": jsonResponse({ ...fx.system, body: "bodies" }),
    "https://ris.example.de/oparl/v2/bodies": jsonResponse({ data: [{ ...fx.body, id: "https://ris.example.de/oparl/v2/bodies/1", meeting: "1/meetings" }] }),
    "https://ris.example.de/oparl/v2/bodies/1": jsonResponse({ ...fx.body, id: "https://ris.example.de/oparl/v2/bodies/1", meeting: "1/meetings" }),
    "https://ris.example.de/oparl/v2/bodies/1/meetings": jsonResponse({ data: [fx.meeting(1)], links: { next: "meetings?page=2" } }),
    "https://ris.example.de/oparl/v2/bodies/1/meetings?page=2": jsonResponse({ data: [fx.meeting(2)] }),
  });
  const bodies = await c.bodies("https://ris.example.de/oparl");
  assert.deepEqual(bodies.data.map((b) => b["id"]), ["https://ris.example.de/oparl/v2/bodies/1"]);

  const meetings = await c.list("https://ris.example.de/oparl/v2/bodies/1", "meeting", { maxPages: 2 });
  assert.deepEqual(meetings.data.map((m) => m["id"]), [fx.meeting(1).id, fx.meeting(2).id]);
  assert.equal(meetings.pages, 2);
  assert.ok(
    mt.calls.every((call) => !call.url.includes("/oparl/bodies")),
    mt.calls.map((call) => call.url).join(" "),
  );
});

test("a next link pointing back at a fetched page ends the walk", async () => {
  const loop = { data: [fx.meeting(1)], links: { next: fx.MEETINGS_URL } };
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse(loop) });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual({ pages: result.pages, next: result.next, looped: result.looped }, { pages: 1, next: null, looped: true });
  assert.match(result.note ?? "", /points back to a page already fetched/);
  assert.equal(mt.calls.length, 2);
});

test("the first page is remembered with its filters, so a next link back to it is caught", async () => {
  // The page's `next` is the page itself, filters included: without the filters in the
  // loop guard the walk refetches it and hands the user a `next` that leads nowhere else.
  const selfNext = (req: { url: string }) =>
    jsonResponse({ data: [fx.meeting(1)], links: { next: `${fx.MEETINGS_URL}${new URL(req.url).search}` } });
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: selfNext });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0, modifiedSince: "2026-01-01" });
  assert.deepEqual({ pages: result.pages, next: result.next, looped: result.looped }, { pages: 1, next: null, looped: true });
  assert.equal(mt.calls.length, 2); // body + the one page
});

test("a run of pages that add nothing ends the walk, with a next link to resume from", async () => {
  // A server that serves the same page under ever-new ?page=n links (seen live on the
  // OWL-IT server): without the check, the walk runs to the hard page limit.
  const repeating = (req: { url: string }) => {
    const n = Number(new URL(req.url).searchParams.get("page") ?? "1");
    return jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=${n + 1}` } });
  };
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: repeating });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(result.data.map((m) => m["id"]), [fx.meeting(1).id, fx.meeting(2).id]);
  assert.deepEqual(
    { pages: result.pages, next: result.next, looped: result.looped },
    { pages: 4, next: `${fx.MEETINGS_URL}?page=5`, looped: true },
  );
  assert.match(result.note ?? "", /the last 3 pages added no object/);
  assert.equal(mt.calls.length, 5);
});

test("an endless run of empty pages ends the walk instead of paging to the hard limit", async () => {
  const empty = (req: { url: string }) => {
    const n = Number(new URL(req.url).searchParams.get("page") ?? "1");
    return jsonResponse({ data: [], links: { next: `${fx.MEETINGS_URL}?page=${n + 1}` } });
  };
  const { c, mt } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: empty });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(
    { n: result.data.length, pages: result.pages, next: result.next, looped: result.looped },
    { n: 0, pages: 3, next: `${fx.MEETINGS_URL}?page=4`, looped: true },
  );
  assert.equal(mt.calls.length, 4);
});

test("a walk stopped by the page limit of maxPages 0 says so", async () => {
  // Every page adds a new object and links the next: only the hard limit ends the walk,
  // and a non-null next alone was the only sign that the list had not ended.
  const endless = (req: { url: string }) => {
    const n = Number(new URL(req.url).searchParams.get("page") ?? "1");
    return jsonResponse({ data: [fx.meeting(n)], links: { next: `${fx.MEETINGS_URL}?page=${n + 1}` } });
  };
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: endless });
  const all = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(
    { n: all.data.length, pages: all.pages, next: all.next, looped: all.looped },
    { n: MAX_PAGES_HARD_LIMIT, pages: MAX_PAGES_HARD_LIMIT, next: `${fx.MEETINGS_URL}?page=${MAX_PAGES_HARD_LIMIT + 1}`, looped: undefined },
  );
  assert.match(all.note ?? "", /^stopped after page 10000: maxPages 0 \(--max-pages 0\) fetches at most 10000 pages/);
  // An explicit page count that is reached is what the caller asked for: no note.
  const three = await c.list(fx.BODY_URL, "meeting", { maxPages: 3 });
  assert.deepEqual({ pages: three.pages, note: three.note }, { pages: 3, note: undefined });
});

test("a last page as long as the limit, without a next link, gets a note", async () => {
  // ALLRIS 1.0 answers limit=3 with three objects and only a `first` link, so the whole
  // list looked like three objects.
  const allris = (req: { url: string }) => {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? "5");
    const all = [1, 2, 3, 4, 5].map((n) => fx.meeting(n));
    return jsonResponse({ data: all.slice(0, limit), links: { first: fx.MEETINGS_URL } });
  };
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: allris });
  const cut = await c.list(fx.BODY_URL, "meeting", { limit: 3, maxPages: 2 });
  assert.deepEqual({ n: cut.data.length, pages: cut.pages, next: cut.next }, { n: 3, pages: 1, next: null });
  assert.match(cut.note ?? "", /^the last page held exactly 3 objects, .* run it again without the limit/);
  // Fewer objects than the limit, or no limit at all: a plain end of the list.
  for (const options of [{ limit: 10 }, {}]) {
    const result = await c.list(fx.BODY_URL, "meeting", options);
    assert.deepEqual({ n: result.data.length, note: result.note }, { n: 5, note: undefined }, JSON.stringify(options));
  }
});

test("a page that repeats objects because the list shifted does not truncate the walk", async () => {
  // Two objects are inserted at the head of the list between page 1 and page 2, so page 2
  // repeats page 1 — indistinguishable from a repeating server until the next page.
  const shifted = (req: { url: string }) => {
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    if (page === 1) return jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=2` } });
    if (page === 2) return jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=3` } });
    return jsonResponse({ data: [fx.meeting(3), fx.meeting(4)], links: {} });
  };
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: shifted });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(result.data.map((m) => m["id"]), [1, 2, 3, 4].map((n) => fx.meeting(n).id));
  assert.deepEqual({ pages: result.pages, next: result.next, looped: result.looped, note: result.note }, { pages: 3, next: null, looped: undefined, note: undefined });
});

test("a repeated id keeps the last copy the server sent, tombstones included", async () => {
  // The spec's sync model relies on the newer copy arriving later: an object edited
  // during the walk, and a deleted one that comes back as { id, deleted: true }.
  const edited = { ...fx.meeting(1), name: "Sitzung des Rates (verlegt)", modified: "2026-09-16T10:00:00+02:00" };
  const tombstone = { id: fx.meeting(2).id, type: fx.meeting(2).type, created: fx.meeting(2).created, modified: "2026-09-16T10:00:00+02:00", deleted: true };
  const { c } = client({
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.MEETINGS_URL]: jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=2` } }),
    [`${fx.MEETINGS_URL}?page=2`]: jsonResponse({ data: [edited, tombstone, fx.meeting(3)], links: {} }),
  });
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(result.data.map((m) => m["id"]), [1, 2, 3].map((n) => fx.meeting(n).id));
  assert.deepEqual(result.data[0], edited); // the later, newer copy, in the first copy's place
  assert.deepEqual(result.data[1], tombstone);
  assert.deepEqual({ pages: result.pages, next: result.next }, { pages: 2, next: null });
});

test("a list page whose data holds null or a scalar is a parse error, not a crash", async () => {
  for (const entry of [null, "https://ris.example.de/oparl/bodies/stadt/meetings/1", 7]) {
    const { c } = client({
      [fx.BODY_URL]: jsonResponse(fx.body),
      [fx.MEETINGS_URL]: jsonResponse({ data: [fx.meeting(1), entry], links: {} }),
    });
    await assert.rejects(
      () => c.list(fx.BODY_URL, "meeting"),
      (err) => err instanceof OparlParseError && /entry in `data` that is not an OParl object/.test(err.message),
      String(entry),
    );
  }
});

test("a list URL that answers with a bare JSON array is read as one page", async () => {
  // An SD.NET RIM build in Essen serves [] for an empty list instead of a list page.
  const { c } = client({ [fx.BODY_URL]: jsonResponse(fx.body), [`${fx.BODY_URL}/legislativeterms`]: jsonResponse([]) });
  assert.deepEqual(await c.list(fx.BODY_URL, "legislative-term"), { data: [], pages: 1, next: null });

  const filled = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse([fx.meeting(1), fx.meeting(2)]) });
  const result = await filled.c.list(fx.BODY_URL, "meeting");
  assert.deepEqual({ ids: result.data.map((m) => m["id"]), pages: result.pages, next: result.next }, { ids: [fx.meeting(1).id, fx.meeting(2).id], pages: 1, next: null });

  const bad = client({ [fx.BODY_URL]: jsonResponse(fx.body), [fx.MEETINGS_URL]: jsonResponse([fx.meeting(1), null]) });
  await assert.rejects(() => bad.c.list(fx.BODY_URL, "meeting"), OparlParseError);
});

test("objects repeated across pages are listed once, and the walk goes on", async () => {
  const table = {
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.MEETINGS_URL]: jsonResponse({ data: [fx.meeting(1), fx.meeting(2)], links: { next: `${fx.MEETINGS_URL}?page=2` } }),
    [`${fx.MEETINGS_URL}?page=2`]: jsonResponse({ data: [fx.meeting(2), fx.meeting(3)], links: { next: `${fx.MEETINGS_URL}?page=3` } }),
    [`${fx.MEETINGS_URL}?page=3`]: jsonResponse({ data: [fx.meeting(4)], links: {} }),
  };
  const { c } = client(table);
  const result = await c.list(fx.BODY_URL, "meeting", { maxPages: 0 });
  assert.deepEqual(result.data.map((m) => m.id), [1, 2, 3, 4].map((n) => fx.meeting(n).id));
  assert.deepEqual(result, { data: result.data, pages: 3, next: null });
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

const registryTable = {
  [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse(fx.registryPage1),
  [`${fx.REGISTRY_URL}?page=2&limit=100`]: jsonResponse(fx.registryPage2),
};

const curated = (title: string, url: string, extra: Partial<CuratedEndpoint> = {}): CuratedEndpoint => ({
  title,
  url,
  working: true,
  checked: "2026-09-16",
  problem: null,
  oparlVersion: "1.1",
  systemName: null,
  vendor: null,
  bodyCount: 1,
  note: null,
  ...extra,
});

test("endpoints merges the curated list after the registry and applies the live checks", async () => {
  const { c } = client(registryTable, {
    curatedEndpoints: [
      curated("Stadt Neu", "https://ris.neu.example/oparl/system"),
      // The registry already lists this System (a trailing slash aside).
      curated("Stadt Beispiel (duplicate)", `${fx.SYSTEM_URL}/`),
    ],
    registryChecks: [
      {
        url: "https://www.irgendwo.sitzung-online.de/bi/oparl/1.0/system.asp",
        working: false,
        checked: "2026-09-16",
        problem: "HTTP 404",
        replacedBy: "https://ris.neu.example/oparl/system",
        note: null,
      },
      { url: "https://rim.example.net/musterdorf/webservice/oparl/v1.0/system", working: false, checked: "2026-09-16", problem: "timeout", replacedBy: null, note: "slow" },
    ],
  });
  const entries = await c.endpoints();
  assert.deepEqual(
    entries.map((e) => [e.title, e.source, e.working, e.checked, e.problem, e.replacedBy, e.note]),
    [
      // The curated duplicate carries the only live check of this System.
      ["Stadt Beispiel", "registry", true, "2026-09-16", null, null, null],
      ["Amt Irgendwo", "registry", false, "2026-09-16", "HTTP 404", "https://ris.neu.example/oparl/system", null],
      ["Gemeinde Musterdorf", "registry", false, "2026-09-16", "timeout", null, "slow"],
      ["Stadt Neu", "curated", true, "2026-09-16", null, null, null],
    ],
  );
  assert.equal(entries[0]?.fetched, "2026-01-17T01:05:03+01:00");
  assert.equal(entries[3]?.fetched, null);
});

test("a live check's System data is preferred over the registry's cached copy", async () => {
  // The registry's `system` is a rarely refreshed snapshot, and missing altogether for
  // some endpoints (Amt Irgendwo), while the check fetched the real System.
  const { c } = client(registryTable, {
    registryChecks: [
      {
        url: "https://www.irgendwo.sitzung-online.de/bi/oparl/1.0/system.asp",
        working: true,
        checked: "2026-09-16",
        problem: null,
        oparlVersion: "1.0",
        systemName: "ALLRIS",
        vendor: "http://cc-egov.de/",
        bodyCount: 2,
        replacedBy: null,
        note: null,
      },
      // A failed check read no System, so the registry's own data stands.
      { url: fx.SYSTEM_URL, working: false, checked: "2026-09-16", problem: "timeout", replacedBy: null, note: null },
    ],
  });
  assert.deepEqual(
    (await c.endpoints({ source: "registry" })).map((e) => [e.title, e.working, e.oparlVersion, e.systemName, e.vendor, e.bodyCount]),
    [
      ["Stadt Beispiel", false, "1.1", "Stadt Beispiel - OParl 1.1", "https://www.somacos.de?oparl=v1.6.1", 1],
      ["Amt Irgendwo", true, "1.0", "ALLRIS", "http://cc-egov.de/", 2],
      ["Gemeinde Musterdorf", true, "1.0", "SD.NET RIM", "https://www.somacos.de?oparl=v1.6.1", 0],
    ],
  );
});

test("a registry next link back to the page just fetched ends the registry walk", async () => {
  // The guard used to store the bare registry URL while the request went to
  // ?page=1&limit=100, so a `next` back to page 1 refetched it.
  const page = (n: number) => jsonResponse({ data: fx.registryPage2.data, meta: { next: `${fx.REGISTRY_URL}?page=${n}&limit=100` } });
  const { c, mt } = client({ [`${fx.REGISTRY_URL}?page=1&limit=100`]: page(2), [`${fx.REGISTRY_URL}?page=2&limit=100`]: page(1) });
  assert.deepEqual((await c.endpoints({ source: "registry" })).map((e) => e.title), ["Gemeinde Musterdorf"]);
  assert.deepEqual(mt.calls.map((call) => call.url), [`${fx.REGISTRY_URL}?page=1&limit=100`, `${fx.REGISTRY_URL}?page=2&limit=100`]);
});

test("endpoints lists a System the registry holds twice only once", async () => {
  const entry = fx.registryPage2.data[0]!;
  const doubled = { data: [entry, { ...entry, id: 4, title: "Gemeinde Musterdorf (again)", url: `${entry.url}/` }], meta: {} };
  const { c } = client({ [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse(doubled) });
  assert.deepEqual((await c.endpoints()).map((e) => e.title), ["Gemeinde Musterdorf"]);
});

test("where both lists hold a System, the fresher of the two checks decides", async () => {
  // The registry catches up with a curated server: its snapshot must not overwrite a
  // newer curated check (and vice versa).
  const entries = async (checked: string) => {
    const { c } = client(registryTable, {
      curatedEndpoints: [
        curated("Stadt Beispiel (curated)", fx.SYSTEM_URL, {
          working: false,
          checked: "2026-09-20",
          problem: "TLS certificate not verifiable",
          note: "sends no intermediate certificate",
        }),
      ],
      registryChecks: [{ url: fx.SYSTEM_URL, working: true, checked, problem: null, replacedBy: null, note: null }],
    });
    const listed = await c.endpoints();
    assert.equal(listed.length, 3); // the System is listed once, under the registry entry
    return [listed[0]!.title, listed[0]!.working, listed[0]!.checked, listed[0]!.problem, listed[0]!.note];
  };
  assert.deepEqual(await entries("2026-09-10"), [
    "Stadt Beispiel",
    false,
    "2026-09-20",
    "TLS certificate not verifiable",
    "sends no intermediate certificate",
  ]);
  assert.deepEqual(await entries("2026-09-30"), ["Stadt Beispiel", true, "2026-09-30", null, null]);
});

test("registry entries without a fetchable url are left out", async () => {
  // The registry carries a few entries with no `url`; they all keyed alike, so the
  // second one looked like a duplicate of the first and vanished, while the others
  // were listed as endpoints although nothing can be fetched from them.
  const { c } = client({
    [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse({
      data: [
        { id: 1, title: "No URL A", system: null },
        { id: 2, title: "No URL B", system: null },
        { id: 3, title: "Bad URL", url: "not a url", system: null },
        { id: 4, title: "Not http", url: "ftp://ris.example.de/oparl/system", system: null },
        { id: 5, title: "Stadt Beispiel", url: fx.SYSTEM_URL, system: fx.system },
      ],
      meta: {},
    }),
  });
  assert.deepEqual((await c.endpoints({ source: "registry" })).map((e) => e.title), ["Stadt Beispiel"]);
});

test("an endpoint list option without a url is a validation error, not a TypeError", () => {
  assert.throws(() => client(registryTable, { curatedEndpoints: [{ title: "no url" } as unknown as CuratedEndpoint] }), OparlValidationError);
  assert.throws(() => client(registryTable, { registryChecks: [{ working: true } as unknown as RegistryCheck] }), OparlValidationError);
  assert.throws(() => client(registryTable, { curatedEndpoints: "nope" as unknown as CuratedEndpoint[] }), OparlValidationError);
});

test("the shipped endpoint lists cannot be changed by a consumer", () => {
  // `readonly` is compile-time only, and a push from JS would change what every
  // existing and future client reports.
  assert.throws(() => (CURATED_ENDPOINTS as CuratedEndpoint[]).push({ ...CURATED_ENDPOINTS[0]! }), TypeError);
  assert.throws(() => (REGISTRY_CHECKS as RegistryCheck[]).push({ ...REGISTRY_CHECKS[0]! }), TypeError);
  assert.throws(() => {
    (CURATED_ENDPOINTS[0] as CuratedEndpoint).working = false;
  }, TypeError);
});

test("endpoints source registry leaves out the curated list; source curated makes no request", async () => {
  const lists = { curatedEndpoints: [curated("Stadt Neu", "https://ris.neu.example/oparl/system")] };
  const registryOnly = client(registryTable, lists);
  assert.deepEqual((await registryOnly.c.endpoints({ source: "registry" })).map((e) => e.source), ["registry", "registry", "registry"]);

  const curatedOnly = client(registryTable, lists);
  assert.deepEqual((await curatedOnly.c.endpoints({ source: "curated" })).map((e) => e.title), ["Stadt Neu"]);
  assert.equal(curatedOnly.mt.calls.length, 0);

  await assert.rejects(() => curatedOnly.c.endpoints({ source: "everything" as "all" }), OparlValidationError);
});

test("endpointKey ignores host case, a default port and a trailing slash, but keeps the scheme", () => {
  assert.equal(endpointKey("https://RIS.Example.org:443/oparl/system/"), endpointKey("https://ris.example.org/oparl/system"));
  assert.notEqual(endpointKey("https://ris.example.org:8443/oparl/system"), endpointKey("https://ris.example.org/oparl/system"));
  assert.notEqual(endpointKey("https://ris.example.org/oparl/system?body=1"), endpointKey("https://ris.example.org/oparl/system"));
  // http:// and https:// on the same host are different endpoints: the registry lists
  // both for a few councils, and they don't answer alike (Harsum, Rosbach).
  assert.notEqual(endpointKey("http://ris.example.org/oparl/system"), endpointKey("https://ris.example.org/oparl/system"));
});

test("the shipped curated list is consistent", () => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const curatedKeys = new Set<string>();
  for (const entry of CURATED_ENDPOINTS) {
    assert.match(entry.url, /^https?:\/\//, entry.title);
    assert.match(entry.checked, day, entry.title);
    assert.ok(entry.title.trim() !== "", entry.url);
    assert.equal(entry.working, entry.problem === null, `${entry.title}: working and problem disagree`);
    const key = endpointKey(entry.url);
    assert.ok(!curatedKeys.has(key), `duplicate curated URL ${entry.url}`);
    curatedKeys.add(key);
  }
  const allCheckKeys = new Set(REGISTRY_CHECKS.map((check) => endpointKey(check.url)));
  const checkKeys = new Set<string>();
  for (const check of REGISTRY_CHECKS) {
    assert.match(check.checked, day, check.url);
    const key = endpointKey(check.url);
    assert.ok(!checkKeys.has(key), `duplicate registry check ${check.url}`);
    assert.ok(!curatedKeys.has(key), `${check.url} is both a registry check and a curated entry`);
    checkKeys.add(key);
    if (check.replacedBy !== null) {
      // The new URL has to be an endpoint this package knows: a curated entry, or a
      // registry entry (a server that moved to a URL the registry lists itself).
      const target = endpointKey(check.replacedBy);
      assert.ok(curatedKeys.has(target) || allCheckKeys.has(target), `replacedBy ${check.replacedBy} is not a known endpoint`);
    }
  }
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
