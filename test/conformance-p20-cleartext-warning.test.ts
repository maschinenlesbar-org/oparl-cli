// Conformance test P20 (follow-up round 2026-10-06): a base URL on plain `http:` gets one
// warning line on stderr — always naming the host, and naming what secret travels with it
// (the base URL's credentials, an API key, a login) without printing it. Loopback hosts are
// exempt; https: never warns; `--help` never warns; stdout is never touched. Shared across the
// *-cli repos; only the adapter block below differs per repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { OparlClient as Client } from "../src/client/client.js";
import { cleartextProblem } from "../src/index.js";
/**
 * Whether the CLI takes `--base-url`. oparl doesn't: every command names the URL it starts
 * from, and the warning is about that start URL. The shared cases that pass `--base-url` are
 * skipped; the oparl cases at the end of this block check the same rules on the start URL.
 */
const BASE_URL_OPTION = false;
/** The environment variable the CLI reads a base URL from, or undefined if it has none. */
const BASE_URL_ENV: string | undefined = undefined; // oparl reads no environment variable
/** Extra argv that sends a secret other than URL userinfo (API key, token, login), or undefined. */
const SECRET_ARGS: string[] | undefined = undefined; // open APIs: no key, token or login
/** The secret value inside SECRET_ARGS, which must never be printed. */
const SECRET_VALUE = "k3y-SECRET-value";
/** Words the warning uses for that secret (matched case-insensitively), e.g. /API key/. */
const SECRET_WORDS = /API key/i;
/** A command that needs no arguments and makes one request (reads the registry, https by default). */
const SIMPLE_COMMAND = ["endpoints", "--source", "registry"];
/** A successful answer to SIMPLE_COMMAND, and to `get` (any JSON object). */
const okBody = { data: [{ title: "Stadt Beispiel", url: "https://ris.example/oparl/system" }], meta: {} };
/** Builds the CliDeps for a run (no `env`; the io also writes files). */
function makeDeps(out: string[], err: string[], _env: Record<string, string>): CliDeps {
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
  });
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {} },
    createClient: (opts) => new Client({ ...opts, transport }),
  };
}

