// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { redactCredentials } from "./shared.js";
import {
  OparlApiError,
  OparlError,
  OparlLinkError,
  OparlNetworkError,
  OparlValidationError,
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
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], rawDeps: CliDeps = defaultDeps): Promise<number> {
  // Everything written to stderr — our messages and commander's parse errors, which
  // quote the raw argument — gets any URL userinfo redacted. stdout is left alone: it
  // carries the server's data, which must stay byte-exact.
  const deps: CliDeps = {
    ...rawDeps,
    io: { ...rawDeps.io, err: (text) => rawDeps.io.err(redactCredentials(text)) },
  };
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
    if (err instanceof OparlValidationError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.USAGE;
    }
    if (err instanceof OparlApiError) {
      deps.io.err(`Error: ${err.message}`);
      if (err.status === 404) return EXIT.NOT_FOUND;
      if (err.status >= 300 && err.status < 400) {
        deps.io.err(
          "Hint: the server redirected and the redirect was not followed (too many, or to " +
            "another host). Use the final URL directly, or raise --max-redirects.",
        );
      } else if (err.status >= 500) {
        deps.io.err(
          "Hint: the council system reported a server error. " +
            (carriedListFilters(err.url)
              ? "Some servers fail on filters or --limit; retry without them, or later."
              : "Try again later; council systems are often down for a while."),
        );
      } else if (err.status === 400 && carriedListFilters(err.url)) {
        deps.io.err("Hint: some servers reject --limit or the date filters; retry without them.");
      }
      return EXIT.OTHER;
    }
    if (err instanceof OparlNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      if (/maxResponseBytes/.test(err.message)) {
        deps.io.err("Hint: the response exceeded the size cap. Raise --max-response-bytes <n> (0 = unlimited).");
      } else if (/timed out/.test(err.message)) {
        deps.io.err("Hint: council systems can be slow. Raise --timeout <ms> (0 = no timeout).");
      }
      return EXIT.NETWORK;
    }
    if (err instanceof OparlLinkError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    if (err instanceof OparlError) {
      // Includes OparlParseError (not OParl JSON, wrong object type, error object).
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
