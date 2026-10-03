// Filtering the known endpoints: the text search with accent and umlaut folding, the
// OParl version and the working flag that `OparlClient.endpoints()` applies, and the
// rules for their values. The CLI's `endpoints --search/--oparl-version/--working` and
// its value parsers use these same functions.

import { assertValid } from "./validate.js";
import type { RegistryEntry } from "./types.js";

/** The filters `endpoints()` takes besides `source`. */
export interface EndpointFilters {
  /**
   * Only entries whose title, URL or note contains this text, ignoring case, Unicode
   * form and accents (`ß` = `ss`); when nothing matches literally, the `ae`/`oe`/`ue`
   * umlaut spellings are tried (`koeln` finds `Köln`). Must not be blank.
   */
  search?: string;
  /** Only entries speaking this OParl version: `1.0`, `1.1`, or a version URI. */
  oparlVersion?: string;
  /** Only entries that worked on their last check. */
  working?: boolean;
}

/** "https://schema.oparl.org/1.1/" → "1.1"; anything else unchanged. */
export function shortOparlVersion(version: string): string {
  return /\/(\d+\.\d+)\/?$/.exec(version)?.[1] ?? version;
}

/** Why a search term is unusable: blank (it would match every entry), or not a string. */
export function searchTextProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
}

/**
 * Why an OParl version filter is unusable. Accepted: the short form the endpoint list
 * holds ("1.1"), or the version URI a System carries ("https://schema.oparl.org/1.1/"),
 * with surrounding whitespace. Any other string would match nothing, which reads as "no
 * such servers".
 */
export function oparlVersionProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (!/^\d+\.\d+$/.test(shortOparlVersion(value.trim()))) {
    return "Expected an OParl version such as 1.0 or 1.1, or the version URI a System reports (https://schema.oparl.org/1.1/).";
  }
  return undefined;
}

/** An OParl version filter in the short form the endpoint list holds ("1.1"); idempotent. */
export function normalizeOparlVersion(value: string): string {
  assertValid("oparlVersion", value, oparlVersionProblem);
  return shortOparlVersion(value.trim());
}

/**
 * Fold text for the endpoints search: case, Unicode normalisation form and accents
 * compare equal, and `ß` counts as `ss`. So "Köln" typed composed or decomposed, and
 * "koln", match each other.
 */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss");
}

/**
 * The same text with the German umlaut spellings contracted, so `ae`/`oe`/`ue` compare
 * equal to `a`/`o`/`u`: "koeln" and "köln" (folded to "koln") both become "koln".
 *
 * Only used as a second pass, because it also collapses ordinary words — "Aue" becomes
 * "au" and matches half the register. See {@link searchMatches}.
 */
export function contractUmlautSpellings(folded: string): string {
  return folded.replace(/([aou])e/g, "$1");
}

/** A search needs this many characters before the umlaut pass runs. */
export const MIN_UMLAUT_PASS_LENGTH = 4;

/**
 * The entries a search term matches: those containing it literally (accents and `ß`
 * folded) and, only when nothing matched literally, those that match with the umlaut
 * spellings contracted — so "koeln" still finds "Köln" and "duesseldorf" finds
 * "Dusseldorf", while "ae" no longer matches every entry with an "a".
 */
export function searchMatches<T>(entries: readonly T[], term: string, text: (entry: T) => string[]): T[] {
  const needle = foldSearchText(term.trim());
  const literal = entries.filter((entry) => text(entry).some((value) => foldSearchText(value).includes(needle)));
  if (literal.length > 0 || needle.length < MIN_UMLAUT_PASS_LENGTH) return literal;
  const contracted = contractUmlautSpellings(needle);
  return entries.filter((entry) =>
    text(entry).some((value) => contractUmlautSpellings(foldSearchText(value)).includes(contracted)),
  );
}

/**
 * Check the filters and bring the version to its short form. Throws an
 * OparlValidationError for a blank search or an unusable version.
 */
export function checkEndpointFilters(filters: EndpointFilters): EndpointFilters {
  const checked: EndpointFilters = {};
  if (filters.search !== undefined) checked.search = assertValid("search", filters.search, searchTextProblem);
  if (filters.oparlVersion !== undefined) checked.oparlVersion = normalizeOparlVersion(filters.oparlVersion);
  if (filters.working) checked.working = true;
  return checked;
}

/**
 * The entries that pass the filters, in order: the search (title, URL and note), then
 * the OParl version, then the working flag. Throws an OparlValidationError for a blank
 * search or an unusable version.
 */
export function filterEndpoints(entries: readonly RegistryEntry[], filters: EndpointFilters): RegistryEntry[] {
  const { search, oparlVersion, working } = checkEndpointFilters(filters);
  let result = [...entries];
  if (search !== undefined) result = searchMatches(result, search, (e) => [e.title, e.url, e.note ?? ""]);
  if (oparlVersion !== undefined) result = result.filter((e) => e.oparlVersion === oparlVersion);
  if (working) result = result.filter((e) => e.working);
  return result;
}
