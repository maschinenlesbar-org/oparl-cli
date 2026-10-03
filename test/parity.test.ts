// CLI <-> library parity: the same input through `run()` and through the library call
// the CLI wraps must give the same outcome — both reject before any request, or both
// send the same requests and return the same result. See the 2026-10-03 parity report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OparlClient, type OparlClientOptions } from "../src/client/client.js";
import { OparlApiError, OparlError, OparlNetworkError, OparlValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import type { RegistryEntry } from "../src/client/types.js";
import { jsonResponse, makeMockTransport, parity, routes } from "./helpers.js";
import * as fx from "./fixtures.js";

/** No shipped lists, so the results hold only what the fixtures serve. */
const noLists: Partial<OparlClientOptions> = { curatedEndpoints: [], registryChecks: [] };

const libClient = (transport: Transport, options: Partial<OparlClientOptions> = {}) =>
  new OparlClient({ ...noLists, ...options, transport });

const registrySite = routes({
  [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse({
    data: [
      { title: "Stadt Köln", url: "https://ris.koeln.example/oparl/system", system: { ...fx.system, oparlVersion: "https://schema.oparl.org/1.0/" } },
      { title: "Stadt Düsseldorf", url: "https://ris.duesseldorf.example/oparl/system", system: fx.system },
      { title: "Gemeinde Aue", url: "https://aue.example/oparl/system", system: [] },
    ],
    meta: {},
  }),
});
const registryResponder = (req: Parameters<Transport>[0]) => registrySite.transport(req);

const titles = (value: unknown) => (value as RegistryEntry[]).map((e) => e.title);

// Finding #1 (PAT-18): endpoints search / OParl version / working filters.
test("parity: endpoints --search, --oparl-version and --working filter alike in the library", async () => {
  const cases: Array<[string[], { search?: string; oparlVersion?: string; working?: boolean }]> = [
    [["--search", "koeln"], { search: "koeln" }],
    [["--search", "duesseldorf"], { search: "duesseldorf" }],
    [["--oparl-version", "https://schema.oparl.org/1.1/"], { oparlVersion: "https://schema.oparl.org/1.1/" }],
    [["--oparl-version", " 1.0 "], { oparlVersion: " 1.0 " }],
    [["--working"], { working: true }],
    [["--search", "stadt", "--oparl-version", "1.1", "--working"], { search: "stadt", oparlVersion: "1.1", working: true }],
  ];
  for (const [flags, filters] of cases) {
    const { cli, lib } = await parity(
      ["--compact", "endpoints", "--registry-url", fx.REGISTRY_URL, "--source", "registry", ...flags],
      (transport) => libClient(transport, { registryUrl: fx.REGISTRY_URL }).endpoints({ source: "registry", ...filters }),
      registryResponder,
      noLists,
    );
    assert.equal(cli.code, 0, flags.join(" "));
    assert.equal(lib.ok, true, flags.join(" "));
    assert.deepEqual(JSON.parse(cli.out), lib.value, flags.join(" "));
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url), flags.join(" "));
  }
  // The filters do select something: one city, not the whole register.
  const { lib } = await parity(
    ["--compact", "endpoints", "--registry-url", fx.REGISTRY_URL, "--search", "koeln"],
    (transport) => libClient(transport, { registryUrl: fx.REGISTRY_URL }).endpoints({ search: "koeln" }),
    registryResponder,
    noLists,
  );
  assert.deepEqual(titles(lib.value), ["Stadt Köln"]);
});

