#!/usr/bin/env node
// Re-check every known OParl endpoint live and rewrite src/client/endpoints-list.ts.
//
// Checks the entries of the dev.oparl.org registry and of the curated list: an endpoint
// counts as working when its System and the first pages of its bodies list load. The
// registry itself is rarely updated, so these checks are what `oparl endpoints` reports
// as `working`/`checked`/`problem`. `title`, `url`, `note` and `replacedBy` are kept as
// written; everything else is overwritten.
//
//   npm run check-endpoints                    # build, check, rewrite the list
//   node scripts/check-endpoints.mjs --dry-run # check and report only
//
// Options: --dry-run, --concurrency <n> (default 4), --timeout <ms> (default 60000),
// --only registry|curated. Run it from the repository root, after `npm run build`.

import { writeFileSync } from "node:fs";
import {
  CURATED_ENDPOINTS,
  OparlApiError,
  OparlClient,
  OparlLinkError,
  OparlNetworkError,
  REGISTRY_CHECKS,
  endpointKey,
  resolveLink,
  shortOparlVersion,
} from "../dist/src/index.js";

const LIST_FILE = new URL("../src/client/endpoints-list.ts", import.meta.url);
const BODY_PAGES = 20;

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const dryRun = process.argv.includes("--dry-run");
const concurrency = Number(option("--concurrency", "4"));
const timeoutMs = Number(option("--timeout", "60000"));
const only = option("--only", "all");
if (!["all", "registry", "curated"].includes(only) || !(concurrency >= 1) || !(timeoutMs >= 1000)) {
  console.error("Usage: check-endpoints.mjs [--dry-run] [--concurrency n] [--timeout ms] [--only registry|curated]");
  process.exit(2);
}

const client = new OparlClient({ timeoutMs, curatedEndpoints: [], registryChecks: [] });
const today = new Date().toISOString().slice(0, 10);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);

/** A short reason for a failed check. */
function problemOf(err) {
  if (err instanceof OparlApiError) return `HTTP ${err.status}`;
  if (err instanceof OparlLinkError) {
    const target = /follow (\S+)/.exec(err.message)?.[1];
    return target ? `redirects to ${new URL(target).host}` : "link to another host";
  }
  if (err instanceof OparlNetworkError) {
    const code = err.cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
    if (code === "ECONNREFUSED") return "connection refused";
    if (code === "ECONNRESET") return "connection reset";
    if (/certificate|CERT|SELF_SIGNED/i.test(`${code} ${err.message}`)) return "TLS certificate not verifiable";
    if (/timed out/.test(err.message)) return "timeout";
    return err.message.slice(0, 80);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/HTML page/.test(message)) return "HTML page instead of OParl";
  if (/not an OParl System/.test(message)) return "not an OParl System";
  if (/error object/.test(message)) return message.replace(/^.*error object: /, "error: ").slice(0, 80);
  return message.slice(0, 80);
}

async function probe(url) {
  try {
    const system = await client.system(url);
    const bodies = await client.walk(resolveLink(url, system.body), undefined, BODY_PAGES);
    return {
      working: true,
      problem: null,
      oparlVersion: text(system.oparlVersion) ? shortOparlVersion(system.oparlVersion) : null,
      systemName: text(system.name),
      vendor: text(system.vendor),
      bodyCount: bodies.data.length,
    };
  } catch (err) {
    return { working: false, problem: problemOf(err) };
  }
}

/** Run `fn` over `items`, `concurrency` at a time, reporting progress on stderr. */
async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
        done += 1;
        process.stderr.write(`\r${done}/${items.length} checked`);
      }
    }),
  );
  process.stderr.write("\n");
  return results;
}

const changes = [];
function note(title, before, after) {
  if (before !== undefined && before !== after.working) {
    changes.push(`${after.working ? "now working" : "now failing"}: ${title}${after.problem ? ` (${after.problem})` : ""}`);
  }
}

