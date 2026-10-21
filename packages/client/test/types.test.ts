// Compile-time checks of the exported option types, and their runtime counterpart: an option
// given as undefined means the same as an omitted one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OparlClient } from "../src/index.js";
import { jsonResponse, routes } from "./helpers.js";
import { BODY_URL, MEETINGS_URL, SYSTEM_URL, BODIES_URL, body, bodyList, system } from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ userAgent: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "oparl-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { OparlClient, type EngineOptions, type OparlClientOptions, type ListOptions, type EndpointsOptions, type EndpointFilters } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const options: OparlClientOptions = allUndefined<OparlClientOptions>();",
        "export const list: ListOptions = allUndefined<ListOptions>();",
        "export const endpoints: EndpointsOptions = allUndefined<EndpointsOptions>();",
        "export const filters: EndpointFilters = allUndefined<EndpointFilters>();",
        "export const client = new OparlClient({ userAgent: process.env.OPARL_USER_AGENT, timeoutMs: 15_000 });",
        "export const bodies = (url: string) => client.bodies(url, { maxPages: process.env.PAGES === undefined ? undefined : 2 });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const table = {
    [SYSTEM_URL]: jsonResponse(system),
    [BODIES_URL]: jsonResponse(bodyList),
    [BODY_URL]: jsonResponse(body),
    [MEETINGS_URL]: jsonResponse({ data: [], links: {} }),
  };
  const mt = routes(table);
  const client = new OparlClient({
    registryUrl: undefined,
    curatedEndpoints: undefined,
    registryChecks: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.list(BODY_URL, "meeting", {
    maxPages: undefined,
    createdSince: undefined,
    createdUntil: undefined,
    modifiedSince: undefined,
    modifiedUntil: undefined,
    limit: undefined,
    omitInternal: undefined,
  });
  assert.equal(mt.last().url, MEETINGS_URL);
  assert.equal(mt.last().timeoutMs, 120_000);
  assert.equal(mt.last().headers?.["User-Agent"], "oparl-cli");
  const bodies = await client.bodies(SYSTEM_URL, { maxPages: undefined });
  assert.equal(bodies.pages, 1);
  const curated = await client.endpoints({ source: "curated", search: undefined, oparlVersion: undefined, working: undefined });
  const all = await client.endpoints({ source: "curated" });
  assert.deepEqual(curated, all);
  assert.ok(curated.length > 0);
});
