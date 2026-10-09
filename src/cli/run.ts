// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { redactUserinfo, stripTerminalControls } from "./shared.js";
import {
  OparlApiError,
  OparlError,
  OparlLinkError,
  OparlNetworkError,
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
 * those, so the "retry without the filters" hint is pointless for `get`, `system`,
 * `bodies` and `endpoints`.
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
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
  });
  for (const child of command.commands) configureTree(child, deps);
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
 * replaced by `***`. A pattern alone can't delimit a password holding a space, `/`, `#` or
 * `@`; the exact strings can. On stderr any other `scheme://user@` is redacted by pattern
 * too. stdout otherwise passes unchanged: it carries the server's data as escaped JSON.
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) => (token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token));
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
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
  const redaction = redactionFor(argv);
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

export async function run(argv: string[], rawDeps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the credentials of the run in every message, in either format.
  const deps = withRedactedOutput(rawDeps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

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
      if (err.status === 404) return EXIT.NOT_FOUND;
      if (err.location !== undefined && FOLLOWED_REDIRECTS.includes(err.status)) {
        // A followable redirect is only left unfollowed when --max-redirects ran out
        // (another host is refused with an OparlLinkError before it gets here).
        log.info(
          "api",
          "the server redirected more often than --max-redirects allows (default 3). " +
            "Use the final URL directly, or raise --max-redirects.",
        );
      } else if (err.status >= 500) {
        log.info(
          "api",
          "the council system reported a server error. " +
            (carriedListFilters(err.url)
              ? "Some servers fail on filters or --limit; retry without them, or later."
              : "Try again later; council systems are often down for a while."),
        );
      } else if (err.status === 400 && carriedListFilters(err.url)) {
        log.info("api", "some servers reject --limit or the date filters; retry without them.");
      }
      return EXIT.OTHER;
    }
    if (err instanceof OparlNetworkError) {
      log.error("http", err.message);
      if (/maxResponseBytes/.test(err.message)) {
        log.info("http", "the response exceeded the size cap. Raise --max-response-bytes <n> (0 = unlimited).");
      } else if (/timed out/.test(err.message)) {
        log.info("http", "council systems can be slow. Raise --timeout <ms> (0 = no timeout).");
      }
      return EXIT.NETWORK;
    }
    if (err instanceof OparlLinkError) {
      // A link or redirect to another host, or a downgrade to http: the connection policy.
      log.error("http", err.message);
      return EXIT.OTHER;
    }
    if (err instanceof OparlError) {
      // Includes OparlParseError (not OParl JSON, wrong object type, error object).
      log.error("cli", err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