test("parity: a blank endpoints search or a bad OParl version is rejected before any request", async () => {
  const cases: Array<[string[], { search?: string; oparlVersion?: string }]> = [
    [["--search", "  "], { search: "  " }],
    [["--search", ""], { search: "" }],
    [["--oparl-version", "2"], { oparlVersion: "2" }],
    [["--oparl-version", "v1.1"], { oparlVersion: "v1.1" }],
  ];
  for (const [flags, filters] of cases) {
    const { cli, lib } = await parity(
      ["endpoints", "--registry-url", fx.REGISTRY_URL, ...flags],
      (transport) => libClient(transport, { registryUrl: fx.REGISTRY_URL }).endpoints(filters),
      registryResponder,
      noLists,
    );
    assert.equal(cli.code, 2, flags.join(" "));
    assert.equal(cli.requests.length, 0, flags.join(" "));
    assert.equal(lib.ok, false, flags.join(" "));
    assert.ok(lib.error instanceof OparlValidationError, flags.join(" "));
    assert.equal(lib.requests.length, 0, flags.join(" "));
  }
});

const bodySite = routes({
  [fx.BODY_URL]: jsonResponse(fx.body),
  [fx.MEETINGS_URL]: jsonResponse(fx.meetingPages[1]),
});
const bodyResponder = (req: Parameters<Transport>[0]) => bodySite.transport(req);

