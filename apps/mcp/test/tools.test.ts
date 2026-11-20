// This server's tools against a mock of the ITK Rheinland OParl server (Düsseldorf) and the registry
// (live answers recorded on 2026-11-20), with the skills' traps as cases: each tool answers through
// the protocol (its structuredContent checked by the SDK against its output schema); a URL outside
// the known servers (and the registry's host) is refused before any request; licences are read
// strictly; edited old papers aren't new; meetings come sorted; the source names the requests. The
// rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { DUS, DUS_BODY_URL, DUS_PAPERS, DUS_SYSTEM_URL, jsonResponse, makeMockTransport, oparlAnswer, oparlApi } from "./helpers.js";

test("six tools: the use cases first, then the generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findEndpoints", "checkEndpoint", "findPapers", "findMeetings", "listObjects", "getObject"]);
});

test("findEndpoints: Düsseldorf by its spelling with ü, from the registry, which is the source", async () => {
  const connection = await connect({ transport: oparlApi() });
  const result = await connection.call("findEndpoints", { search: "Düsseldorf" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.ok((content["endpoints"] as { url: string }[]).some((e) => e.url === DUS_SYSTEM_URL));
  assert.equal(content["source"], "https://dev.oparl.org/api/endpoints");
  assert.match(String(content["licence"]), /^Per server/);
  await connection.close();
});

test("checkEndpoint: live, a shared server's bodies with their lists; 'Open' and a bare licenseValidSince declare no licence; the source names both requests", async () => {
  const connection = await connect({ transport: oparlApi() });
  const result = await connection.call("checkEndpoint", { url: DUS_SYSTEM_URL });
  const content = result.structuredContent ?? {};
  assert.equal(content["live"], true, result.content[0]?.text);
  assert.equal((content["system"] as { licence: { declared: boolean } }).licence.declared, false);
  const bodies = content["bodies"] as { id: string; licence: { declared: boolean }; lists: string[] }[];
  assert.deepEqual(bodies.map((b) => b.id), [`${DUS}/bodies/0009`, DUS_BODY_URL]);
  assert.ok(bodies.every((b) => !b.licence.declared && b.lists.includes("paper")));
  assert.equal(content["source"], "https://ris-oparl.itk-rheinland.de{/Oparl/system,/Oparl/bodies}");
  await connection.close();
});

test("a URL off the known servers is refused before any request: no address of the caller's choosing", async () => {
  const mock = oparlApi();
  const connection = await connect({ transport: mock });
  for (const [name, args] of [
    ["getObject", { url: "http://169.254.169.254/latest/meta-data/" }],
    ["checkEndpoint", { url: "http://localhost:6379/" }],
    ["findPapers", { body: "https://intranet.example/oparl/body/1" }],
    ["findMeetings", { body: DUS_BODY_URL, next: "https://evil.example/meetings?page=2" }],
    ["listObjects", { body: "http://10.0.0.1/oparl/body", type: "person" }],
  ] as const) {
    const result = await connection.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.content[0]?.text ?? "", /not the host of a known OParl server|not on the body's server/, name);
  }
  assert.equal(mock.calls.length, 0);
  await connection.close();
});

test("the host of --base-url (the registry) is reachable too, and only that one", async () => {
  const mock = makeMockTransport((request) => (new URL(request.url).pathname === "/oparl/system" ? oparlAnswer({ ...request, url: DUS_SYSTEM_URL }) : jsonResponse({}, 404)));
  const connection = await connect({ transport: mock, config: { baseUrl: "http://127.0.0.1:8080/api/endpoints" } });
  const own = await connection.call("getObject", { url: "http://127.0.0.1:8080/oparl/system" });
  assert.equal(own.structuredContent?.["kind"], "System", own.content[0]?.text);
  const other = await connection.call("getObject", { url: "http://127.0.0.1:8081/oparl/system" });
  assert.equal(other.isError, true);
  await connection.close();
});

test("findPapers since a day: new papers only (edited old ones counted apart), deleted stubs dropped, the filter honoured", async () => {
  const connection = await connect({ transport: oparlApi() });
  const result = await connection.call("findPapers", { body: DUS_BODY_URL, since: "2026-11-16" });
  const content = result.structuredContent ?? {};
  assert.equal(content["dateFilter"], "honoured", result.content[0]?.text);
  assert.deepEqual(content["counts"], { fetched: 14, deleted: 2, editedOnly: 6, undated: 0 });
  const papers = content["papers"] as { reference: string; new: boolean }[];
  assert.equal(papers[0]?.reference, "AUS/041/2026");
  assert.ok(papers.every((p) => p.new));
  assert.equal(content["source"], "https://ris-oparl.itk-rheinland.de{/Oparl/bodies/0015,/Oparl/bodies/0015/papers?modified_since=2026-11-16T00%3A00%3A00%2B00%3A00}");
  assert.equal((content["body"] as { name: string }).name, "Stadt Duesseldorf");
  await connection.close();
});

test("findMeetings: a window, soonest first; the server's --max-pages caps the pages a call reads", async () => {
  const mock = oparlApi();
  const connection = await connect({ transport: mock, config: { maxPages: 1 } });
  const result = await connection.call("findMeetings", { body: DUS_BODY_URL, from: "2026-11-20", to: "2026-11-30", maxPages: 5 });
  const content = result.structuredContent ?? {};
  assert.equal(content["pagesRead"], 1, result.content[0]?.text);
  assert.equal(content["complete"], false);
  assert.equal(content["next"], `${DUS}/bodies/0015/meetings?page=2`);
  const starts = (content["meetings"] as { start: string }[]).map((m) => m.start);
  assert.deepEqual(starts, [...starts].sort());
  await connection.close();
});

test("listObjects and getObject: a list with embedded objects named, one paper in full; a 404 is empty, not an error", async () => {
  const connection = await connect({ transport: oparlApi() });
  const listed = await connection.call("listObjects", { body: DUS_BODY_URL, type: "meeting", query: "bezirksvertretung" });
  const objects = listed.structuredContent?.["objects"] as Record<string, unknown>[];
  assert.deepEqual(objects.map((o) => o["name"]), ["Bezirksvertretung 1", "Bezirksvertretung 4"], listed.content[0]?.text);
  assert.ok(objects.every((o) => o["location"] === undefined && (o["embedded"] as string[]).includes("location")));
  const paper = DUS_PAPERS.data.find((p) => p.reference === "AUS/041/2026");
  const found = await connection.call("getObject", { url: paper?.id ?? "" });
  assert.equal((found.structuredContent?.["object"] as { reference: string }).reference, "AUS/041/2026");
  assert.equal(found.structuredContent?.["source"], paper?.id);
  const missing = await connection.call("getObject", { url: `${DUS}/bodies/0015/papers/vo/0` });
  assert.equal(missing.structuredContent?.["status"], "empty");
  await connection.close();
});
