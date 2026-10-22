// Shared helpers used across CLI commands: option parsers, the global option
// resolver, and JSON rendering.

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, isDirectoryMessage, logOf, refuseOverwrite, type CliDeps } from "./io.js";
import type { OparlClientOptions } from "@maschinenlesbar.org/oparl-client/internal/client";
import { normalizeTimestamp } from "@maschinenlesbar.org/oparl-client/internal/client";
import { OparlApiError, OparlLinkError, OparlNetworkError, OparlParseError, OparlValidationError, cutForMessage } from "@maschinenlesbar.org/oparl-client/internal/errors";
import { cleartextProblem, isBidiControl, parseHttpUrl, userAgentProblem, type RetryEvent } from "@maschinenlesbar.org/oparl-client/internal/engine";
import type { Problem } from "@maschinenlesbar.org/oparl-client/internal/validate";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * Build a commander value-parser from a library rule (a `…Problem` function): the
 * rule's reason becomes the usage error, so the CLI and the library reject the same
 * values with the same words.
 */
export function fromProblem(problem: Problem<string>): (value: string) => string {
  return (value: string) => {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return value;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * Turn a library check into a commander value-parser: an OparlValidationError it throws
 * becomes the usage error (exit 2), with the library's own words.
 */
export function fromLibrary<T>(check: (value: string) => T): (value: string) => T {
  return (value: string) => {
    try {
      return check(value);
    } catch (err) {
      if (err instanceof OparlValidationError) throw new InvalidArgumentError(err.message);
      throw err;
    }
  };
}

/**
 * commander value-parser for URL arguments (System, Body, object URLs, the registry):
 * the library's parseHttpUrl, so a typo fails at parse time (exit 2) with the message a
 * library caller gets, and any `user:password@` is dropped (never sent nor echoed).
 */
export const parseUrl: (value: string) => string = fromLibrary((value) => parseHttpUrl(value).href);

/**
 * Replace the userinfo of any URL in a text with `***`, by pattern: the fallback for a URL
 * the run's own arguments don't hold (`withRedactedOutput` in run.ts redacts the exact
 * userinfo of every argument first, which a pattern can't delimit when the password holds a
 * space, `/` or `#`). `parseUrl` drops `user:password@` from every URL the client uses, but
 * commander quotes the raw argument back in its own parse errors ("argument '…' is invalid").
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * Drop the characters a terminal may act on from text bound for stderr: C0 controls
 * other than tab and newline (ESC, BEL, CR, …), DEL and C1 (U+009B is the 8-bit CSI).
 * Server text is sanitised where it enters a message, but messages also quote the
 * user's own arguments — and the documented workflows feed server data into those
 * (`oparl get "$(jq -r .data[0].id)"`, where `jq -r` decodes `\u001b`). Checked by char
 * code so the source stays free of control bytes.
 */
export function stripTerminalControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) continue;
    out += text[i];
  }
  return out;
}