let registryChecks = [...REGISTRY_CHECKS];
if (only !== "curated") {
  // The registry lists a few Systems twice; check each once.
  const keys = new Set();
  const registry = (await client.endpoints({ source: "registry" })).filter((entry) => {
    const key = endpointKey(entry.url);
    return !keys.has(key) && keys.add(key);
  });
  const previous = new Map(REGISTRY_CHECKS.map((check) => [endpointKey(check.url), check]));
  const probed = await pool(registry, (entry) => probe(entry.url));
  registryChecks = registry.map((entry, i) => {
    const before = previous.get(endpointKey(entry.url));
    const result = probed[i];
    note(entry.title, before?.working, result);
    return {
      url: entry.url,
      working: result.working,
      checked: today,
      problem: result.problem,
      // The check fetched the System: its version, name, vendor and body count are
      // fresher than the registry's cached copy, which is missing for some endpoints.
      // A failed check knows nothing, so the last known values are kept.
      ...(result.working
        ? { oparlVersion: result.oparlVersion, systemName: result.systemName, vendor: result.vendor, bodyCount: result.bodyCount }
        : {
            oparlVersion: before?.oparlVersion ?? null,
            systemName: before?.systemName ?? null,
            vendor: before?.vendor ?? null,
            bodyCount: before?.bodyCount ?? null,
          }),
      replacedBy: before?.replacedBy ?? null,
      note: before?.note ?? null,
    };
  });
  registryChecks.sort((a, b) => a.url.localeCompare(b.url));
}

let curated = [...CURATED_ENDPOINTS];
if (only !== "registry") {
  const probed = await pool(curated, (entry) => probe(entry.url));
  curated = curated.map((entry, i) => {
    const result = probed[i];
    note(entry.title, entry.working, result);
    return result.working
      ? { ...entry, ...result, checked: today }
      : { ...entry, working: false, problem: result.problem, checked: today };
  });
  curated.sort((a, b) => a.title.localeCompare(b.title, "de"));
}

const count = (list) => `${list.filter((e) => e.working).length} of ${list.length} working`;
console.log(`registry: ${count(registryChecks)}`);
console.log(`curated:  ${count(curated)}`);
for (const change of changes) console.log(`  ${change}`);

const registryKeys = new Set(registryChecks.map((check) => endpointKey(check.url)));
for (const entry of curated) {
  if (registryKeys.has(endpointKey(entry.url))) {
    console.log(`  note: "${entry.title}" is now in the registry and can be removed from the curated list`);
  }
}

if (dryRun) {
  console.log("dry run: src/client/endpoints-list.ts not changed");
} else {
  writeFileSync(LIST_FILE, render(curated, registryChecks));
  console.log("wrote src/client/endpoints-list.ts");
}

function render(curatedList, checks) {
  const curatedFields = ["title", "url", "working", "checked", "problem", "oparlVersion", "systemName", "vendor", "bodyCount", "note"];
  const checkFields = ["url", "working", "checked", "problem", "oparlVersion", "systemName", "vendor", "bodyCount", "replacedBy", "note"];
  const pick = (object, fields) => Object.fromEntries(fields.map((field) => [field, object[field] ?? null]));
  const json = (list, fields) => JSON.stringify(list.map((item) => pick(item, fields)), null, 2);
  return `// The curated OParl endpoint list, maintained with scripts/check-endpoints.mjs.
//
// CURATED_ENDPOINTS: OParl servers the public registry at dev.oparl.org doesn't list.
// REGISTRY_CHECKS: live checks of the registry's own entries (the registry is rarely
// updated), with the new URL of servers that moved.
//
// \`npm run check-endpoints\` re-checks every endpoint and rewrites this file. To add an
// endpoint, append { title, url, note } plus the other fields (null/false/"") to
// CURATED_ENDPOINTS and run it. \`note\` and \`replacedBy\` are kept as written.

import type { CuratedEndpoint, RegistryCheck } from "./types.js";

export const CURATED_ENDPOINTS: readonly CuratedEndpoint[] = ${json(curatedList, curatedFields)};

export const REGISTRY_CHECKS: readonly RegistryCheck[] = ${json(checks, checkFields)};
`;
}
