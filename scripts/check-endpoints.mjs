#!/usr/bin/env node
// Re-check every known OParl endpoint live and rewrite src/client/endpoints-list.ts.
//
// Checks the entries of the dev.oparl.org registry and of the curated list: an endpoint
// counts as working when its System and the first pages of its bodies list load. The
// registry itself is rarely updated, so these checks are what `oparl endpoints` reports
// as `working`/`checked`/`problem`.
//
// `title`, `url`, `note` and `replacedBy` are kept as written, and `working`, `checked`
// and `problem` always come from this run. The System data (version, name, vendor, body
// count) is refreshed by a check that got that far, and a failing check keeps the last
// known values, so an entry that is down still shows what it last served.
//
// The lists themselves are read from src/client/endpoints-list.ts, the file this script
// rewrites, so that a hand-added endpoint or a hand-edited note is checked and kept; only
// the client comes from dist/, which `npm run check-endpoints` builds first.
//
//   npm run check-endpoints                    # build, check, rewrite the list
//   node scripts/check-endpoints.mjs --dry-run # check and report only
//
// Options: --dry-run, --concurrency <n> (default 4), --timeout <ms> (default 60000),
// --only registry|curated, --allow-shrink (write even when the registry lists far fewer
// endpoints than are on record). Run it from anywhere, after `npm run build`.

import { readFileSync, writeFileSync } from "node:fs";
import {
  OparlApiError,
  OparlClient,
  OparlLinkError,
  OparlNetworkError,
  endpointKey,
  resolveLink,
  shortOparlVersion,
} from "../dist/src/index.js";

const LIST_FILE = new URL("../src/client/endpoints-list.ts", import.meta.url);
const BODY_PAGES = 20;
/**
 * The share of the registry entries on record that a registry answer has to still list
 * before this script rewrites the file. A registry that answers HTTP 200 with a fraction
 * of its entries (or none) would otherwise delete the checks, notes and `replacedBy` URLs
 * of every endpoint it left out.
 */
const REGISTRY_FLOOR = 0.8;

const USAGE =
  "Usage: check-endpoints.mjs [--dry-run] [--allow-shrink] [--concurrency n] [--timeout ms] [--only registry|curated]";
/** A usage error: nothing was checked and nothing written. */
function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
/** A run that cannot finish safely. */
function abort(message) {
  console.error(message);
  process.exit(1);
}

// Strict parsing: an unknown or mistyped flag must not be dropped silently, since
// `--dryrun` would then rewrite the list and fire a few hundred requests at municipal
// servers, and `--only=curated` would check the whole registry.
const SWITCHES = ["--dry-run", "--allow-shrink"];
const VALUED = ["--concurrency", "--timeout", "--only"];
const given = { "--concurrency": "4", "--timeout": "60000", "--only": "all" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  const eq = token.indexOf("=");
  const name = eq === -1 ? token : token.slice(0, eq);
  if (SWITCHES.includes(name)) {
    if (eq !== -1) usageError(`${name} takes no value.`);
    given[name] = true;
  } else if (VALUED.includes(name)) {
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined || value === "" || value.startsWith("-")) usageError(`${name} needs a value.`);
    given[name] = value;
  } else {
    usageError(`Unknown option "${token}".`);
  }
}
const dryRun = given["--dry-run"] === true;
const allowShrink = given["--allow-shrink"] === true;
const concurrency = Number(given["--concurrency"]);
const timeoutMs = Number(given["--timeout"]);
const only = given["--only"];
if (!["all", "registry", "curated"].includes(only)) usageError(`--only takes all, registry or curated, not "${only}".`);
if (!(concurrency >= 1)) usageError("--concurrency takes a number >= 1.");
if (!(timeoutMs >= 1000)) usageError("--timeout takes a number of milliseconds >= 1000.");

/**
 * One of the JSON arrays in the generated list file. This script writes the file, so its
 * arrays are plain JSON; a hand edit has to keep that form.
 */
function readList(source, name) {
  const at = source.indexOf(`export const ${name}`);
  // From the `=`, so that the `[]` of the type annotation is not mistaken for the list.
  const eq = at === -1 ? -1 : source.indexOf("=", at);
  const open = eq === -1 ? -1 : source.indexOf("[", eq);
  if (open === -1) abort(`${name} is not in ${LIST_FILE.pathname}; nothing was checked.`);
  let depth = 0;
  let inString = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth > 0) continue;
      try {
        return JSON.parse(source.slice(open, i + 1));
      } catch (err) {
        abort(`${name} in ${LIST_FILE.pathname} is not plain JSON (${err.message}); nothing was checked.`);
      }
    }
  }
  abort(`${name} in ${LIST_FILE.pathname} is not a closed array; nothing was checked.`);
}

const listSource = readFileSync(LIST_FILE, "utf8");
const curatedOnRecord = readList(listSource, "CURATED_ENDPOINTS");
const checksOnRecord = readList(listSource, "REGISTRY_CHECKS");
// Every entry of both lists has exactly one `url`, so this catches a file whose shape
// the reader above got wrong before anything is overwritten with a partial list.
const urlsInFile = (listSource.match(/^\s*"url":/gm) ?? []).length;
if (urlsInFile !== curatedOnRecord.length + checksOnRecord.length) {
  abort(
    `Read ${curatedOnRecord.length + checksOnRecord.length} endpoints from ${LIST_FILE.pathname}, which holds ` +
      `${urlsInFile}; nothing was checked.`,
  );
}

const client = new OparlClient({ timeoutMs, curatedEndpoints: [], registryChecks: [] });
const today = new Date().toISOString().slice(0, 10);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);

