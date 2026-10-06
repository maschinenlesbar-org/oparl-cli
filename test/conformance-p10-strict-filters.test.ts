// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { OparlClient as Client } from "../src/client/client.js";
import { OparlValidationError as ValidationError } from "../src/client/errors.js";
const BODY = "https://ris.example/oparl/bodies/1";
const PAPERS = "https://ris.example/oparl/bodies/1/papers";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.list(BODY, "paper", query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { modifiedSince: "2026-09-01" } };
const GOOD_SENT = "2026-09-01T00:00:00+00:00";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).searchParams.get("modified_since");
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { body: "1" }],
  ["the OParl parameter name instead of the option", { modified_since: "2026-09-01" }],
  ["misspelled key", { modifiedSnce: "2026-09-01" }],
  ["wrong-case key", { ModifiedSince: "2026-09-01" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"modifiedSince": "2026-09-01"}}') as Record<string, unknown>],
];
/** Queries whose filter names the API doesn't have. (OParl's filters are fixed option keys, covered by BAD_KEYS.) */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array filter", { modifiedSince: ["2026-09-01", "2026-08-01"] }],
  ["object filter", { modifiedSince: { from: "2026-09-01" } }],
  ["Date filter", { modifiedSince: new Date("2026-09-01") }],
  ["NaN limit", { limit: Number.NaN }],
  ["array limit", { limit: [1, 2] }],
  ["NaN maxPages", { maxPages: Number.NaN }],
  ["string omitInternal", { omitInternal: "false" }],
];
/**
 * Queries that differ from GOOD only in how a filter value is spelled (padding, case of
 * T/Z, an offset written another way): "normalise" = sent as GOOD_SENT; "reject" = the
 * validation error.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded date", { modifiedSince: " 2026-09-01 " }],
  ["lower-case t and z", { modifiedSince: "2026-09-01t00:00:00z" }],
  ["offset without colon", { modifiedSince: "2026-09-01T00:00:00+0000" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice, and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["list", "paper", BODY, "--modified-since", "2026-09-01", "--modified-since", "2026-08-01"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["list", "paper", BODY, "--limit", "2", "--limit", "5"];
const USAGE_EXIT = 2;
/** True for a request that fetches data (not the Body the client reads the list URL from). */
const isDataRequest = (req: HttpRequest): boolean => new URL(req.url).pathname.endsWith("/papers");
/** The answer to any request. */
const respond = (req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(
    JSON.stringify(
      isDataRequest(req)
        ? { data: [], links: {} }
        : { id: BODY, type: "https://schema.oparl.org/1.1/Body", paper: PAPERS },
    ),
  ),
});
/** CliDeps for this repo. */
const makeDeps = (io: { out: (s: string) => void; err: (s: string) => void }, transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io: { ...io, writeFile: () => {} },
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
