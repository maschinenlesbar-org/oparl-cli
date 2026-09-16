// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { OparlClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBoundedInt, parseHeaderValue, parseIntArg, parseNonEmpty } from "./shared.js";
import { registerCommands } from "./commands/oparl.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new OparlClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("oparl")
    .description(
      "CLI for OParl, the open standard API of German municipal council information " +
        "systems (Ratsinformationssysteme). No API key needed. Every municipality runs its " +
        "own server: find one with `endpoints`, open it with `system` and `bodies`, then " +
        "walk a body's meetings, papers or persons with `list`, or fetch any object with `get`.",
    )
    .version(VERSION)
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout; default 120000)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option("--max-redirects <n>", "redirects to follow on the same host (0..10, default 3)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout", parseNonEmpty)
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