/**
 * A short reason for a link (or redirect `Location`) this client refuses to follow.
 * The target is dug out of the message, which is all the error carries — and it is
 * server text, so it is not necessarily a URL at all.
 */
function linkProblem(message) {
  if (/invalid link/.test(message)) return "the server returned an invalid link";
  let target = null;
  try {
    target = new URL(/Refusing to follow (?:a non-http link: )?(\S+)/.exec(message)?.[1] ?? "");
  } catch {
    target = null;
  }
  if (/non-http link/.test(message)) return `link to a non-http URL${target ? ` (${target.protocol})` : ""}`;
  if (/another port/.test(message)) return `points to another port${target ? `: ${target.port}` : ""}`;
  return `points to another host${target ? `: ${target.host}` : ""}`;
}

/** A short reason for a failed check. */
function problemOf(err) {
  if (err instanceof OparlApiError) return `HTTP ${err.status}`;
  if (err instanceof OparlLinkError) return linkProblem(err.message);
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
  // These three name the URL first, so the fallback below would record a `problem` that
  // is a cut-off copy of the endpoint's own URL ("Expected an OParl object from https://…").
  const notAnObject = /^Expected an OParl object from \S+ but got (.*)\.$/.exec(message);
  if (notAnObject) return `not an OParl object (got ${notAnObject[1]})`;
  if (/^Empty response from /.test(message)) return "empty response";
  if (/^Failed to parse JSON response from /.test(message)) return "response is not JSON";
  return message.slice(0, 80);
}

/** `problemOf` must never be the reason a whole run fails: see the note in `probe`. */
function describeFailure(err) {
  try {
    return problemOf(err);
  } catch {
    return "check failed";
  }
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
    // Everything one endpoint can do ends here: a rejection escaping this catch would
    // take down `pool`'s Promise.all and with it the whole run, reporting nothing.
    return { working: false, problem: describeFailure(err) };
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

let registryChecks = checksOnRecord;
if (only !== "curated") {
  // The registry lists a few Systems twice; check each once.
  const keys = new Set();
  const registry = (await client.endpoints({ source: "registry" })).filter((entry) => {
    const key = endpointKey(entry.url);
    return !keys.has(key) && keys.add(key);
  });
  const previous = new Map(checksOnRecord.map((check) => [endpointKey(check.url), check]));
  if (registry.length < Math.floor(previous.size * REGISTRY_FLOOR) && !allowShrink) {
    abort(
      `The registry answered with ${registry.length} endpoints, but ${previous.size} checks are on record. ` +
        "Refusing to rewrite the list from what looks like a partial answer: it would delete the checks, " +
        "notes and replacedBy URLs of every endpoint it left out. Try again later, or pass --allow-shrink " +
        "if the registry really has shrunk that much.",
    );
  }
  for (const [key, check] of previous) {
    if (keys.has(key)) continue;
    const handWritten = check.note || check.replacedBy ? " — it carried a note or replacedBy" : "";
    changes.push(`dropped, the registry no longer lists it: ${check.url}${handWritten}`);
  }
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

let curated = curatedOnRecord;
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

/**
 * Fold a curated entry into the registry check for the same System: the newer of the
 * two checks decides whether the endpoint works, and the hand-written note is kept.
 */
function fold(check, entry) {
  const fresher =
    entry.checked > check.checked
      ? {
          working: entry.working,
          checked: entry.checked,
          problem: entry.problem,
          oparlVersion: entry.oparlVersion,
          systemName: entry.systemName,
          vendor: entry.vendor,
          bodyCount: entry.bodyCount,
        }
      : {};
  return { ...check, ...fresher, note: check.note ?? entry.note };
}

// The registry has caught up with a curated server: the file keeps one record per
// System, so the curated entry is folded into the registry check and dropped. Left in
// place it would fail the shipped consistency test, and `endpoints()` lists the System
// once anyway.
const checkIndex = new Map(registryChecks.map((check, i) => [endpointKey(check.url), i]));
const keptCurated = [];
for (const entry of curated) {
  const at = checkIndex.get(endpointKey(entry.url));
  if (at === undefined) {
    keptCurated.push(entry);
    continue;
  }
  registryChecks[at] = fold(registryChecks[at], entry);
  changes.push(`folded into the registry checks, which list it now: "${entry.title}"`);
}
curated = keptCurated;

const count = (list) => `${list.filter((e) => e.working).length} of ${list.length} working`;
console.log(`registry: ${count(registryChecks)}`);
console.log(`curated:  ${count(curated)}`);
for (const change of changes) console.log(`  ${change}`);

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
// \`npm run check-endpoints\` re-checks every endpoint and rewrites this file, reading the
// two lists from here — so a hand-added entry is checked and kept, as long as it stays in
// the same plain JSON as the rest. To add an endpoint, append { title, url, note } plus
// the other fields (null/false/"") to CURATED_ENDPOINTS and run it. \`note\` and
// \`replacedBy\` are kept as written, and a failing check keeps the System data (version,
// name, vendor, body count) of the last successful one.

import type { CuratedEndpoint, RegistryCheck } from "./types.js";

/**
 * Freeze a list and its entries: \`readonly\` is compile-time only, and these are the
 * data every OparlClient reads, so a JS consumer must not be able to change them.
 */
const frozen = <T>(list: T[]): readonly T[] => Object.freeze(list.map((entry) => Object.freeze(entry)));

export const CURATED_ENDPOINTS: readonly CuratedEndpoint[] = frozen(${json(curatedList, curatedFields)});

export const REGISTRY_CHECKS: readonly RegistryCheck[] = frozen(${json(checks, checkFields)});
`;
}
