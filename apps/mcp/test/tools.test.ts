// This server's tools against a mock of the ITK Rheinland OParl server (Düsseldorf) and the registry
// (live answers recorded on 2026-11-20), with the skills' traps as cases: each tool answers through
// the protocol (its structuredContent checked by the SDK against its output schema); a URL outside
// the known servers (and the registry's host) is refused before any request; licences are read
// strictly; edited old papers aren't new; meetings come sorted; the source names the requests. The
// rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/mcp/api.js";
import { limitTransport } from "../src/mcp/limiter.js";
import { listTools } from "../src/mcp/server.js";
import { DEADLINE_HINT, SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
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
  assert.equal(content["source"], DUS_SYSTEM_URL, "a URL that opens: the System");
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
  assert.equal(content["source"], "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers?modified_since=2026-11-16T00%3A00%3A00%2B00%3A00", "a URL that opens: the list as asked");
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

test("a page the call deadline stopped is named so in the answer's note, not as the request timeout", async () => {
  // A real transport, as the server runs it (the limiter passes the call's signal to each request):
  // page 1 answers, page 2 never does.
  const server = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", base);
    if (url.searchParams.get("page") === "2") return;
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/oparl/body") res.end(JSON.stringify({ id: `${base}/oparl/body`, type: "https://schema.oparl.org/1.1/Body", name: "Teststadt", paper: `${base}/oparl/papers` }));
    else if (url.pathname === "/oparl/papers") res.end(JSON.stringify({ data: [{ id: `${base}/oparl/papers/1`, type: "https://schema.oparl.org/1.1/Paper", name: "Antrag", date: "2026-11-20" }], links: { next: `${base}/oparl/papers?page=2` } }));
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const connection = await connect({ transport: { transport: limitTransport(nodeHttpTransport) }, config: { baseUrl: `http://127.0.0.1:${port}/api/endpoints`, callTimeoutMs: 400 } });
    const result = await connection.call("findPapers", { body: `http://127.0.0.1:${port}/oparl/body`, maxPages: 2 });
    await connection.close();
    const notes = ((result.structuredContent?.["notes"] ?? []) as string[]).join(" ");
    assert.equal(result.structuredContent?.["pagesRead"], 1, result.content[0]?.text);
    assert.match(notes, /Page 2 was not read: the call's time ran out/);
    assert.doesNotMatch(notes, /timed out after 30000ms/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("findMeetings' own default of two pages is capped by the server's --max-pages too", async () => {
  const mock = oparlApi();
  const connection = await connect({ transport: mock, config: { maxPages: 1 } });
  const result = await connection.call("findMeetings", { body: DUS_BODY_URL, from: "2026-11-20", to: "2026-12-31" });
  await connection.close();
  assert.equal(result.structuredContent?.["pagesRead"], 1, result.content[0]?.text);
  assert.equal(mock.calls.filter((c) => c.url.includes("/meetings")).length, 1);
});

test("papers the size cap leaves out of the pages read are reachable: nextOffset, then offset with the same arguments", async () => {
  // 150 long-titled papers on page 1 of 2: the answer can't hold them all.
  const papers = Array.from({ length: 150 }, (_, i) => ({
    id: `${DUS}/bodies/0015/papers/x/${i}`,
    type: "https://schema.oparl.org/1.1/Paper",
    name: `Vorlage ${i} ${"über die Sanierung des Theatergebäudes und die Finanzierung ".repeat(5)}`,
    reference: `X/${i}`,
    date: `2026-${String(1 + (i % 11)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
  }));
  const mock = makeMockTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/papers") && url.searchParams.get("page") === null) return jsonResponse({ data: papers, links: { next: `${DUS}/bodies/0015/papers?page=2` } });
    return oparlAnswer(request);
  });
  const connection = await connect({ transport: mock });
  const ids = new Set<string>();
  let offset: number | undefined = 0;
  let calls = 0;
  while (offset !== undefined && calls < 20) {
    const result = await connection.call("findPapers", { body: DUS_BODY_URL, limit: 200, offset });
    const content = result.structuredContent ?? {};
    assert.equal(content["status"], "ok", result.content[0]?.text);
    assert.equal(content["next"], `${DUS}/bodies/0015/papers?page=2`);
    for (const paper of content["papers"] as { id: string }[]) ids.add(paper.id);
    offset = content["nextOffset"] as number | undefined;
    calls += 1;
  }
  await connection.close();
  assert.ok(calls > 1, "the first answer was cut");
  assert.equal(ids.size, 150, "every paper of page 1 reached");
});

test("the deadline's and the size cap's advice fit every tool: each option they name is named with the tools that take it", async () => {
  const connection = await connect({ transport: { transport: (): Promise<never> => new Promise<never>(() => {}) }, config: { callTimeoutMs: 30 } });
  const stopped = (await connection.call("getObject", { url: `${DUS}/bodies/0015/papers/vo/1` })).content[0]?.text ?? "";
  await connection.close();
  assert.ok(stopped.includes(DEADLINE_HINT), stopped);
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const text of [DEADLINE_HINT, SIZE_HINT]) {
    const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 2, text);
    for (const [, options, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        assert.ok(schemas.has(tool), `no tool ${tool}: ${text}`);
        for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
      }
    }
    const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
    for (const option of ["maxPages", "limit", "offset", "next", "since", "from", "to", "query", "search"]) {
      assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools: ${text}`);
    }
  }
});

test("findEndpoints answered from the curated list alone says so in its source", async () => {
  const mock = makeMockTransport(() => jsonResponse({ message: "down" }, 500));
  const connection = await connect({ transport: mock });
  const result = await connection.call("findEndpoints", { search: "Berlin" });
  await connection.close();
  assert.equal(result.structuredContent?.["source"], "https://dev.oparl.org/api/endpoints (not read; the answer is the curated list shipped with this server)", result.content[0]?.text);
});
