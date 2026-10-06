// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { OparlClient, OparlClientOptions } from "../client/client.js";

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
 * while we are still writing, and the next write fails with EPIPE. That is ordinary use,
 * so the process exits 0 at once, quietly. Any other stdout error prints one
 * `Output error: <message>` line to stderr and exits 1. On stderr an EPIPE is ignored, so
 * a failed run keeps its exit code (`2>&1 | true` turned a usage error into 0); any other
 * stderr error exits 1 silently (there is nowhere left to report it). The bin shim
 * installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") exit(1);
  });
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => writeFileSync(path, data),
};
