// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { OutputError, logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import { networkHint, redactUserinfo, stripTerminalControls } from "./shared.js";
import {
  OparlApiError,
  OparlError,
  OparlLinkError,
  OparlNetworkError,
  OparlParseError,
  OparlValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, a
 * missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** HTTP 404 — resource not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size cap). */
  NETWORK: 6,
  /** Any other error (non-OParl response, refused link, other HTTP status). */
  OTHER: 1,
} as const;

/** The redirect statuses the engine follows, up to --max-redirects. */
const FOLLOWED_REDIRECTS: readonly number[] = [301, 302, 303, 307, 308];

/**
 * Whether the failing request carried a date filter or `limit` — only `list` sends
 * those (and a `get` of a page it handed out), so the "retry without the filters" hint is
 * pointless for `get`, `system` and `bodies`. `endpoints` sends `limit=100` to the
 * registry itself, which no option of the user's can drop: `run()` gives it a hint of its
 * own.
 */
function carriedListFilters(url: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return false;
  }
  return ["created_since", "created_until", "modified_since", "modified_until", "limit"].some((name) => params.has(name));
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `oparl list`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. A run with options
 * but no command (`oparl --compact`), or `help` for an unknown command, makes commander
 * show the help as an error (exit 1, so 2 here) with no `error:` line: an ERROR record
 * "missing command: `oparl <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * The options whose value is a URL: there, as in a positional argument (the URL `system`,
 * `bodies`, `list` and `get` take), a `user:password@host` typed without its scheme is
 * still a credential. Anywhere else a bare `a:b@c` is not: it is a file name (`-o
 * run:2026-10-09@x.json`), a search text or a User-Agent as often as a credential.
 */
const URL_FLAGS = ["--registry-url"];

/**
 * The names (long and short) of the program's own options that take a value
 * (`--user-agent`, `-o`). Only the program's: commander takes them out of argv wherever
 * they stand, before a subcommand sees the rest, so a subcommand's `--search` never
 * swallows a `--log-format` after it.
 */
function programValueOptions(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/** The names (long and short) of the options in the whole command tree that take a value. */
function valueOptionsOf(command: Command, names: Set<string> = new Set()): Set<string> {
  for (const option of command.options) {
    if (!option.required && !option.optional) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  for (const child of command.commands) valueOptionsOf(child, names);
  return names;
}

/**
 * The URL arguments of `argv`: the values of `URL_FLAGS` and every positional — a token
 * that is no option and not the value of another option that takes one (`-o`,
 * `--user-agent`, `--search`, …), everything after `--` included. The value of an unknown
 * option (`--base-url=…`) counts too: nothing says it is not a URL.
 */
function urlArguments(argv: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      found.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      found.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      const name = token.slice(0, eq);
      if (URL_FLAGS.includes(name) || !valueOptions.has(name)) found.push(token.slice(eq + 1));
      continue;
    }
    if (!valueOptions.has(token)) continue;
    const value = argv[i + 1];
    if (URL_FLAGS.includes(token) && value !== undefined) found.push(value);
    i++;
  }
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the exact userinfo of every argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: that, and any other `scheme://user@` (by pattern). */
  err(text: string): string;
}

/**
 * The credentials of the run in `argv`. Commander echoes rejected values in its errors
 * ("argument '…' is invalid"), and the CLI's own messages name URLs: whatever path a
 * credential takes, the exact userinfo of each argument (as `credentialsIn` finds it, also
 * in an `--option=value` token, plus its terminal-stripped and JSON-escaped forms) is
 * replaced by `***`. Only a value with a scheme is a URL anywhere in argv; a URL argument
 * (`urlArguments`) typed without its scheme is read as if it had one. A pattern alone
 * can't delimit a password holding a space, `/`, `#` or `@`; the exact strings can. On
 * stderr any other `scheme://user@` is redacted by pattern too. stdout otherwise passes
 * unchanged: it carries the server's data as escaped JSON. `valueOptions` names the
 * options that take a value (`valueOptionsOf`).
 */
