import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_UMLAUT_PASS_LENGTH,
  filterEndpoints,
  foldSearchText,
  normalizeOparlVersion,
  oparlVersionProblem,
  searchMatches,
  searchTextProblem,
} from "../src/client/endpoints-search.js";
import * as lib from "../src/index.js";
import { OparlValidationError } from "../src/client/errors.js";
import type { RegistryEntry } from "../src/client/types.js";

const entry = (title: string, oparlVersion: string | null, working: boolean, note: string | null = null): RegistryEntry => ({
  title,
  url: `https://${title.toLowerCase().replace(/\W+/g, "-")}.example/oparl/system`,
  source: "registry",
  working,
  oparlVersion,
  systemName: null,
  vendor: null,
  bodyCount: null,
  wikidata: null,
  fetched: null,
  checked: null,
  problem: null,
  replacedBy: null,
  note,
});

const entries = [entry("Stadt Köln", "1.0", true), entry("Stadt Düsseldorf", "1.1", true), entry("Gemeinde Aue", "1.0", false, "Erzgebirge")];

test("searchTextProblem rejects a blank or non-string search, accepts any other text", () => {
  assert.equal(searchTextProblem("köln"), undefined);
  assert.equal(searchTextProblem(" x "), undefined);
  assert.equal(searchTextProblem(""), "Expected a non-empty value.");
  assert.equal(searchTextProblem("  \t"), "Expected a non-empty value.");
  assert.equal(searchTextProblem(42 as unknown as string), "Expected a string.");
});

test("oparlVersionProblem takes a short version or a version URI, padded or not", () => {
  for (const ok of ["1.0", "1.1", " 1.1 ", "https://schema.oparl.org/1.1/", "https://schema.oparl.org/1.0"]) {
    assert.equal(oparlVersionProblem(ok), undefined, ok);
  }
  for (const bad of ["", "1", "v1.1", "1.0.0", "https://schema.oparl.org/", "eins", "2"]) {
    assert.match(oparlVersionProblem(bad) ?? "", /^Expected an OParl version such as 1\.0 or 1\.1/, bad);
  }
  assert.equal(oparlVersionProblem(1.1 as unknown as string), "Expected a string.");
});

test("normalizeOparlVersion returns the short form, is idempotent and throws on a bad value", () => {
  assert.equal(normalizeOparlVersion("https://schema.oparl.org/1.1/"), "1.1");
  assert.equal(normalizeOparlVersion(" 1.0 "), "1.0");
  assert.equal(normalizeOparlVersion(normalizeOparlVersion("https://schema.oparl.org/1.0/")), "1.0");
  assert.throws(() => normalizeOparlVersion("2"), (err: unknown) => err instanceof OparlValidationError && /^Invalid oparlVersion: /.test(err.message));
});

test("searchMatches folds accents and falls back to the umlaut spellings only when nothing matches", () => {
  const text = (e: RegistryEntry) => [e.title, e.url, e.note ?? ""];
  assert.deepEqual(searchMatches(entries, "koeln", text).map((e) => e.title), ["Stadt Köln"]);
  assert.deepEqual(searchMatches(entries, "DUSSELDORF", text).map((e) => e.title), ["Stadt Düsseldorf"]);
  assert.deepEqual(searchMatches(entries, "aue", text).map((e) => e.title), ["Gemeinde Aue"]);
  assert.deepEqual(searchMatches(entries, "ae", text), []);
  assert.equal(foldSearchText("Gießen"), "giessen");
  assert.equal(MIN_UMLAUT_PASS_LENGTH, 4);
});

test("filterEndpoints applies search, version and working, and validates them", () => {
  assert.deepEqual(filterEndpoints(entries, {}), entries);
  assert.deepEqual(filterEndpoints(entries, { search: "erzgebirge" }).map((e) => e.title), ["Gemeinde Aue"]);
  assert.deepEqual(filterEndpoints(entries, { oparlVersion: "https://schema.oparl.org/1.0/" }).map((e) => e.title), ["Stadt Köln", "Gemeinde Aue"]);
  assert.deepEqual(filterEndpoints(entries, { oparlVersion: "1.0", working: true }).map((e) => e.title), ["Stadt Köln"]);
  assert.throws(() => filterEndpoints(entries, { search: " " }), OparlValidationError);
  assert.throws(() => filterEndpoints(entries, { oparlVersion: "x" }), OparlValidationError);
});

test("the library root exports the endpoint search", () => {
  assert.equal(lib.searchMatches, searchMatches);
  assert.equal(lib.filterEndpoints, filterEndpoints);
  assert.equal(lib.normalizeOparlVersion, normalizeOparlVersion);
});
