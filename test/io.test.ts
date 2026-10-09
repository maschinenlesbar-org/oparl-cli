// The process-stream seam of src/cli/io.ts, on fake streams: no process is started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleOutputErrors } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

/** A write error as Node raises it on a stream. */
function writeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** Fake stdout/stderr with handleOutputErrors installed; exits and records captured. */
function outputStreams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, records };
}

test("another stdout write error is an ERROR record of oparl.output, in the run's format, and exits 1", () => {
  const s = outputStreams();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "oparl.output", msg: "Could not write to stdout: write EBADF" },
  ]);
});

test("EPIPE or ENOTCONN on stdout (the reader has gone) exits 0 quietly", () => {
  for (const code of ["EPIPE", "ENOTCONN"]) {
    const s = outputStreams();
    s.stdout.emit("error", writeError(code));
    assert.deepEqual([s.exits, s.records], [[0], []], code);
  }
});

test("EPIPE on stderr is ignored; another stderr error exits 1 without a record", () => {
  const s = outputStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual([s.exits, s.records], [[1], []]);
});
