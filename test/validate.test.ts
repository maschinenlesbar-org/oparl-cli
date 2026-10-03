import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { OparlError, OparlValidationError } from "../src/client/errors.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { OparlClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";
import * as fx from "./fixtures.js";

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

test("run() maps an OparlValidationError raised in an action to exit 2 with 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => undefined },
    createClient: () => {
      throw new OparlValidationError("Invalid thing: Expected another thing.");
    },
  };
  assert.equal(await run(["get", fx.SYSTEM_URL], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected another thing."]);
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