// oparl: the same rules on the start URL (a command's URL argument, or the registry).
test("P20 (oparl): an https or loopback start URL, or no URL read, does not warn", async () => {
  for (const argv of [
    ["get", "https://mirror.example/oparl/system"],
    ["get", "http://127.0.0.1:9/oparl/system"],
    ["get", "http://localhost:9/oparl/system"],
    ["get", "http://[::1]:9/oparl/system"],
    ["endpoints", "--source", "registry"],
    ["endpoints", "--source", "curated", "--registry-url", "http://mirror.example/api/endpoints"],
  ]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err.join("\n")}`);
    assert.deepEqual(r.warnings, [], `${argv.join(" ")} warned`);
  }
});

test("P20 (oparl): a remote http start URL warns once on stderr, naming the host; stdout is unchanged", async () => {
  const pairs: Array<[string[], string[]]> = [
    [["get", "https://mirror.example/oparl/system"], ["get", "http://mirror.example/oparl/system"]],
    [
      ["endpoints", "--source", "registry", "--registry-url", "https://mirror.example/api/endpoints"],
      ["endpoints", "--source", "registry", "--registry-url", "http://mirror.example/api/endpoints"],
    ],
  ];
  for (const [plainArgv, httpArgv] of pairs) {
    const plain = await cli(plainArgv);
    const r = await cli(httpArgv);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.equal(r.warnings.length, 1, r.err.join("\n"));
    assert.match(r.warnings[0]!, /mirror\.example/);
    assert.deepEqual(r.out, plain.out);
  }
});

test("P20 (oparl): credentials in an http start URL are dropped, never printed or claimed sent; --help never warns", async () => {
  // OParl access is anonymous: parseUrl removes `user:password@` before the client sees the
  // URL, so nothing secret travels — the warning names the host, not credentials.
  const r = await cli(["get", "http://alice:s3cret-pw@mirror.example/oparl/system"]);
  assert.equal(r.warnings.length, 1, r.err.join("\n"));
  assert.match(r.warnings[0]!, /^warning: requests to mirror\.example are sent unencrypted/);
  assert.doesNotMatch(r.warnings[0]!, /credentials/i);
  assert.ok(![...r.out, ...r.err].join("\n").includes("s3cret-pw"));
  const help = await cli(["get", "http://alice:pw@mirror.example/oparl/system", "--help"]);
  assert.deepEqual(help.warnings, []);
});
// --------------------------------------------------------------------------------------

const WARNING = /^warning: .*unencrypted.*\(http:, not https:\)$/;
/** Skips the cases that pass `--base-url` when the CLI has none (see the adapter's own cases). */
const NO_BASE_URL = !BASE_URL_OPTION && "this CLI has no --base-url (the adapter's cases check its start URL)";

async function cli(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, makeDeps(out, err, env));
  return { code, out, err, warnings: err.filter((l) => WARNING.test(l)) };
}

test("P20: https and loopback http do not warn", { skip: NO_BASE_URL }, async () => {
  for (const base of [undefined, "https://mirror.example", "http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"]) {
    const r = await cli([...(base === undefined ? [] : ["--base-url", base]), ...SIMPLE_COMMAND]);
    assert.equal(r.code, 0, `${base}: ${r.err.join("\n")}`);
    assert.deepEqual(r.warnings, [], `${base} warned`);
  }
});

test("P20: a remote http base URL warns once on stderr, naming the host; stdout is unchanged", { skip: NO_BASE_URL }, async () => {
  const plain = await cli(["--base-url", "https://mirror.example", ...SIMPLE_COMMAND]);
  const r = await cli(["--base-url", "http://mirror.example", ...SIMPLE_COMMAND]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(r.warnings.length, 1, r.err.join("\n"));
  assert.match(r.warnings[0]!, /mirror\.example/);
  assert.deepEqual(r.out, plain.out);
});

test("P20: credentials in an http base URL are named, never printed", { skip: NO_BASE_URL }, async () => {
  const r = await cli(["--base-url", "http://alice:s3cret-pw@mirror.example", ...SIMPLE_COMMAND]);
  assert.equal(r.warnings.length, 1, r.err.join("\n"));
  assert.match(r.warnings[0]!, /credentials/i);
  assert.ok(![...r.out, ...r.err].join("\n").includes("s3cret-pw"));
});

test("P20: another secret sent over http is named, never printed", { skip: (SECRET_ARGS === undefined && "this CLI sends no secret other than URL userinfo") || NO_BASE_URL }, async () => {
  const r = await cli([...SECRET_ARGS!, "--base-url", "http://mirror.example", ...SIMPLE_COMMAND]);
  assert.equal(r.warnings.length, 1, r.err.join("\n"));
  assert.match(r.warnings[0]!, SECRET_WORDS);
  assert.ok(![...r.out, ...r.err].join("\n").includes(SECRET_VALUE));
});

test("P20: an http base URL from the environment warns too", { skip: BASE_URL_ENV === undefined && "this CLI reads no base-URL variable" }, async () => {
  const r = await cli([...SIMPLE_COMMAND], { [BASE_URL_ENV!]: "http://mirror.example" });
  assert.equal(r.warnings.length, 1, r.err.join("\n"));
});

test("P20: --help never warns", { skip: NO_BASE_URL }, async () => {
  const r = await cli(["--base-url", "http://alice:pw@mirror.example", "--help"]);
  assert.deepEqual(r.warnings, []);
});

test("P20: the library exports the check", () => {
  assert.equal(cleartextProblem("https://mirror.example"), undefined);
  assert.equal(cleartextProblem("http://127.0.0.1:8080"), undefined);
  assert.match(cleartextProblem("http://mirror.example") ?? "", /mirror\.example.*\(http:, not https:\)/);
  const withUserinfo = cleartextProblem("http://alice:pw@mirror.example") ?? "";
  assert.match(withUserinfo, /credentials/i);
  assert.ok(!withUserinfo.includes("pw@"));
});