// Finding #3 (PAT-11): the list page size is an integer from 1 to MAX_LIST_LIMIT.
test("parity: list rejects a page size outside 1..1000 before any request", async () => {
  const cases: Array<[string, number]> = [
    ["0", 0],
    ["-1", -1],
    ["1.5", 1.5],
    ["1001", 1001],
    ["NaN", Number.NaN],
    ["1e20", 1e20],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  for (const [flag, limit] of cases) {
    const { cli, lib } = await parity(
      ["list", "meeting", fx.BODY_URL, "--limit", flag],
      (transport) => libClient(transport).list(fx.BODY_URL, "meeting", { limit }),
      bodyResponder,
    );
    assert.equal(cli.code, 2, flag);
    assert.equal(cli.requests.length, 0, flag);
    assert.equal(lib.ok, false, flag);
    assert.ok(lib.error instanceof OparlValidationError, flag);
    assert.equal(lib.requests.length, 0, flag);
  }
});

test("parity: list sends a page size inside 1..1000 alike", async () => {
  for (const limit of [1, 2, 1000]) {
    const { cli, lib } = await parity(
      ["--compact", "list", "meeting", fx.BODY_URL, "--limit", String(limit)],
      (transport) => libClient(transport).list(fx.BODY_URL, "meeting", { limit }),
      bodyResponder,
    );
    assert.equal(cli.code, 0, String(limit));
    assert.equal(lib.ok, true, String(limit));
    assert.deepEqual(JSON.parse(cli.out), lib.value);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
  }
});

// Finding #9 (PAT-11): maxPages is checked before the first request, on every path.
test("parity: bodies and list reject a bad maxPages before any request", async () => {
  const site = routes({
    [fx.SYSTEM_URL]: jsonResponse(fx.system),
    [fx.BODIES_URL]: jsonResponse(fx.bodyList),
    [fx.BODY_URL]: jsonResponse(fx.body),
    [fx.body10.id]: jsonResponse(fx.body10),
    [fx.MEETINGS_URL]: jsonResponse(fx.meetingPages[1]),
  });
  const responder = (req: Parameters<Transport>[0]) => site.transport(req);
  const cases: Array<[string[], (t: Transport, maxPages: number) => Promise<unknown>]> = [
    [["bodies", fx.SYSTEM_URL], (t, maxPages) => libClient(t).bodies(fx.SYSTEM_URL, { maxPages })],
    [["list", "meeting", fx.BODY_URL], (t, maxPages) => libClient(t).list(fx.BODY_URL, "meeting", { maxPages })],
    // An OParl 1.0 body embeds its terms: no list walk, so walk() never checked maxPages.
    [["list", "legislative-term", fx.body10.id], (t, maxPages) => libClient(t).list(fx.body10.id, "legislative-term", { maxPages })],
  ];
  for (const [argv, call] of cases) {
    for (const [flag, maxPages] of [["-1", -1], ["1.5", 1.5], ["NaN", Number.NaN]] as const) {
      const label = `${argv.join(" ")} --max-pages ${flag}`;
      const { cli, lib } = await parity([...argv, "--max-pages", flag], (t) => call(t, maxPages), responder);
      assert.equal(cli.code, 2, label);
      assert.equal(cli.requests.length, 0, label);
      assert.equal(lib.ok, false, label);
      assert.ok(lib.error instanceof OparlValidationError, label);
      assert.equal((lib.error as Error).message, "Invalid maxPages: Expected a non-negative integer.", label);
      assert.equal(lib.requests.length, 0, label);
    }
  }
});

// Finding #4 (PAT-8): the engine's numeric options are range-checked by the library.
test("parity: a bad timeout, retry, redirect or size option is rejected before any request", async () => {
  const cases: Array<[string, keyof OparlClientOptions, Array<[string, number]>]> = [
    ["--timeout", "timeoutMs", [["-1", -1], ["1.5", 1.5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]]],
    ["--max-retries", "maxRetries", [["-1", -1], ["1.5", 1.5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["11", 11]]],
    ["--max-redirects", "maxRedirects", [["-1", -1], ["1.5", 1.5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["11", 11]]],
    ["--max-response-bytes", "maxResponseBytes", [["-1", -1], ["1.5", 1.5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]]],
  ];
  for (const [flag, option, values] of cases) {
    for (const [text, value] of values) {
      const label = `${flag} ${text}`;
      const { cli, lib } = await parity(
        [`${flag}=${text}`, "get", fx.SYSTEM_URL],
        (transport) => libClient(transport, { [option]: value }).get(fx.SYSTEM_URL),
        () => jsonResponse(fx.system),
      );
      assert.equal(cli.code, 2, label);
      assert.equal(cli.requests.length, 0, label);
      assert.equal(lib.ok, false, label);
      assert.ok(lib.error instanceof OparlValidationError, label);
      assert.match((lib.error as Error).message, new RegExp(`^Invalid ${option}: `), label);
      assert.equal(lib.requests.length, 0, label);
    }
  }
});

test("parity: in-range engine options reach the transport alike", async () => {
  for (const [flag, option, value] of [
    ["--timeout", "timeoutMs", 0],
    ["--max-retries", "maxRetries", 10],
    ["--max-redirects", "maxRedirects", 10],
    ["--max-response-bytes", "maxResponseBytes", 0],
  ] as const) {
    const { cli, lib } = await parity(
      ["--compact", `${flag}=${value}`, "get", fx.SYSTEM_URL],
      (transport) => libClient(transport, { [option]: value }).get(fx.SYSTEM_URL),
      () => jsonResponse(fx.system),
    );
    assert.equal(cli.code, 0, flag);
    assert.equal(lib.ok, true, flag);
    assert.deepEqual(cli.requests, lib.requests, flag);
  }
});

// Finding #8 (PAT-1): registryUrl is checked when the client is made, not on first use.
test("parity: a bad registry URL is rejected even when the registry is not asked", async () => {
  for (const registryUrl of ["ftp://reg.example/x", "", "   ", "not a url"]) {
    const { cli, lib } = await parity(
      ["endpoints", "--registry-url", registryUrl, "--source", "curated"],
      (transport) => libClient(transport, { registryUrl }).endpoints({ source: "curated" }),
      registryResponder,
      noLists,
    );
    assert.equal(cli.code, 2, JSON.stringify(registryUrl));
    assert.equal(lib.ok, false, JSON.stringify(registryUrl));
    assert.ok(lib.error instanceof OparlValidationError, JSON.stringify(registryUrl));
    assert.match((lib.error as Error).message, /^Invalid registryUrl: /, JSON.stringify(registryUrl));
    assert.equal(cli.requests.length + lib.requests.length, 0, JSON.stringify(registryUrl));
  }
});

// Finding #5 (PAT-16): the library drops user:password@ from caller URLs, in the request
// and in every message it builds itself.
test("parity: a URL's credentials never reach the library's error messages", async () => {
  const secret = "https://alice:pw123@x.example/oparl/v1/system";
  const clean = "https://x.example/oparl/v1/system";
  const answers: Record<string, unknown> = {
    body: fx.body,
    system: fx.system,
    array: [1, 2],
    errorObject: { error: "nope" },
  };
  const cases: Array<[string[], string, (t: Transport) => Promise<unknown>]> = [
    [["system", secret], "body", (t) => libClient(t).system(secret)],
    [["bodies", secret], "body", (t) => libClient(t).bodies(secret)],
    [["get", secret], "array", (t) => libClient(t).get(secret)],
    [["get", secret], "errorObject", (t) => libClient(t).get(secret)],
    [["list", "meeting", secret], "system", (t) => libClient(t).list(secret, "meeting")],
    [["endpoints", "--source", "registry", "--registry-url", secret], "body", (t) =>
      libClient(t, { registryUrl: secret }).endpoints({ source: "registry" })],
  ];
  for (const [argv, answer, call] of cases) {
    const label = `${argv[0]} answered with ${answer}`;
    const { cli, lib } = await parity(argv, call, () => jsonResponse(answers[answer]), noLists);
    assert.equal(cli.code, 1, label);
    assert.equal(lib.ok, false, label);
    const message = (lib.error as Error).message;
    assert.doesNotMatch(message, /alice|pw123/, label);
    assert.ok(message.includes(clean), `${label}: ${message}`);
    assert.equal(cli.err, `Error: ${message}`, label);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url), label);
    assert.ok(lib.requests.every((r) => !r.url.includes("pw123") && r.headers?.["Authorization"] === undefined), label);
  }
});

test("page() and walk() keep a URL's credentials out of their messages too", async () => {
  const secret = "https://alice:pw123@x.example/oparl/v1/list";
  for (const call of [(c: OparlClient) => c.page(secret), (c: OparlClient) => c.walk(secret)]) {
    const mt = routes({ "https://x.example/oparl/v1/list": jsonResponse(fx.body) });
    await assert.rejects(call(libClient(mt.transport)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /alice|pw123/);
      assert.match(err.message, /https:\/\/x\.example\/oparl\/v1\/list is not an OParl object list/);
      return true;
    });
  }
});

