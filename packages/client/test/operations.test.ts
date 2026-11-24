// The skills' use cases (operations.ts) against live answers of the ITK Rheinland server
// (Düsseldorf) and the registry, recorded on 2026-11-20 (oparl.ts), with the skills' traps as
// cases: only hosts of known servers are reached; "Open" and a bare licenseValidSince declare no
// licence; no match is not "no server"; a server that doesn't answer is an answer; deleted stubs are
// dropped, edited old papers aren't new, undated papers are kept; an ignored date filter, stamped
// change dates and an HTTP 404 for an empty window are recognised; meeting pages are read until
// one holds none of the window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OparlClient } from "../src/client.js";
import { OparlNetworkError, OparlValidationError } from "../src/errors.js";
import {
  checkEndpoint,
  findEndpoints,
  findMeetings,
  findPapers,
  getObject,
  knownHosts,
  licenceOf,
  listObjects,
  reachProblem,
  requestsOf,
} from "../src/operations.js";
import { body10, HOST } from "./fixtures.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import { DUS, DUS_BODY_URL, DUS_PAPERS, DUS_SYSTEM_URL, oparlAnswer, oparlApi, REGISTRY } from "./oparl.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";

const NOW = new Date("2026-11-20T09:00:00+01:00");
const clientOf = (mock: MockTransport) => new OparlClient({ transport: mock.transport, maxRetries: 0 });
const paths = (mock: MockTransport) => mock.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search);
/** The recorded answers, with `override` first. */
const withOverride = (override: (r: HttpRequest) => HttpResponse | undefined) => makeMockTransport((r) => override(r) ?? oparlAnswer(r));

test("only hosts of known servers are reached: the shipped lists, plus the hosts the caller configures", async () => {
  assert.ok(knownHosts().has("ris-oparl.itk-rheinland.de"));
  assert.equal(reachProblem(DUS_SYSTEM_URL), undefined);
  assert.match(reachProblem("http://169.254.169.254/latest/meta-data") ?? "", /not the host of a known OParl server/);
  assert.match(reachProblem("https://user:pw@ris-oparl.itk-rheinland.de/Oparl/system") ?? "", /user name or password/);
  assert.match(reachProblem("file:///etc/passwd") ?? "", /http/);
  assert.equal(reachProblem("http://127.0.0.1:8080/oparl/system", ["127.0.0.1:8080"]), undefined);
  assert.notEqual(reachProblem("http://127.0.0.1:9999/oparl/system", ["127.0.0.1:8080"]), undefined, "another port is another host");
  const mock = oparlApi();
  for (const run of [
    () => checkEndpoint(clientOf(mock), { url: "http://localhost:6379/" }),
    () => findPapers(clientOf(mock), { body: "https://evil.example/body" }),
    () => getObject(clientOf(mock), { url: "https://evil.example/x" }),
    () => findMeetings(clientOf(mock), { body: DUS_BODY_URL, next: "https://evil.example/page=2" }),
  ]) {
    await assert.rejects(run(), OparlValidationError);
  }
  assert.equal(mock.calls.length, 0, "refused before any request");
});

test("licences are read strictly: 'Open' and a bare licenseValidSince declare none; a licence URL or name does", () => {
  assert.deepEqual({ ...licenceOf("Open"), note: "" }, { declared: false, value: "Open", note: "" });
  assert.match(licenceOf(undefined, "2025-04-30T00:00:00+02:00").note, /licenseValidSince is set, but a date without a licence declares nothing/);
  assert.equal(licenceOf("https://creativecommons.org/licenses/by/4.0/").label, "CC BY 4.0");
  assert.equal(licenceOf("http://dcat-ap.de/def/licenses/dl-zero-de/2.0").label, "DL-DE Zero 2.0");
  assert.equal(licenceOf("https://www.govdata.de/dl-de/zero-2-0").label, "DL-DE Zero 2.0");
  assert.equal(licenceOf("CC BY-SA 4.0").label, "CC BY-SA 4.0");
  const own = licenceOf("https://opendata.bonn.de/seiten/nutzungsbedingungen");
  assert.equal(own.declared, true);
  assert.match(own.note, /own terms/);
  assert.equal(licenceOf("Nutzung nur nach Genehmigung").declared, false);
});

