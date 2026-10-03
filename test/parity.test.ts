// CLI <-> library parity: the same input through `run()` and through the library call
// the CLI wraps must give the same outcome — both reject before any request, or both
// send the same requests and return the same result. See the 2026-10-03 parity report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OparlClient, type OparlClientOptions } from "../src/client/client.js";
import { OparlValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import type { RegistryEntry } from "../src/client/types.js";
import { jsonResponse, parity, routes } from "./helpers.js";
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
