#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { run } from "./run.js";

// A reader that stops early — `| head`, `| less`, a closed terminal — closes our
// stdout while we are still writing. Node reports that as an EPIPE 'error' event on
// the stream, which would otherwise end the process with a raw stack trace. Piping
// into a pager is ordinary use, so stop quietly instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    if (stream !== process.stderr) process.stderr.write(`Output error: ${err.message}\n`);
    process.exit(1);
  });
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
