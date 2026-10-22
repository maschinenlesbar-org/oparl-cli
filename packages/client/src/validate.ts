// Input rules the library enforces before it sends a request. Each rule is a pure
// `…Problem(value)` function that returns the reason a value is invalid, or undefined
// when it is valid; `assertValid` turns a reason into an OparlValidationError. The CLI
// calls the same functions from its commander value parsers, so a rule is written once
// and a library caller gets the same answer as a CLI user.

import { OparlValidationError, credentialsIn, quoteValue, redactCredentials } from "./errors.js";

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
      `Unknown ${what} ${quoteValue(key, 60)}` +
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

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which a URL or a header would carry as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter", or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be used as a text filter, or undefined when it can. Refused, before any
 * request, as it would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`);
 * - a lone surrogate (half of a character);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as it is matched: without surrounding whitespace and in composed Unicode, NFC.
 * Inner whitespace is kept.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be used as a token, or undefined when it can. A token is a code, an enum
 * value or a version: a value compared exactly. The rules apply to the value with surrounding
 * whitespace trimmed, as it is used ({@link normalizeToken}): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in a
 * code only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is used: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list value, as typed: each item is checked (`listProblem`) and
 * canonicalised (`normalizeToken`) on its own, so `"a, b"` uses `b`, and `"a,,b"`, `"a,"` and
 * `","` are refused rather than used as an empty item. (oparl takes no list option today; the
 * kit's rule, for a library caller.)
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be used as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** What URL parsing removes from a URL: surrounding C0 controls and spaces, and tabs and line breaks anywhere. */
const URL_STRIPPED = /^[\u0000-\u0020]+|[\u0000-\u0020]+$|[\t\n\r]/g;

/**
 * Why a URL a caller gives (a System, Body, object or registry URL) cannot be used, beyond what
 * `parseHttpUrl` checks, or undefined. An OParl id is an absolute URL and is used as given: not
 * trimmed or normalised beyond what URL parsing does (it drops surrounding whitespace and inner
 * tabs and line breaks, and percent-encodes the rest). What it would percent-encode silently is
 * refused instead: a control character, a format character (a zero-width space, a soft hyphen,
 * a bidi control) and a lone surrogate, which only ever make the URL name something else
 * (`%E2%80%8B` in a path) or nothing. The reason quotes the value visibly, its credentials
 * replaced by `***`.
 */
export function urlArgumentProblem(value: string): string | undefined {
  if (typeof value !== "string") return undefined; // parseHttpUrl's own message
  const kept = value.replace(URL_STRIPPED, "");
  const shown = (): string => quoteValue(redactCredentials(value, credentialsIn(value.trim())));
  if (LONE_SURROGATE.test(kept)) return `${shown()} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(kept)) return `${shown()} contains an invisible or control character (${codePointOf(kept, TOKEN_INVISIBLE)}).`;
  return undefined;
}
