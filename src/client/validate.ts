// Input rules the library enforces before it sends a request. Each rule is a pure
// `…Problem(value)` function that returns the reason a value is invalid, or undefined
// when it is valid; `assertValid` turns a reason into an OparlValidationError. The CLI
// calls the same functions from its commander value parsers, so a rule is written once
// and a library caller gets the same answer as a CLI user.

import { OparlValidationError } from "./errors.js";

/** A rule: the reason `value` is invalid (one sentence), or undefined when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid. Otherwise
 * throw an OparlValidationError reading `Invalid <name>: <reason>`. Inside an `async`
 * method the throw becomes a rejection, before any request is made.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new OparlValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** The largest list page size (`limit`) a list request may ask for. */
export const MAX_LIST_LIMIT = 1000;

/**
 * Why a list page size (OParl `limit`) is unusable: anything but an integer from 1 to
 * MAX_LIST_LIMIT. Some servers answer a bad `limit` with HTTP 400, and ALLRIS 1.0 cuts
 * the list to it.
 */
export function listLimitProblem(value: number): string | undefined {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIST_LIMIT
    ? undefined
    : `Expected an integer from 1 to ${MAX_LIST_LIMIT}.`;
}

/** Why a page count (`maxPages`, 0 = all) is unusable: anything but a non-negative integer. */
export function maxPagesProblem(value: number): string | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative integer.";
}

/**
 * A rule for an integer option from `min` to `max`. NaN, Infinity, fractions and
 * negative numbers would otherwise silently defeat the comparisons that use the value
 * (a timeout never armed, a retry or redirect loop without end, no size cap).
 */
export function intRangeProblem(min: number, max: number = Number.MAX_SAFE_INTEGER): Problem<number> {
  const expected =
    min === 0 && max === Number.MAX_SAFE_INTEGER ? "Expected a non-negative integer." : `Expected an integer from ${min} to ${max}.`;
  return (value) => (Number.isSafeInteger(value) && value >= min && value <= max ? undefined : expected);
}

/**
 * Throw an OparlValidationError for a key of `options` that is not one of `known` — an
 * unknown, misspelled or wrongly cased name (`modified_since` for `modifiedSince`), or
 * `__proto__` from parsed JSON. A JavaScript caller's typo was ignored silently: the
 * filter was never sent, and the server answered the whole unfiltered list. A key whose
 * value is `undefined` changes nothing and is let through (a spread config).
 */
export function assertKnownKeys(what: string, options: object, known: readonly string[]): void {
  for (const key of Object.keys(options)) {
    if ((options as Record<string, unknown>)[key] === undefined || known.includes(key)) continue;
    const folded = key.toLowerCase().replace(/[_-]/g, "");
    const hint = known.find((name) => name.toLowerCase() === folded);
    throw new OparlValidationError(
      `Unknown ${what} ${JSON.stringify(key.slice(0, 60))}` +
        (hint !== undefined ? ` (did you mean ${hint}?).` : `; use ${known.join(", ")}.`),
    );
  }
}

/**
 * Throw an OparlValidationError unless `options` is undefined or a plain object. An
 * array or a string passed where options belong was read key by key, or ignored.
 */
export function assertOptionsObject(what: string, options: unknown): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new OparlValidationError(`Invalid ${what}: Expected an object.`);
  }
}