// Finding #2 (PAT-21): the curated-only fallback when the registry fails is a library method.
test("parity: endpointsReport falls back to the curated list as the CLI does, endpoints() stays strict", async () => {
  const curated = {
    curatedEndpoints: [
      { title: "Stadt Neu", url: "https://ris.neu.example/oparl/system", working: true, checked: "2026-09-16", problem: null, oparlVersion: "1.1", systemName: null, vendor: null, bodyCount: 1, note: null },
      { title: "Stadt Alt", url: "https://ris.alt.example/oparl/system", working: false, checked: "2026-09-16", problem: "HTTP 500", oparlVersion: "1.0", systemName: null, vendor: null, bodyCount: null, note: null },
    ],
    registryChecks: [],
  };
  const failures: Array<[string, () => ReturnType<typeof jsonResponse>]> = [
    ["HTTP 500", () => jsonResponse({ message: "down" }, 500)],
    ["no data array", () => jsonResponse({ meta: {} })],
    ["network", () => {
      throw new OparlNetworkError("connect ECONNREFUSED 203.0.113.1:443");
    }],
  ];
  for (const [label, responder] of failures) {
    for (const [flags, filters] of [
      [[], {}],
      [["--search", "neu"], { search: "neu" }],
      [["--working"], { working: true }],
    ] as Array<[string[], { search?: string; working?: boolean }]>) {
      const { cli, lib } = await parity(
        ["--compact", "--max-retries", "0", "endpoints", "--registry-url", fx.REGISTRY_URL, ...flags],
        (transport) => libClient(transport, { ...curated, registryUrl: fx.REGISTRY_URL, maxRetries: 0 }).endpointsReport(filters),
        responder,
        curated,
      );
      const report = lib.value as { entries: RegistryEntry[]; registryError?: Error };
      assert.equal(cli.code, 0, label);
      assert.equal(lib.ok, true, label);
      assert.deepEqual(JSON.parse(cli.out), report.entries, label);
      assert.ok(report.registryError instanceof OparlError, label);
      assert.ok(cli.err.includes(`could not be read (${report.registryError.message})`), `${label}: ${cli.err}`);
      assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url), label);
    }
    const strict = await parity(
      ["--max-retries", "0", "endpoints", "--registry-url", fx.REGISTRY_URL, "--source", "registry"],
      (transport) => libClient(transport, { ...curated, registryUrl: fx.REGISTRY_URL, maxRetries: 0 }).endpoints(),
      responder,
      curated,
    );
    assert.notEqual(strict.cli.code, 0, label);
    assert.equal(strict.lib.ok, false, label);
    assert.ok(strict.lib.error instanceof OparlError, label);
  }
});

