// The seams of src/cli/io.ts: the process streams, on fake streams (no process is started), and
// the -o file rules, on a temporary directory with injected link owners.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOutputErrors, nodeFilesFor, stderrAfterStdout, type LinkOwners, type OutputFiles } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { OparlClient } from "@maschinenlesbar.org/oparl-client/internal/client";
import { jsonResponse, makeMockTransport } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/oparl-client/test/fixtures";
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

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

// Classes G and G2 of .reviews/2026-10-27-security-audit (portfolio round): `-o` writes only where
// the user meant it to. Owners are injected (nodeFilesFor), so no test needs a second user.
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

async function runWith(files: OutputFiles, argv: string[]): Promise<{ code: number; err: string; requests: number }> {
  const mt = makeMockTransport(() => jsonResponse(fx.system));
  const err: string[] = [];
  const code = await run(argv, {
    io: {
      out: () => {},
      err: (s) => err.push(s),
      writeFile: (path, data, overwrite) => files.write(path, data, overwrite),
      outputState: (path) => files.state(path),
      outputParentProblem: (path, overwrite) => files.parentProblem(path, overwrite),
    },
    createClient: (options) => new OparlClient({ ...options, transport: mt.transport }),
  });
  return { code, err: err.join("\n"), requests: mt.calls.length };
}

function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oparl-g-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--force does not follow a link another user made in a shared directory, at any hop (G)", async () => {
  const t = planted();
  try {
    for (const mode of [0o41777, 0o40777]) {
      const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: { uid: 0, mode } }));
      const o = await runWith(files, ["-o", t.link, "--force", "system", fx.SYSTEM_URL]);
      assert.equal(o.code, 2, o.err);
      assert.equal(o.requests, 0);
      assert.match(o.err, /another user/);
      assert.throws(() => files.write(t.link, Buffer.from("x"), true), /another user/);
      assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    }
    // own link -> a foreign link -> the victim; and a foreign dangling link.
    const inner = join(t.dir, "inner");
    symlinkSync(t.victim, inner);
    const outer = join(t.dir, "outer.json");
    symlinkSync(inner, outer);
    assert.equal((await runWith(nodeFilesFor(owners({ [inner]: OTHER }, { [t.dir]: SHARED })), ["-o", outer, "--force", "system", fx.SYSTEM_URL])).code, 2);
    const dangling = join(t.dir, "dangling.json");
    symlinkSync(join(t.dir, "elsewhere.json"), dangling);
    assert.equal((await runWith(nodeFilesFor(owners({ [dangling]: OTHER }, { [t.dir]: SHARED })), ["-o", dangling, "--force", "system", fx.SYSTEM_URL])).code, 2);
    assert.throws(() => statSync(join(t.dir, "elsewhere.json")));
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // The caller's own link, the directory owner's, and any link in a directory only its owner writes: followed.
    for (const who of [owners({}, { [t.dir]: SHARED }), owners({ [t.link]: 0 }, { [t.dir]: SHARED }), owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })]) {
      writeFileSync(t.victim, "keep me\n");
      const o = await runWith(nodeFilesFor(who), ["-o", t.link, "--force", "system", fx.SYSTEM_URL]);
      assert.equal(o.code, 0, o.err);
      assert.equal((JSON.parse(readFileSync(t.victim, "utf8")) as { id: string }).id, fx.system.id);
    }
  } finally {
    t.done();
  }
});

test("a path that can't be inspected is reported as such, not as an existing file (G)", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oparl-g-"));
  try {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    const o = await runWith(nodeFilesFor(), ["-o", link, "system", fx.SYSTEM_URL]);
    assert.equal(o.code, 2, o.err);
    assert.equal(o.requests, 0);
    assert.doesNotMatch(o.err, /Refusing to overwrite existing file/);
    assert.match(o.err, /EACCES|permission/i);
  } finally {
    chmodSync(join(dir, "closed"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream target is written only when the descriptor opened is a stream (G2)", () => {
  const t = planted();
  try {
    const real = nodeFilesFor();
    const switched = { ...real, state: () => "stream" as const };
    assert.throws(() => switched.write(t.link, Buffer.from("appended\n"), false), /Refusing to overwrite/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    assert.doesNotThrow(() => real.write("/dev/null", Buffer.from("x"), false));
  } finally {
    t.done();
  }
});
