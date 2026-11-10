import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LIST_LIMIT, assertValid, listLimitProblem, maxPagesProblem, type Problem } from "@maschinenlesbar.org/oparl-client/internal/validate";
import * as lib from "../src/index.js";
import { OparlError, OparlValidationError } from "@maschinenlesbar.org/oparl-client/internal/errors";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { OparlClient, listQuery } from "@maschinenlesbar.org/oparl-client/internal/client";
import { jsonResponse, parity, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/oparl-client/test/fixtures";

const evenProblem: Problem<number> = (n) => (n % 2 === 0 ? undefined : "Expected an even number.");

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("count", 4, evenProblem), 4);
});

test("assertValid throws an OparlValidationError reading 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("count", 3, evenProblem),
    (err: unknown) =>
      err instanceof OparlValidationError &&
      err instanceof OparlError &&
      err.message === "Invalid count: Expected an even number.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (n: number) => assertValid("count", n, evenProblem);
  const pending = method(3);
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, OparlValidationError);
});

test("the library root exports assertValid and OparlValidationError", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.OparlValidationError, OparlValidationError);
});

test("run() maps an OparlValidationError raised in an action to exit 2 and an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => undefined },
    createClient: () => {
      throw new OparlValidationError("Invalid thing: Expected another thing.");
    },
  };
  assert.equal(await run(["get", fx.SYSTEM_URL], deps), 2);
  assert.deepEqual(err.map(untimed), ["ERROR [oparl.cli] Invalid thing: Expected another thing."]);
  assert.deepEqual(out, []);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: library } = await parity(
    ["--compact", "get", fx.SYSTEM_URL],
    (transport) => new OparlClient({ transport }).get(fx.SYSTEM_URL),
    () => jsonResponse(fx.system),
  );
  assert.equal(cli.code, 0);
  assert.equal(library.ok, true);
  assert.deepEqual(JSON.parse(cli.out), library.value);
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    library.requests.map((r) => r.url),
  );
  assert.equal(cli.requests.length, 1);
});

test("listLimitProblem accepts an integer from 1 to MAX_LIST_LIMIT and nothing else", () => {
  assert.equal(MAX_LIST_LIMIT, 1000);
  for (const ok of [1, 2, 999, MAX_LIST_LIMIT]) assert.equal(listLimitProblem(ok), undefined, String(ok));
  for (const bad of [0, -1, 1.5, MAX_LIST_LIMIT + 1, Number.NaN, Number.POSITIVE_INFINITY, 1e20, "5" as unknown as number]) {
    assert.equal(listLimitProblem(bad), `Expected an integer from 1 to ${MAX_LIST_LIMIT}.`, String(bad));
  }
});

test("listQuery rejects an invalid limit with 'Invalid limit: …'", () => {
  assert.throws(
    () => listQuery({ limit: 0 }),
    (err: unknown) => err instanceof OparlValidationError && err.message === "Invalid limit: Expected an integer from 1 to 1000.",
  );
  assert.equal(listQuery({ limit: 5 })["limit"], 5);
});

test("maxPagesProblem accepts a non-negative safe integer and nothing else", () => {
  for (const ok of [0, 1, 2, 10_000, Number.MAX_SAFE_INTEGER]) assert.equal(maxPagesProblem(ok), undefined, String(ok));
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e20, "1" as unknown as number]) {
    assert.equal(maxPagesProblem(bad), "Expected a non-negative integer.", String(bad));
  }
});

// Classes F, F3 and F4 of .reviews/2026-10-27-security-audit (portfolio round). WHATWG ends an
// http(s) authority at "\" and skips any "/" and "\" after a special scheme (`http:///u:pw@h`,
// `https:\\u:pw@h`, `http:u:pw@h`), repairing the URL silently: the host requested was not the
// one typed, and the userinfo read after "://" was missed, so a refused URL echoed its password.
test("a URL with a backslash, or whose scheme is not followed by exactly // and the host, is refused by the CLI and the library, never echoing the password (F, F3, F4)", async () => {
  const pw = "s3cret-Pw";
  const cases: Array<[string, RegExp]> = [
    [`https://alice:${pw}@ris.example\\@evil.example/oparl/system`, /backslash/],
    ["https://ris.example\\evil/oparl/system", /backslash/],
    [`https:\\\\alice:${pw}@ris.example/oparl/system`, /backslash/],
    [`http:alice:${pw}@127.0.0.1:9/oparl/system`, /"https:\/\/" and the host/],
    [`http:/alice:${pw}@127.0.0.1:9/oparl/system`, /"https:\/\/" and the host/],
    [`http:///alice:${pw}@127.0.0.1:9/oparl/system`, /"https:\/\/" and the host/],
    [`HTTPS:alice:${pw}@ris.example/oparl/system`, /"https:\/\/" and the host/],
    ["https:/ris.example/oparl/system", /"https:\/\/" and the host/],
    // A refusal for another reason quotes the value: its userinfo is found after the slashes.
    [`http:///alice:${pw}@ris.example/oparl/system​`, /invisible/],
  ];
  for (const [url, reason] of cases) {
    const o = await parity(["system", url], (t) => new OparlClient({ transport: t }).system(url));
    assert.equal(o.cli.code, 2, `${url}: ${o.cli.err}`);
    assert.equal(o.cli.requests.length + o.lib.requests.length, 0, url);
    assert.match(o.cli.err, reason, url);
    assert.ok(!o.cli.err.includes(pw) && !o.cli.out.includes(pw), o.cli.err);
    assert.ok(o.lib.error instanceof OparlValidationError, `${url}: ${String(o.lib.error)}`);
    assert.match(o.lib.error.message, reason, url);
    assert.ok(!o.lib.error.message.includes(pw), o.lib.error.message);
  }
  // The registry URL is checked by the same rule, as a client option and as --registry-url.
  assert.throws(() => new OparlClient({ registryUrl: `http:///alice:${pw}@reg.example/api` }), /Invalid registryUrl: .*"https:\/\/" and the host/);
  // A plain URL, any case, is accepted as before.
  const ok = await parity(["get", "HTTPS://RIS.Example.de/oparl/system"], (t) => new OparlClient({ transport: t }).get("HTTPS://RIS.Example.de/oparl/system"), () =>
    jsonResponse({ id: "https://ris.example.de/oparl/system", type: "https://schema.oparl.org/1.1/System" }),
  );
  assert.equal(ok.cli.code, 0, ok.cli.err);
  assert.equal(ok.cli.requests[0]?.url, "https://ris.example.de/oparl/system");
});
