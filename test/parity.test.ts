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