test("endpointsReport reports no registryError when the registry answers, and throws for source registry", async () => {
  const site = routes({
    [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse(fx.registryPage1),
    [`${fx.REGISTRY_URL}?page=2&limit=100`]: jsonResponse(fx.registryPage2),
  });
  const ok = await libClient(site.transport, { registryUrl: fx.REGISTRY_URL }).endpointsReport();
  assert.deepEqual(Object.keys(ok), ["entries"]);
  assert.equal(ok.entries.length, 3);

  const down = makeMockTransport(() => jsonResponse({}, 500));
  await assert.rejects(
    libClient(down.transport, { registryUrl: fx.REGISTRY_URL, maxRetries: 0 }).endpointsReport({ source: "registry" }),
    OparlApiError,
  );
  // A validation error is never turned into a fallback.
  await assert.rejects(
    libClient(down.transport, { registryUrl: fx.REGISTRY_URL }).endpointsReport({ search: " " }),
    OparlValidationError,
  );
});

// Finding #10 (PAT-23): the CLI's URL and header parsers use the library's rules and words.
test("parity: a bad URL argument or User-Agent is rejected with the library's own message", async () => {
  const ctrl = `a${String.fromCharCode(0x01)}b`;
  const cases: Array<[string, string[], (t: Transport) => unknown]> = [
    ["system 'not a url'", ["system", "not a url"], (t) => libClient(t).system("not a url")],
    ["system ftp", ["system", "ftp://h.example/x"], (t) => libClient(t).system("ftp://h.example/x")],
    ["system ''", ["system", ""], (t) => libClient(t).system("")],
    ["get ftp", ["get", "ftp://h.example/x"], (t) => libClient(t).get("ftp://h.example/x")],
    ["list blank body", ["list", "meeting", "  "], (t) => libClient(t).list("  ", "meeting")],
    ["bodies ftp", ["bodies", "ftp://h.example/x"], (t) => libClient(t).bodies("ftp://h.example/x")],
    ["registry ftp", ["endpoints", "--registry-url", "ftp://h.example/x"], (t) => libClient(t, { registryUrl: "ftp://h.example/x" })],
    ["UA control", ["--user-agent", ctrl, "system", fx.SYSTEM_URL], (t) => libClient(t, { userAgent: ctrl }).system(fx.SYSTEM_URL)],
    ["UA euro", ["--user-agent", "€", "system", fx.SYSTEM_URL], (t) => libClient(t, { userAgent: "€" }).system(fx.SYSTEM_URL)],
  ];
  for (const [label, argv, call] of cases) {
    const { cli, lib } = await parity(argv, call, () => jsonResponse(fx.system));
    assert.equal(cli.code, 2, label);
    assert.equal(lib.ok, false, label);
    assert.ok(lib.error instanceof OparlValidationError, label);
    const reason = (lib.error as Error).message.replace(/^Invalid registryUrl: /, "");
    // commander's own usage error, which carries the library's reason.
    assert.match(cli.err, /^error: .* is invalid/, label);
    assert.ok(cli.err.includes(reason), `${label}: ${cli.err} / ${reason}`);
    assert.equal(cli.requests.length + lib.requests.length, 0, label);
  }
});
