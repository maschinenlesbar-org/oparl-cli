// Rendering the answer (renderJson in src/cli/shared.ts, the file seam in io.ts): which
// stringify path --compact takes, `-o` and `--force`. The `-o` cases run through run() against
// real files in a temp dir; a write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { OutputError, defaultIO, type CliDeps } from "../src/cli/io.js";
import { OparlClient } from "@maschinenlesbar.org/oparl-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/oparl-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/oparl-client/test/fixtures";

function makeDeps() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {} },
    createClient: (opts) => new OparlClient(opts),
  };
  return { deps, out, err };
}

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeDeps();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", () => {
  // The engine refuses an answer deeper than 256 levels, but a library value handed to the
  // renderer may be deeper: the pretty printer's recursion can't print it. Whether the compact
  // printer can depends on the Node version (iterative from Node 26) and the stack: probed here,
  // never assumed.
  const depth = 200_000;
  const value = JSON.parse(`{"id":"a1","x":${"[".repeat(depth)}${"]".repeat(depth)}}`) as unknown;
  let compactPrints = true;
  try {
    JSON.stringify(value);
  } catch {
    compactPrints = false;
  }
  const { deps, out } = makeDeps();
  assert.throws(() => renderJson(deps, {}, value), (err: Error) =>
    err instanceof OutputError && err.message === `The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`);
  if (compactPrints) {
    renderJson(deps, { compact: true }, value);
    assert.equal(out.length, 1);
  } else {
    assert.throws(() => renderJson(deps, { compact: true }, value), (err: Error) =>
      err instanceof OutputError && err.message === "The answer is nested too deeply to print.");
  }
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", async (t) => {
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean } | null)?.all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  const { deps } = makeDeps();
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
  // Through the CLI: an ERROR record of oparl.output, exit 1, nothing on stdout.
  const cli = makeCli(() => jsonResponse({ ...SYSTEM }));
  assert.equal(await run(["get", OBJECT_URL], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /^ERROR \[oparl\.output\] The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/);
});

const SYSTEM = { ...fx.system, name: "Ein \u001b[31mroter\u009b Rat \u202e" };
const OBJECT_URL = `${fx.HOST}/oparl/paper/1`;

/** A CLI on a mock transport that writes `-o` to the real file system (defaultIO's file seam). */
function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(SYSTEM)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)), writeFile: defaultIO.writeFile, outputState: defaultIO.outputState },
    createClient: (opts) => new OparlClient({ curatedEndpoints: [], registryChecks: [], ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oparl-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli();
    assert.equal(await run(["system", fx.SYSTEM_URL], shown.deps), 0);
    const path = join(dir, "system.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "system", fx.SYSTEM_URL], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.doesNotMatch(written, /[\u001b\u009b\u202e]/, "control characters are escaped in the file too");
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [oparl.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["system.json"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "system", fx.SYSTEM_URL], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "system", fx.SYSTEM_URL], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const cases: Array<[string[], string]> = [
      [["-o", "", "system", fx.SYSTEM_URL], "Expected a non-empty value."],
      [["-o", "  ", "system", fx.SYSTEM_URL], "Expected a non-empty value."],
      [["--force", "system", fx.SYSTEM_URL], "--force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "system", fx.SYSTEM_URL], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["-o", dangling, "system", fx.SYSTEM_URL], `Refusing to overwrite existing file "${dangling}"; pass --force to overwrite.`],
      [["-o", sub, "system", fx.SYSTEM_URL], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "system", fx.SYSTEM_URL], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", existing, "endpoints", "--source", "curated"], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
    ];
    for (const [argv, message] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.some((line) => line.startsWith("ERROR [oparl.cli]") && line.includes(message)), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "system", fx.SYSTEM_URL], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), SYSTEM);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    const paper = { id: OBJECT_URL, type: "https://schema.oparl.org/1.1/Paper" };
    assert.equal(await run(["--compact", "-o", link, "--force", "get", OBJECT_URL], makeCli(() => jsonResponse(paper)).deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), paper);
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "system", fx.SYSTEM_URL], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), SYSTEM);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "system", fx.SYSTEM_URL], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(dangling, "utf8")), SYSTEM);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(SYSTEM);
    });
    assert.equal(await run(["-o", path, "system", fx.SYSTEM_URL], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [`ERROR [oparl.output] Refusing to overwrite existing file "${path}"; pass --force to overwrite.`]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, exit 1", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "out.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "system", fx.SYSTEM_URL], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[oparl\\.output\\] Could not write to ".*out\\.json": ENOENT`));
  });
});

test("a walk that fails after its first page still writes the pages it fetched with -o, then reports the error", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "partial.json");
    const cli = makeCli((req) => {
      if (req.url === fx.BODY_URL) return jsonResponse(fx.body);
      if (req.url === fx.MEETINGS_URL) return jsonResponse(fx.meetingPages[1]);
      return jsonResponse({ message: "down" }, 500);
    });
    assert.equal(await run(["--max-retries", "0", "-o", path, "list", "meeting", fx.BODY_URL, "--max-pages", "0"], cli.deps), 1);
    const written = JSON.parse(readFileSync(path, "utf8")) as { data: unknown[]; next: string };
    assert.equal(written.data.length, 2);
    assert.equal(written.next, `${fx.MEETINGS_URL}?page=2`);
    assert.deepEqual(readdirSync(dir), ["partial.json"]);
  });
});