/** commander value-parser for an OParl timestamp filter (YYYY-MM-DD or an ISO 8601 date-time with offset). */
export function parseTimestamp(value: string): string {
  try {
    return normalizeTimestamp(value);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * commander value-parser for the User-Agent header: the library's userAgentProblem (not
 * blank, no control characters, nothing above U+00FF), so both reject the same values.
 */
export const parseHeaderValue: (value: string) => string = fromProblem(userAgentProblem);

/**
 * Make giving a single-value option twice a usage error, on `command` and every
 * subcommand. Commander keeps the last value silently: `--modified-since 2026-09-01
 * --modified-since 2026-08-01` walked from August, and `--limit 2 --limit 5` asked for 5,
 * with nothing telling the user that a value was dropped. Flags without a value are left
 * alone. Call it once on a freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) {
        throw new InvalidArgumentError(`${option.long ?? option.short} was given more than once; it takes one value.`);
      }
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

export interface GlobalOptions {
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): OparlClientOptions {
  const options: OparlClientOptions = {};
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxRedirects !== undefined) options.maxRedirects = global.maxRedirects;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1,
 * an ERROR record of `oparl.output`) that names the cause, never "Unexpected error":
 * - an answer nested too deeply overflows the stack: "nested too deeply" (the engine refuses an
 *   answer deeper than 256 levels, so only a library value can be that deep);
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made (reachable with --max-response-bytes 0), while
 * the gap path (an empty gap, the same text) prints it. The fast path stays the default for every
 * other answer.
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** The `-o` file, or undefined for stdout (no `-o`, or `-o -`: stdout, as for curl and wget). */
function outputFile(global: GlobalOptions): string | undefined {
  return global.output === undefined || global.output === "-" ? undefined : global.output;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, an existing path (a dangling link too) without `--force`, and a file whose
 * directory is missing or not writable are usage errors (an OparlValidationError, exit 2). A
 * stream (`/dev/null`, a FIFO, `/dev/stdout`, `>(…)`) needs no `--force`: it is written in
 * place, and nothing in it can be lost. `-o -` is stdout. The write checks again: a file that
 * appears during the request is not overwritten either (an OutputError then, exit 1).
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new OparlValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = outputFile(global);
  if (path === undefined || deps.io.outputState === undefined) return;
  const state = deps.io.outputState(path);
  if (state === "directory") throw new OparlValidationError(isDirectoryMessage(path));
  if (state === "stream") return;
  if (state === "exists" && global.force !== true) throw new OparlValidationError(refuseOverwrite(path));
  const problem = deps.io.outputParentProblem?.(path, global.force === true);
  if (problem !== undefined) throw new OparlValidationError(problem);
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to the
 * file given by --output (atomically, never over an existing file without --force; with a
 * short stderr confirmation so stdout stays clean for piping), or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  const path = outputFile(global);
  if (path === undefined) return deps.io.out(text);
  const data = Buffer.from(text + "\n", "utf8");
  try {
    deps.io.writeFile(path, data, global.force === true);
  } catch (err) {
    // A bad --output path (missing directory, no permission, a full disk) is a user error,
    // not an internal fault — a clean OutputError (a record of oparl.output, like the
    // confirmation below) instead of the "Unexpected error" path. The file seam's own
    // errors carry their message; another writer's gets the path named, without Node's
    // `, open '<path>'` tail.
    if (err instanceof OutputError) throw err;
    const reason = err instanceof Error ? err.message.replace(/,\s*open\s+'.*'$/, "") : String(err);
    throw new OutputError(`Could not write to "${cutForMessage(path)}": ${reason}`, { cause: err });
  }
  logOf(deps).info("output", `Wrote ${data.length} bytes to ${path}`);
}

/**
 * What the user can do about a network failure, or undefined: a size cap or a timeout
 * they set (or its default). `slow` names who was slow to answer.
 */
export function networkHint(err: OparlNetworkError, slow = "council systems can be slow"): string | undefined {
  if (/maxResponseBytes/.test(err.message)) {
    return "the response exceeded the size cap. Raise --max-response-bytes <n> (0 = unlimited).";
  }
  if (/timed out/.test(err.message)) return `${slow}. Raise --timeout <ms> (0 = no timeout).`;
  return undefined;
}

/**
 * The log area a failure belongs to: the connection (`http`: a network error, a refused
 * link), the server's answer (`api`: an error status, a malformed answer), else `cli`.
 */
export function failureArea(err: unknown): string {
  if (err instanceof OparlNetworkError || err instanceof OparlLinkError) return "http";
  if (err instanceof OparlApiError || err instanceof OparlParseError) return "api";
  return "cli";
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * The URL a run starts from: the first positional argument that is an http(s) URL (the
 * System, Body or object URL `system`, `bodies`, `list` and `get` take), else the registry
 * URL `endpoints` reads (`--registry-url`, default dev.oparl.org) unless `--source curated`
 * leaves the registry alone. Undefined when the run reads no URL.
 */
export function startUrl(positionals: readonly string[], opts: Record<string, unknown>): string | undefined {
  const url = positionals.find((p) => /^https?:\/\//i.test(p));
  if (url !== undefined) return url;
  const registry = opts["registryUrl"];
  return typeof registry === "string" && opts["source"] !== "curated" ? registry : undefined;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before the first request) it logs one
 * warning (`oparl.http`) when the run's start URL ({@link startUrl}) is
 * plain `http:` to a host other than loopback (cleartextProblem). oparl has no base URL;
 * the start URL is the one the command names. Help, version and usage errors never reach
 * an action, so they never warn.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
  clientOptions: (opts: Record<string, unknown>) => Partial<OparlClientOptions> = () => ({}),
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // A refused -o target is a usage error before anything else happens.
    checkOutputTarget(deps, global);
    const opts = command.opts();
    const start = startUrl(positionals, opts);
    const cleartext = start === undefined ? undefined : cleartextProblem(start);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const onRetry = (event: RetryEvent): void => logOf(deps).warn("http", retryMessage(event));
    // Text in an answer replaced with U+FFFD is said, never silent (a WARN of oparl.api).
    const onWarning = (message: string): void => logOf(deps).warn("api", message);
    const client = deps.createClient({ ...toEngineOptions(global), ...clientOptions(opts), onRetry, onWarning });
    await fn({ client, global, opts }, positionals);
  };
}
