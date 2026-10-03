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
