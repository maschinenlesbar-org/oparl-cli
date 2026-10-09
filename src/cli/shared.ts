// Shared helpers used across CLI commands: option parsers, the global option
// resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, logOf, type CliDeps } from "./io.js";
import type { OparlClientOptions } from "../client/client.js";
import { normalizeTimestamp } from "../client/client.js";
import { OparlValidationError } from "../client/errors.js";
import { cleartextProblem, parseHttpUrl, userAgentProblem } from "../client/engine.js";
import type { Problem } from "../client/validate.js";

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

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to the
 * file given by --output (with a short stderr confirmation so stdout stays clean
 * for piping), or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  // `-o -` means stdout, as for curl and wget, not a file named "-".
  if (global.output !== undefined && global.output !== "-") {
    const data = Buffer.from(text + "\n", "utf8");
    try {
      deps.io.writeFile(global.output, data);
    } catch (err) {
      // A bad --output path (missing directory, a directory, no permission) is a
      // user error, not an internal fault — surface it as a clean OutputError (a record
      // of oparl.output, like the confirmation below) instead of letting the raw fs
      // exception hit the "Unexpected error" path. Drop the `, open '<path>'` tail since
      // we already name the path ourselves.
      const reason = err instanceof Error ? err.message.replace(/,\s*open\s+'.*'$/, "") : String(err);
      throw new OutputError(`Could not write to ${global.output}: ${reason}`, { cause: err });
    }
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
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
    const opts = command.opts();
    const start = startUrl(positionals, opts);
    const cleartext = start === undefined ? undefined : cleartextProblem(start);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const client = deps.createClient({ ...toEngineOptions(global), ...clientOptions(opts) });
    await fn({ client, global, opts }, positionals);
  };
}