test("licences with a restriction are named with it, never as the looser licence; a negated licence declares none; CC0 asks no attribution", () => {
  const cases: [string, string | undefined, boolean][] = [
    ["CC BY-NC 4.0", "CC BY-NC 4.0", true],
    ["CC BY-ND 4.0", "CC BY-ND 4.0", true],
    ["CC BY-NC-SA 4.0", "CC BY-NC-SA 4.0", true],
    ["https://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC 4.0", true],
    ["https://creativecommons.org/licenses/by-nc-nd/3.0/de/", "CC BY-NC-ND 3.0", true],
    ["dl-de/by-nc-1-0", "DL-DE BY-NC 1.0", true],
    ["https://www.govdata.de/dl-de/by-nc-1-0", "DL-DE BY-NC 1.0", true],
    ["Datenlizenz Deutschland – Namensnennung – nicht kommerziell – Version 1.0", "DL-DE BY-NC 1.0", true],
    ["https://www.govdata.de/dl-de/by-2-0", "DL-DE BY 2.0", true],
    ["CC BY 4.0", "CC BY 4.0", true],
    ["https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA 4.0", true],
    ["Nicht CC BY", undefined, false],
    ["no cc-by", undefined, false],
  ];
  for (const [value, label, declared] of cases) {
    const read = licenceOf(value);
    assert.equal(read.label, label, value);
    assert.equal(read.declared, declared, value);
  }
  assert.match(licenceOf("CC BY-NC 4.0").note, /non-commercial use only/);
  assert.match(licenceOf("CC BY-ND 4.0").note, /no modified versions/);
  assert.match(licenceOf("Nicht CC BY").note, /negate/);
  assert.doesNotMatch(licenceOf("CC0").note, /with its attribution/);
  assert.doesNotMatch(licenceOf("https://www.govdata.de/dl-de/zero-2-0").note, /with its attribution/);
  assert.equal(licenceOf("Creative Commons").declared, false, "no particular licence named");
});

test("findEndpoints: a search ignores accents and ae spellings, finds a city in another entry's note, working first; the registry is the source", async () => {
  const mock = oparlApi();
  const client = clientOf(mock);
  const answer = await findEndpoints(client, { search: "düsseldorf" });
  assert.equal(answer.status, "ok");
  assert.ok(answer.endpoints.some((e) => e.url === DUS_SYSTEM_URL && e.title === "Landeshauptstadt Dusseldorf"));
  assert.deepEqual(requestsOf(answer), [REGISTRY]);
  const neuss = await findEndpoints(client, { search: "neuss" });
  assert.ok(neuss.endpoints.some((e) => e.url === DUS_SYSTEM_URL), "Neuss is named in the Düsseldorf entry's note");
  const working = answer.endpoints.map((e) => e.working);
  assert.deepEqual(working, [...working].sort((a, b) => Number(b) - Number(a)));
});