export function redactionFor(argv: readonly string[], valueOptions: ReadonlySet<string> = new Set()): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) => (token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token));
  // A URL argument typed without its scheme is read as if it had one.
  const urls = urlArguments(argv, valueOptions).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  const secrets = new Set<string>();
  for (const source of [...values, ...urls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(stripTerminalControls(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  const list = [...secrets];
  const out = (text: string): string => (list.length === 0 ? text : redactCredentials(text, list));
  return { out, err: (text) => redactUserinfo(out(text)) };
}

/**
 * `deps` that keep the credentials of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched and a password holding DEL, C1 or bidi characters is matched in its raw form.
 * `io.err` itself is redacted too, and terminal control characters are removed there, for
 * anything that writes to stderr without the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // The command tree only names the options here; this program never runs.
  const redaction = redactionFor(argv, valueOptionsOf(buildProgram(deps)));
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(stripTerminalControls(redaction.err(text))) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`). Its format is the one argv asks for (`logFormatFromArgv`), and
 * it replaces the credentials of argv like the run's own log; it writes to the raw
 * stderr.
 */
export function processLogger(argv: readonly string[]): Logger {
  const program = buildProgram();
  return createLogger({
    format: logFormatFromArgv(argv, programValueOptions(program)),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv, valueOptionsOf(program)).err,
  });
}

/**
 * The log area of an `OparlError` that is none of the kinds `run()` maps first: a
 * malformed answer (`api`: an `OparlParseError` — not OParl JSON, an HTML page, the wrong
 * object type, an OParl error object, an unknown charset; the server's answer as much as
 * an error status is), the `-o` file (`output`, like its "Wrote N bytes"), else `cli`.
 */
function areaOf(err: OparlError): string {
  if (err instanceof OparlParseError) return "api";
  if (err instanceof OutputError) return "output";
  return "cli";
}

export async function run(argv: string[], rawDeps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the credentials of the run in every message, in either format.
  const deps = withRedactedOutput(rawDeps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);
  // For the records of a parse error: the scan of argv, now knowing which of the
  // program's options take a value, as commander reads them.
  const log = deps.log;
  if (log !== undefined) log.format = logFormatFromArgv(argv, programValueOptions(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  // The command that ran, for its hints: `endpoints` reads the registry, no council system.
  let ran: string | undefined;
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
    ran = actionCommand.name();
  });

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    const log = logOf(deps);
    if (err instanceof OparlValidationError) {
      log.error("cli", err.message);
      return EXIT.USAGE;
    }
    if (err instanceof OparlApiError) {
      log.error("api", err.message);
      const registry = ran === "endpoints";
      if (err.status === 404) return EXIT.NOT_FOUND;
      if (err.location !== undefined && FOLLOWED_REDIRECTS.includes(err.status)) {
        // A followable redirect is only left unfollowed when --max-redirects ran out
        // (another host is refused with an OparlLinkError before it gets here).
        log.info(
          "api",
          "the server redirected more often than --max-redirects allows (default 3). " +
            "Use the final URL directly, or raise --max-redirects.",
        );
      } else if (registry && err.status >= 500) {
        // The registry is no council system, and the `limit=100` its first request
        // carries is the client's own, no filter the user could drop.
        log.info(
          "api",
          "the endpoint registry reported a server error. Try again later, or use --source curated " +
            "for the endpoints that ship with this tool.",
        );
      } else if (err.status >= 500) {
        log.info(
          "api",
          "the council system reported a server error. " +
            (carriedListFilters(err.url)
              ? "Some servers fail on filters or --limit; retry without them, or later."
              : "Try again later; council systems are often down for a while."),
        );
      } else if (err.status === 400 && !registry && carriedListFilters(err.url)) {
        log.info("api", "some servers reject --limit or the date filters; retry without them.");
      }
      return EXIT.OTHER;
    }
    if (err instanceof OparlNetworkError) {
      log.error("http", err.message);
      const hint = networkHint(err);
      if (hint !== undefined) log.info("http", hint);
      return EXIT.NETWORK;
    }
    if (err instanceof OparlLinkError) {
      // A link or redirect to another host, or a downgrade to http: the connection policy.
      log.error("http", err.message);
      return EXIT.OTHER;
    }
    if (err instanceof OparlError) {
      log.error(areaOf(err), err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
