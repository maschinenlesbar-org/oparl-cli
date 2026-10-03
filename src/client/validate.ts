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