test("findEndpoints: no match is not 'no server': the answer says why and names the shared servers", async () => {
  const answer = await findEndpoints(clientOf(oparlApi()), { search: "Kleinkleckersdorf" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /does not mean there is no OParl server/);
  assert.ok((answer.sharedServers ?? []).length > 0);
  assert.ok((answer.sharedServers ?? []).every((s) => s.bodyCount > 1));
  const urls = (answer.sharedServers ?? []).map((s) => s.url);
  assert.ok(urls.includes("https://ris-oparl.itk-rheinland.de/Oparl/system"));
  assert.ok(!urls.some((u) => /politik-bei-uns|muenchen-transparent|kleineanfragen/.test(u)), "aggregators and archives are no council's server");
  assert.ok((answer.sharedServers ?? []).find((s) => s.url.startsWith(DUS))?.title.includes("(ris-oparl.itk-rheinland.de)"));
});

test("findEndpoints: a shared server listed under http and https is named once; an offset past the end is empty and says how many match", async () => {
  const empty = await findEndpoints(clientOf(oparlApi()), { search: "Kleinkleckersdorf" });
  const keys = (empty.sharedServers ?? []).map((s) => s.url.replace(/^https?:/, ""));
  assert.deepEqual(keys, [...new Set(keys)], "one entry per server");
  assert.ok((empty.sharedServers ?? []).some((s) => s.url === "https://www.hagenbach.sitzung-online.de/bi/oparl/1.0/system.asp"), "the https one kept");
  const all = await findEndpoints(clientOf(oparlApi()), { search: "düsseldorf" });
  const past = await findEndpoints(clientOf(oparlApi()), { search: "düsseldorf", offset: all.total + 5 });
  assert.equal(past.status, "empty");
  assert.equal(past.total, all.total);
  assert.match(past.reason ?? "", new RegExp(`offset ${all.total + 5} is past the end: ${all.total} endpoints? match`));
});

test("findEndpoints: a registry entry on a host the operations don't reach is marked, with a note; the caller's extra hosts count as reachable", async () => {
  const registry = makeMockTransport(() =>
    jsonResponse({
      data: [{ id: 1, title: "Stadt Neustadt", url: "https://ris.neustadt.example/oparl/system", system: { type: "https://schema.oparl.org/1.1/System", oparlVersion: "https://schema.oparl.org/1.1/", body: "https://ris.neustadt.example/oparl/bodies" } }],
      meta: { page: 1, total: 1, totalPages: 1 },
    }),
  );
  const answer = await findEndpoints(clientOf(registry), { search: "Neustadt" });
  const hit = answer.endpoints.find((e) => e.url === "https://ris.neustadt.example/oparl/system");
  assert.equal(hit?.reachable, false);
  assert.match(answer.notes.join(" "), /reachable false: .*not on the hosts .* checkEndpoint .* can't reach/);
  const own = await findEndpoints(clientOf(registry), { search: "Neustadt", extraHosts: ["ris.neustadt.example"] });
  assert.equal(own.endpoints.find((e) => e.url === "https://ris.neustadt.example/oparl/system")?.reachable, undefined);
  const known = await findEndpoints(clientOf(oparlApi()), { search: "düsseldorf" });
  assert.ok(known.endpoints.every((e) => e.reachable === undefined), "known servers carry no mark");
});

test("findEndpoints: a registry that can't be read leaves the curated list, with a note to say so", async () => {
  const mock = withOverride((r) => (new URL(r.url).pathname === "/api/endpoints" ? jsonResponse({ message: "down" }, 500) : undefined));
  const answer = await findEndpoints(clientOf(mock), { search: "Berlin" });
  assert.ok(answer.endpoints.length > 0);
  assert.ok(answer.endpoints.every((e) => e.source === "curated"));
  assert.match(answer.notes.join(" "), /registry could not be read/);
});

test("checkEndpoint: Düsseldorf answers; System 'Open' and the Bodies' bare licenseValidSince declare no licence; each body's lists, plural fallbacks included; two requests", async () => {
  const mock = oparlApi();
  const answer = await checkEndpoint(clientOf(mock), { url: DUS_SYSTEM_URL });
  assert.equal(answer.live, true);
  assert.equal(answer.system?.oparlVersion, "1.1");
  assert.equal(answer.system?.licence.declared, false);
  assert.equal(answer.system?.licence.value, "Open");
  assert.deepEqual(answer.bodies.map((b) => b.name), ["Stadt Neuss", "Stadt Duesseldorf"]);
  const dus = answer.bodies[1];
  assert.equal(dus?.id, DUS_BODY_URL);
  assert.equal(dus?.licence.declared, false);
  assert.match(dus?.licence.note ?? "", /licenseValidSince/);
  assert.ok(dus?.lists.includes("consultation") && dus.lists.includes("file") && dus.lists.includes("legislative-term"));
  assert.equal(answer.known?.working, true);
  assert.deepEqual(paths(mock), ["/Oparl/system", "/Oparl/bodies"]);
  assert.match(answer.notes.join(" "), /shared server/);
});

test("checkEndpoint: a server that doesn't answer is an answer (live false), with what it means", async () => {
  const cases: [HttpResponse | Error, RegExp][] = [
    [jsonResponse({ message: "gone" }, 404), /moved or is gone/],
    [jsonResponse({ message: "boom" }, 502), /up but failing/],
    [jsonResponse({ id: DUS_SYSTEM_URL, type: "https://schema.oparl.org/1.1/System", oparlVersion: "https://schema.oparl.org/1.1/", body: null }), /server-side defect/],
    [jsonResponse({ id: "x" }), /No OParl System there/],
    [new OparlNetworkError("Request timed out after 30000 ms"), /slow or down/],
    [new OparlNetworkError("unable to verify the first certificate"), /intermediate TLS certificate/],
  ];
  for (const [answer, advice] of cases) {
    const mock = makeMockTransport(() => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const result = await checkEndpoint(clientOf(mock), { url: DUS_SYSTEM_URL });
    assert.equal(result.live, false, String(advice));
    assert.match(result.advice ?? "", advice);
    assert.ok(result.problem !== undefined);
  }
});

test("checkEndpoint on a Body, a paper or a list page of a working server: the server answers (live), the URL is not its System, and the advice says which to pass", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ id: DUS_BODY_URL, type: "https://schema.oparl.org/1.1/Body", system: DUS_SYSTEM_URL }, /an OParl Body, not the server's System/],
    [{ id: `${DUS}/p/1`, type: "https://schema.oparl.org/1.1/Paper" }, /an OParl Paper, not the server's System/],
    [{ data: [], links: {} }, /a page of a list, not the server's System/],
  ];
  for (const [object, problem] of cases) {
    const answer = await checkEndpoint(clientOf(makeMockTransport(() => jsonResponse(object))), { url: DUS_BODY_URL });
    assert.equal(answer.live, true, String(problem));
    assert.match(answer.problem ?? "", problem);
    assert.match(answer.advice ?? "", /The server answers/);
    assert.doesNotMatch(`${answer.problem} ${answer.advice}`, /gone|oparl endpoints/);
    assert.deepEqual(answer.bodies, []);
  }
  const body = await checkEndpoint(clientOf(makeMockTransport(() => jsonResponse(cases[0]![0]))), { url: DUS_BODY_URL });
  assert.match(body.advice ?? "", new RegExp(`its System: ${DUS_SYSTEM_URL.replace(/[.?]/g, "\\$&")}`));
  assert.match(body.advice ?? "", /findPapers, findMeetings or listObjects/);
});

test("findPapers since a day: deleted stubs dropped, old papers only edited aren't new, newest first; the filter honoured", async () => {
  const mock = oparlApi();
  const answer = await findPapers(clientOf(mock), { body: DUS_BODY_URL, since: "2026-11-16", now: NOW });
  assert.equal(answer.status, "ok");
  assert.equal(answer.counts.deleted, 2);
  assert.equal(answer.dateFilter, "honoured");
  assert.ok(answer.papers.every((p) => p.new === true && (p.date ?? "") >= "2026-11-16"));
  assert.ok(!answer.papers.some((p) => p.reference === "ABA/039/2026"), "dated 2026-09-07, only edited since");
  assert.equal(answer.counts.editedOnly, 6);
  assert.equal(answer.papers[0]?.reference, "AUS/041/2026");
  assert.equal(answer.body.name, "Stadt Duesseldorf");
  assert.equal(answer.body.licence?.declared, false);
  assert.match(answer.notes.join(" "), /6 older papers were only edited/);
  assert.equal(new URL(mock.calls[1]?.url ?? "").searchParams.get("modified_since"), "2026-11-16T00:00:00+00:00");
  assert.deepEqual(requestsOf(answer), mock.calls.map((c) => c.url), "the source names the requests as sent");
  const changed = await findPapers(clientOf(oparlApi()), { body: DUS_BODY_URL, since: "2026-11-16", only: "changed", now: NOW });
  assert.equal(changed.total, answer.total + 6);
  assert.ok(changed.papers.some((p) => p.reference === "ABA/039/2026" && p.new === false));
});

test("findPapers: words and a paper type are matched here (no full-text search in OParl), and the pages searched are named", async () => {
  const answer = await findPapers(clientOf(oparlApi()), { body: DUS_BODY_URL, since: "2026-11-16", only: "changed", query: "haushaltsantrag linke", now: NOW });
  assert.deepEqual(answer.papers.map((p) => p.reference), ["AUS/041/2026"]);
  const motions = await findPapers(clientOf(oparlApi()), { body: DUS_BODY_URL, since: "2026-11-16", paperType: "antrag", now: NOW });
  assert.ok(motions.papers.length > 0 && motions.papers.every((p) => /antrag/i.test(p.paperType ?? "")));
  assert.match(motions.notes.join(" "), /no full-text search: titles were searched here, over 1 page/);
  const none = await findPapers(clientOf(oparlApi()), { body: DUS_BODY_URL, query: "Theatergebäude", now: NOW });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /page\(s\) read/);
});

test("findPapers: a server that ignores the date filter is named, and the old papers are filtered here", async () => {
  const stale = { id: `${DUS}/bodies/0015/papers/vo/1`, type: "https://schema.oparl.org/1.1/Paper", name: "Alt", reference: "ALT/1/2025", date: "2025-01-10", modified: "2025-01-12T10:00:00+01:00" };
  const mock = withOverride((r) => (new URL(r.url).pathname.endsWith("/papers") ? jsonResponse({ ...DUS_PAPERS, data: [...DUS_PAPERS.data, stale] }) : undefined));
  const answer = await findPapers(clientOf(mock), { body: DUS_BODY_URL, since: "2026-11-16", only: "changed", now: NOW });
  assert.equal(answer.dateFilter, "ignored");
  assert.ok(!answer.papers.some((p) => p.reference === "ALT/1/2025"));
  assert.match(answer.notes.join(" "), /ignored the date filter \(1 papers modified before 2026-11-16/);
});

test("findPapers: change dates all stamped today (more! rubin) are unusable: the paper's date decides", async () => {
  const stamped = DUS_PAPERS.data.map((p) => ({ ...p, created: "2026-11-20T03:00:00+01:00", modified: "2026-11-20T03:00:00+01:00" }));
  const mock = withOverride((r) => (new URL(r.url).pathname.endsWith("/papers") ? jsonResponse({ ...DUS_PAPERS, data: stamped }) : undefined));
  const answer = await findPapers(clientOf(mock), { body: DUS_BODY_URL, since: "2026-11-16", only: "changed", now: NOW });
  assert.equal(answer.dateFilter, "unusable");
  assert.ok(!answer.papers.some((p) => p.reference === "ABA/039/2026"), "dated 2026-09-07: not new, whatever modified says");
  assert.match(answer.notes.join(" "), /stamps them/);
});

test("findPapers: papers without a date (ALLRIS 1.0) fall back to created, and without either are kept with new null", async () => {
  const papers = [
    { id: `${DUS}/p/1`, type: "https://schema.oparl.org/1.0/Paper", name: "Ohne Datum, neu angelegt", created: "2026-11-17T10:00:00+01:00", modified: "2026-11-17T10:00:00+01:00" },
    { id: `${DUS}/p/2`, type: "https://schema.oparl.org/1.0/Paper", name: "Ohne jedes Datum", modified: "2026-11-18T10:00:00+01:00" },
    { id: `${DUS}/p/3`, type: "https://schema.oparl.org/1.0/Paper", name: "Datiert", date: "2026-11-18", modified: "2026-11-18T10:00:00+01:00" },
  ];
  const mock = withOverride((r) => (new URL(r.url).pathname.endsWith("/papers") ? jsonResponse({ data: papers, links: {} }) : undefined));
  const answer = await findPapers(clientOf(mock), { body: DUS_BODY_URL, since: "2026-11-16", now: NOW });
  assert.equal(answer.total, 3, "none dropped");
  assert.equal(answer.counts.undated, 2);
  assert.equal(answer.papers.find((p) => p.name === "Ohne Datum, neu angelegt")?.new, true);
  assert.equal(answer.papers.find((p) => p.name === "Ohne jedes Datum")?.new, null);
  assert.match(answer.notes.join(" "), /never drop them/);
});

test("findPapers: an HTTP 404 for the window (SD.NET RIM) is an empty window when the list answers without the filter, else the error", async () => {
  const sdnet = (unfiltered: HttpResponse) =>
    withOverride((r) => {
      const url = new URL(r.url);
      if (!url.pathname.endsWith("/papers")) return undefined;
      return url.searchParams.has("modified_since") ? jsonResponse({ message: "Die angeforderte Ressource wurde nicht gefunden." }, 404) : unfiltered;
    });
  const empty = await findPapers(clientOf(sdnet(jsonResponse(DUS_PAPERS))), { body: DUS_BODY_URL, since: "2026-11-19", now: NOW });
  assert.equal(empty.status, "empty");
  assert.equal(empty.dateFilter, "emptyWindow");
  assert.match(empty.reason ?? "", /No papers changed since 2026-11-19: .*HTTP 404/);
  await assert.rejects(findPapers(clientOf(sdnet(jsonResponse({ message: "nope" }, 404))), { body: DUS_BODY_URL, since: "2026-11-19", now: NOW }), /404/);
});

test("findPapers: a later page failing keeps the pages before it, says the list is incomplete, next at the page that failed", async () => {
  const page1 = { ...DUS_PAPERS, links: { next: `${DUS}/bodies/0015/papers?page=2` } };
  const mock = withOverride((r) => {
    const url = new URL(r.url);
    if (!url.pathname.endsWith("/papers")) return undefined;
    return url.searchParams.get("page") === "2" ? jsonResponse({ message: "boom" }, 500) : jsonResponse(page1);
  });
  const answer = await findPapers(clientOf(mock), { body: DUS_BODY_URL, since: "2026-11-16", maxPages: 2, now: NOW });
  assert.ok(answer.papers.length > 0);
  assert.match(answer.notes.join(" "), /Page 2 failed .*incomplete/);
  assert.match(answer.next ?? "", /page=2/);
});

test("a page the caller's deadline stopped is named so in the note, not as a request timeout", async () => {
  const page1 = { ...DUS_PAPERS, links: { next: `${DUS}/bodies/0015/papers?page=2` } };
  const meetings1 = { data: [{ id: `${DUS}/m/1`, type: "https://schema.oparl.org/1.1/Meeting", name: "Rat", start: "2026-11-25T10:00:00+01:00" }], links: { next: `${DUS}/bodies/0015/meetings?page=2` } };
  const run = async (call: (client: OparlClient, signal: AbortSignal) => Promise<{ notes: string[]; next: string | null }>) => {
    const deadline = new AbortController();
    const mock = withOverride((r) => {
      const url = new URL(r.url);
      if (url.searchParams.get("page") === "2") {
        deadline.abort();
        throw new OparlNetworkError("Request aborted by its caller before it finished");
      }
      if (url.pathname.endsWith("/papers")) return jsonResponse(page1);
      if (url.pathname.endsWith("/meetings")) return jsonResponse(meetings1);
      return undefined;
    });
    const answer = await call(clientOf(mock), deadline.signal);
    assert.match(answer.notes.join(" "), /Page 2 was not read: the call's time ran out \(or it was cancelled\) first/);
    assert.doesNotMatch(answer.notes.join(" "), /failed \(/);
    assert.match(answer.next ?? "", /page=2/);
  };
  await run((client, signal) => findPapers(client, { body: DUS_BODY_URL, maxPages: 2, signal, now: NOW }));
  await run((client, signal) => findMeetings(client, { body: DUS_BODY_URL, maxPages: 2, signal, now: NOW }));
  await run((client, signal) => listObjects(client, { body: DUS_BODY_URL, type: "paper", maxPages: 2, signal }));
});

test("findMeetings: upcoming by default, pages read until one has none from today on (page 4 never asked), soonest first", async () => {
  const mock = oparlApi();
  const answer = await findMeetings(clientOf(mock), { body: DUS_BODY_URL, maxPages: 5, now: NOW });
  assert.deepEqual(paths(mock), ["/Oparl/bodies/0015", "/Oparl/bodies/0015/meetings", "/Oparl/bodies/0015/meetings?page=2", "/Oparl/bodies/0015/meetings?page=3"]);
  assert.equal(answer.complete, true);
  assert.equal(answer.searched["from"], "2026-11-20");
  const starts = answer.meetings.map((m) => m.start);
  assert.deepEqual(starts, [...starts].sort());
  assert.ok(starts.every((s) => s >= "2026-11-20"));
  assert.equal(answer.meetings[0]?.name, "Ausschuss für Chancengerechtigkeit und Integration");
  assert.match(answer.notes.join(" "), /Read 3 page\(s\), up to the first with no meeting of the window/);
});

test("findMeetings: a bounded window reads maxPages pages and says more could hold some; next goes on", async () => {
  const mock = oparlApi();
  const answer = await findMeetings(clientOf(mock), { body: DUS_BODY_URL, from: "2026-11-20", to: "2026-11-30", maxPages: 2, now: NOW });
  assert.equal(answer.complete, false);
  assert.equal(answer.next, `${DUS}/bodies/0015/meetings?page=3`);
  assert.ok(answer.meetings.every((m) => m.start.slice(0, 10) <= "2026-11-30"));
  const on = await findMeetings(clientOf(mock), { body: DUS_BODY_URL, from: "2026-11-20", to: "2026-11-30", next: answer.next ?? "" });
  assert.equal(on.pagesRead, 1);
  await assert.rejects(findMeetings(clientOf(mock), { body: DUS_BODY_URL, from: "2026-11-30", to: "2026-11-01" }), /from is after to/);
});

test("listObjects: a 1.0 body's embedded legislative terms; embedded objects named, not inlined; a missing list names those there are", async () => {
  const mock = makeMockTransport((r) => (r.url === body10.id ? jsonResponse(body10) : jsonResponse({}, 404)));
  const client = clientOf(mock);
  const extraHosts = [new URL(HOST).host];
  const terms = await listObjects(client, { body: body10.id, type: "legislative-term", extraHosts });
  assert.equal(terms.total, 1);
  assert.equal(terms.pagesRead, 0);
  await assert.rejects(listObjects(client, { body: body10.id, type: "file", extraHosts }), /has no file list\. It links: organization, person, meeting, paper/);
  const embedded = await listObjects(clientOf(oparlApi()), { body: DUS_BODY_URL, type: "meeting" });
  const first = embedded.objects[0] ?? {};
  assert.deepEqual(first["embedded"], ["location"]);
  assert.equal(first["location"], undefined);
});

test("getObject: a paper as the server sends it; a 404 is empty and says where URLs come from", async () => {
  const paper = DUS_PAPERS.data.find((p) => p.reference === "AUS/041/2026");
  const found = await getObject(clientOf(oparlApi()), { url: paper?.id ?? "" });
  assert.equal(found.kind, "Paper");
  assert.equal(found.object?.["reference"], "AUS/041/2026");
  const missing = await getObject(clientOf(oparlApi()), { url: `${DUS}/bodies/0015/papers/vo/0` });
  assert.equal(missing.status, "empty");
  assert.match(missing.reason ?? "", /never build one/);
});
