// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { OparlClient, OparlClientOptions } from "../client/client.js";
import { OparlError } from "../client/errors.js";
import { createLogger, type Logger } from "./log.js";

/**
 * Writing the output to the `-o` file failed (a missing directory, a directory, EACCES,
 * …). Logged as an ERROR of `oparl.output`, exit 1.
 */
export class OutputError extends OparlError {}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Persist bytes to a file (for --output). */
  writeFile(path: string, data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: OparlClientOptions): OparlClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an unhandled
 * 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| less`, a closed terminal — closes our stdout
 * while we are still writing, and the next write fails with EPIPE (ENOTCONN when stdout
 * is a socket whose peer has gone, as when a Node parent spawns the CLI with piped stdio on
 * macOS). That is ordinary use, so the process exits 0 at once, quietly. Any other stdout
 * error is an ERROR record of `oparl.output` (`Could not write to stdout: <message>`,
 * through `log`, in the run's format) and exits 1. On stderr an EPIPE is ignored, so
 * a failed run keeps its exit code (`2>&1 | true` turned a usage error into 0); any other
 * stderr error exits 1 silently (there is nowhere left to report it). The bin shim
 * installs this once, before `run()`, with a logger for the format argv asks for
 * (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => writeFileSync(path, data),
};
