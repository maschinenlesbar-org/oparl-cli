// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's tools, a
// library user) has to know them:
// - findEndpoints (oparl-endpoint-finder, step 1): the known OParl servers that match a place, a
//   product or a version, from the registry at dev.oparl.org and the curated list, with what to
//   do when nothing matches (shared servers, the county);
// - checkEndpoint (oparl-endpoint-finder, steps 2 to 4): whether a server answers now, what it
//   runs, its bodies with the lists each offers, and the licence System and Body declare, read
//   strictly ("Open" or a date declares nothing);
// - findPapers (oparl-council-activity): a body's papers new or changed since a day, with the
//   checks the skill makes by hand: did the server honour the date filter, are its change dates
//   real, is an HTTP 404 an empty window; deleted stubs dropped, undated papers kept and flagged;
// - findMeetings (oparl-council-activity): a body's meetings in a window (upcoming by default),
//   sorted by start, the pages read until one has none in the window;
// - listObjects and getObject, for what those don't reach: one of a body's lists (committees,
//   people, legislative terms, …), and any object by its URL.
//
// Every URL a caller passes must be on a host of a known OParl server (the curated list and the
// registry's entries this package checked, with their new URLs), or on one of `extraHosts` (what
// the MCP server's operator configured): never an address of the caller's choosing. From there the
// client follows links and redirects on the same host only (resolveLink, OparlLinkError).
//
// The rules they keep: no bare "not found" (an empty answer says what was searched and what to
// try); each answer is a named type (public API of the CLI package: a changed shape is a
// `feat(client)!:` commit); every request an answer started is kept (`requestsOf(answer)`), for
// its source.

import { bodyListUrl, endpointKey, LIST_TYPES, listQuery, shortOparlVersion, type ListType, type OparlClient } from "./client.js";
import { carryQuery, encodeTimestampPlus, resolveLink } from "./engine.js";
import { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "./endpoints-list.js";
import { foldSearchText } from "./endpoints-search.js";
import { OparlApiError, OparlError, OparlLinkError, OparlNetworkError, OparlParseError, OparlValidationError } from "./errors.js";
import type { JsonObject, JsonValue, ListResult, OparlObject, RegistryEntry } from "./types.js";
import { assertValid, intRangeProblem, normalizeText, textProblem } from "./validate.js";

// ---- the hosts a caller may reach ---------------------------------------------------------------

const hostOf = (url: string): string => new URL(url).host.toLowerCase();

let known: ReadonlySet<string> | undefined;

/**
 * The hosts of the OParl servers this package knows: the curated list and the registry entries it
 * checked, their new URLs (replacedBy) included. A fixed list, shipped with the package.
 */
export function knownHosts(): ReadonlySet<string> {
  known ??= new Set(
    [...CURATED_ENDPOINTS.map((e) => e.url), ...REGISTRY_CHECKS.flatMap((e) => (e.replacedBy === null ? [e.url] : [e.url, e.replacedBy]))].map(hostOf),
  );
  return known;
}

/**
 * Why `url` is not one the operations fetch, or undefined: an absolute http(s) URL on a host of
 * {@link knownHosts} or of `extraHosts` (host[:port], as configured by whoever runs the caller).
 */
export function reachProblem(url: string, extraHosts: readonly string[] = []): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "Expected an absolute http(s) URL of an OParl object, from these tools' answers (an id, a body, next).";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Expected an http(s) URL.";
  if (parsed.username !== "" || parsed.password !== "") return "A URL with a user name or password is not taken.";
  const host = parsed.host.toLowerCase();
  if (knownHosts().has(host) || extraHosts.some((h) => h.toLowerCase() === host)) return undefined;
  return (
    `${host} is not the host of a known OParl server. Only the servers of the endpoint lists are reached (findEndpoints lists them); ` +
    "take URLs from these tools' answers, never build one. A server missing from the lists can be asked with the oparl CLI."
  );
}

/** `url` trimmed, or an OparlValidationError naming `name` when it may not be fetched. */
function reachable(name: string, url: string | undefined, extraHosts: readonly string[] | undefined): string {
  if (typeof url !== "string" || url.trim() === "") throw new OparlValidationError(`Invalid ${name}: expected a URL.`);
  const problem = reachProblem(url, extraHosts);
  if (problem !== undefined) throw new OparlValidationError(`Invalid ${name}: ${problem}`);
  return url.trim();
}

// ---- the requests an answer started ---------------------------------------------------------------

const REQUESTS = new WeakMap<object, readonly string[]>();

/**
 * The requests the operation that returned `answer` started, in order, as absolute URLs (a walk's
 * later pages aside: the answer counts them in `pagesRead`; findEndpoints' registry only when it
 * answered). What its `source` names. Empty for an object no operation returned.
 */
export function requestsOf(answer: object): readonly string[] {
  return REQUESTS.get(answer) ?? [];
}

function done<T extends object>(answer: T, requests: readonly string[]): T {
  REQUESTS.set(answer, [...requests]);
  return answer;
}

// ---- reading OParl's JSON ---------------------------------------------------------------------

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day of a date or timestamp as the server wrote it (YYYY-MM-DD), or undefined. */
const dayOf = (value: unknown): string | undefined => {
  const text = textOf(value);
  return text !== undefined && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;
};

/** A day given by a caller, checked (YYYY-MM-DD, a real date). */
function checkedDay(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const date = new Date(`${text}T00:00:00Z`);
  if (!DAY.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new OparlValidationError(`Invalid ${name}: expected a day as YYYY-MM-DD, got ${JSON.stringify(text.slice(0, 40))}.`);
  }
  return text;
}

/** The day `now` is in Germany (the servers' days), as YYYY-MM-DD. */
function berlinDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Every word of `query` (folded: case, accents and ß aside) in one of `texts`. */
function matchesWords(query: string | undefined, ...texts: (string | undefined)[]): boolean {
  if (query === undefined) return true;
  const haystack = foldSearchText(texts.filter((t) => t !== undefined).join(" "));
  return foldSearchText(query)
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((word) => haystack.includes(word));
}

/** The last part of an OParl type URI (`https://schema.oparl.org/1.1/Paper` → `Paper`). */
const kindOf = (type: unknown): string | undefined => textOf(type)?.split("/").pop();

/** The OParl version of a type URI (`…/1.0/Body` → `1.0`). */
const versionOfType = (type: unknown): string | undefined => /\/(\d+\.\d+)\/[A-Za-z]+$/.exec(textOf(type) ?? "")?.[1];

/** A positive whole number within bounds, or the default. */
function count(name: string, value: number | undefined, fallback: number, max: number): number {
  return assertValid(name, value ?? fallback, intRangeProblem(1, max));
}

/** Where a page of matches starts (`offset`, default 0), checked. */
function startAt(value: number | undefined): number {
  return assertValid("offset", value ?? 0, intRangeProblem(0, 10_000));
}

/**
 * The matches from `offset`, at most `limit`, and where the next ones start: what the limit (or a
 * caller's size cap) leaves out of the pages read is reached with the same arguments and that
 * offset, the same pages read again; `next` reads the pages after them. A note says so.
 */
function matchesPage<T>(hits: readonly T[], offset: number, limit: number, what: string, notes: string[]): { shown: T[]; nextOffset?: number } {
  const shown = hits.slice(offset, offset + limit);
  if (offset + shown.length >= hits.length) return { shown };
  notes.push(
    `${shown.length} of the ${hits.length} matching ${what} of the pages read are shown, from offset ${offset}: call again with the same arguments and offset = nextOffset for the rest (the same pages are read again); next reads the pages after them.`,
  );
  return { shown, nextOffset: offset + shown.length };
}

/** The reason of an answer whose offset is past its matches. */
const pastTheEnd = (offset: number, total: number): string => `offset ${offset} is past the last of the ${total} matches on the pages read. Start again at offset 0 (or a lower one).`;

/** An optional text filter, checked and normalised. */
function filterText(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeText(assertValid(name, value, textProblem));
}

// ---- licences ---------------------------------------------------------------------------------

/** What a server's `license` field says, read strictly (oparl-endpoint-finder, step 4). */
export interface LicenceStatement {
  /** True only for a licence URL or a recognisable licence name. */
  declared: boolean;
  /** The field as the server sent it. */
  value?: string;
  /** The licence by its usual name, where recognised (CC BY 4.0, DL-DE Zero 2.0, …). */
  label?: string;
  /** What it means for reuse. */
  note: string;
}

/** A licence's version as the value names it (4.0, by-nc-1-0, Version 2.0), as "N.N". */
const versionIn = (value: string): string | undefined => {
  const match = /(\d)[-.](\d)(?!\d)/.exec(value);
  return match === null ? undefined : `${match[1]}.${match[2]}`;
};

/** A token of its own (cc-by-nc, by-nc/4.0, "BY NC"): not part of a word. */
const token = (word: string): RegExp => new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`);

/** A licence name right after a negation ("Nicht CC BY", "no cc-by", "keine CC-Lizenz"): it names the licence only to negate it. */
const NEGATED = /(?:^|[^a-z])(?:nicht|kein(?:e|en)?|no|not|without|ohne)[\s:–-]+(?:eine?\s+)?(?:cc\b|cc[- ]|creative|dl-|datenlizenz|odbl)/;

interface LicenceReading {
  label: string;
  /** No conditions at all (CC0, DL-DE Zero). */
  zero?: boolean;
  nc?: boolean;
  nd?: boolean;
  sa?: boolean;
  /** A licence family named without the licence (a bare "Creative Commons"): declares none. */
  unnamed?: boolean;
}

/**
 * The licence `value` names, with its restrictions (non-commercial, no derivatives, share-alike)
 * read from the whole value, so a restricted licence is never read as the looser one ("CC BY-NC
 * 4.0" is not "CC BY"); undefined when it names none this reading knows.
 */
function readLicence(value: string): LicenceReading | undefined {
  const v = value.toLowerCase();
  const nc = token("nc").test(v) || /non-?commercial|nicht[- ]?kommerziell/.test(v);
  const nd = token("nd").test(v) || /no-?deriv|keine bearbeitung/.test(v);
  const sa = token("sa").test(v) || /share-?alike|weitergabe unter gleichen bedingungen/.test(v);
  const version = versionIn(v);
  const restricted = (family: string, parts: (string | false)[]) =>
    `${family} ${parts.filter((p): p is string => p !== false).join("-")}${version === undefined ? "" : ` ${version}`}`;
  if (/publicdomain\/zero|\bcc[- ]?0\b|cc-zero/.test(v)) return { label: "CC0 1.0", zero: true };
  if (/dl-de[/-]zero|dl-zero-de|datenlizenz deutschland[^a-z]*zero/.test(v)) return { label: `DL-DE Zero ${version ?? "2.0"}`, zero: true };
  if (/creativecommons\.org\/licenses\/by|\bcc[- ]?by\b|creative ?commons/.test(v)) {
    if (!/licenses\/by|\bcc[- ]?by\b|namensnennung|attribution/.test(v)) return { label: "Creative Commons (which licence not named)", unnamed: true };
    return { label: restricted("CC", ["BY", nc && "NC", nd && "ND", sa && "SA"]), nc, nd, sa };
  }
  if (/dl-de[/-]by|dl-by-de|datenlizenz deutschland[^a-z]*namensnennung/.test(v)) return { label: restricted("DL-DE", ["BY", nc && "NC"]), nc };
  if (/\bodbl\b|opendatacommons\.org\/licenses\/odbl/.test(v)) return { label: "ODbL", sa: true };
  return undefined;
}

const NOT_DECLARED = "Reuse beyond reading needs the operator's permission; name the operator (the Body) as the source.";
const OTHER_RIGHTS = "person data and attached files can carry other rights.";

/**
 * A `license` field (System, Body, or any object) read strictly: a licence URL or a recognisable
 * licence name declares one, named with its restrictions (CC BY-NC 4.0, DL-DE BY-NC 1.0); anything
 * else (Düsseldorf's "Open", "Nutzung nur nach Genehmigung", a negated licence like "Nicht CC BY",
 * a bare "Creative Commons") declares nothing clear and is quoted; a `licenseValidSince` without a
 * licence declares nothing.
 */
export function licenceOf(license: unknown, validSince?: unknown): LicenceStatement {
  const value = textOf(license);
  if (value === undefined) {
    const since = textOf(validSince) === undefined ? "" : " (licenseValidSince is set, but a date without a licence declares nothing)";
    return { declared: false, note: `No licence declared${since}. ${NOT_DECLARED}` };
  }
  if (NEGATED.test(value.toLowerCase())) {
    return { declared: false, value, note: `The value names a licence only to negate it, so no licence is declared. ${NOT_DECLARED}` };
  }
  const read = readLicence(value);
  if (read?.unnamed === true) {
    return { declared: false, value, label: read.label, note: `Creative Commons names several licences, some non-commercial: this value doesn't say which, so none is declared. ${NOT_DECLARED}` };
  }
  if (read !== undefined) {
    const terms = read.zero === true
      ? `No conditions: reuse freely (naming the operator, the Body, is good practice); ${OTHER_RIGHTS}`
      : `Reuse under that licence, with its attribution${read.nc === true ? "; non-commercial use only" : ""}${read.nd === true ? "; no modified versions" : ""}${read.sa === true ? "; adaptations under the same licence" : ""}; ${OTHER_RIGHTS}`;
    return { declared: true, value, label: read.label, note: terms };
  }
  if (/^https?:\/\//i.test(value)) {
    return { declared: true, value, note: "A link to the operator's own terms: read them before reuse." };
  }
  return { declared: false, value, note: `Neither a licence URL nor a recognisable licence name, so not clearly declared. ${NOT_DECLARED}` };
}

// ---- findEndpoints ----------------------------------------------------------------------------

export const DEFAULT_ENDPOINTS = 20;
export const MAX_ENDPOINTS = 100;

/** An endpoint as findEndpoints lists it. */
export interface EndpointHit {
  title: string;
  /** The System URL: what checkEndpoint takes. */
  url: string;
  source: "registry" | "curated";
  /** The last live check's result (checked), else the registry's last fetch (fetched). */
  working: boolean;
  checked: string | null;
  fetched?: string;
  problem?: string;
  /** The server moved: use this URL, not url. */
  replacedBy?: string;
  /** Aggregators, archives, shared servers' other bodies, known problems. */
  note?: string;
  oparlVersion?: string;
  product?: string;
  vendor?: string;
  bodyCount?: number;
  /**
   * false when the URL to use (replacedBy, else url) is on a host the other operations don't reach
   * (a registry entry newer than the lists shipped with this package): ask it with the CLI.
   */
  reachable?: false;
}

export interface FindEndpointsParams {
  /** A place, a product host or part of a URL (case, accents and ä/ae spellings aside). */
  search?: string | undefined;
  /** 1.0 or 1.1. */
  oparlVersion?: string | undefined;
  /** Only endpoints that worked on their last check. */
  working?: boolean | undefined;
  /** Endpoints to skip: where the page starts (default 0). */
  offset?: number | undefined;
  limit?: number | undefined;
  /** Hosts the other operations reach besides the known ones (what the caller passes them too). */
  extraHosts?: readonly string[] | undefined;
}

export interface FindEndpointsAnswer {
  status: "ok" | "empty";
  reason?: string;
  searched: Record<string, JsonValue>;
  total: number;
  offset: number;
  endpoints: EndpointHit[];
  /** Where the next page starts, while there is one. */
  nextOffset?: number;
  /** With no match: working servers that host several bodies, whose bodies the search can't see. */
  sharedServers?: { title: string; url: string; bodyCount: number }[];
  notes: string[];
}

function hitOf(entry: RegistryEntry): EndpointHit {
  return {
    title: entry.title,
    url: entry.url,
    source: entry.source,
    working: entry.working,
    checked: entry.checked,
    ...(entry.checked === null && entry.fetched !== null ? { fetched: entry.fetched } : {}),
    ...(entry.problem === null ? {} : { problem: entry.problem }),
    ...(entry.replacedBy === null ? {} : { replacedBy: entry.replacedBy }),
    ...(entry.note === null ? {} : { note: entry.note }),
    ...(entry.oparlVersion === null ? {} : { oparlVersion: entry.oparlVersion }),
    ...(entry.systemName === null ? {} : { product: entry.systemName }),
    ...(entry.vendor === null ? {} : { vendor: entry.vendor }),
    ...(entry.bodyCount === null ? {} : { bodyCount: entry.bodyCount }),
  };
}

/**
 * The known OParl endpoints matching a search, working ones first. The registry at dev.oparl.org
 * (the client's registryUrl) is read live and merged with the curated list; the live checks shipped
 * with this package decide `working`. A registry that can't be read leaves the curated list, with
 * a note. No match is not "no OParl server": the answer says so and lists the shared servers.
 */
export async function findEndpoints(client: OparlClient, params: FindEndpointsParams = {}): Promise<FindEndpointsAnswer> {
  const search = filterText("search", params.search);
  const limit = count("limit", params.limit, DEFAULT_ENDPOINTS, MAX_ENDPOINTS);
  const offset = assertValid("offset", params.offset ?? 0, intRangeProblem(0, 10_000));
  const searched: Record<string, JsonValue> = {};
  if (search !== undefined) searched["search"] = search;
  if (params.oparlVersion !== undefined) searched["oparlVersion"] = params.oparlVersion;
  if (params.working === true) searched["working"] = true;
  const report = await client.endpointsReport({
    source: "all",
    ...(search === undefined ? {} : { search }),
    ...(params.oparlVersion === undefined ? {} : { oparlVersion: params.oparlVersion }),
    ...(params.working === true ? { working: true } : {}),
  });
  const notes: string[] = [];
  // The registry is a request of this answer only when it answered: else the curated list alone did.
  const read = report.registryError === undefined ? [client.registryUrl] : [];
  if (report.registryError !== undefined) {
    notes.push(`The registry could not be read (${report.registryError.message}); only the curated servers are listed, as of their last check. Say so before concluding that a place has no server.`);
  }
  if (report.note !== undefined) notes.push(report.note);
  const hits = report.entries
    .map(hitOf)
    .map((hit) => (reachProblem(hit.replacedBy ?? hit.url, params.extraHosts) === undefined ? hit : { ...hit, reachable: false as const }))
    .sort((a, b) => Number(b.working) - Number(a.working));
  if (hits.some((h) => h.replacedBy !== undefined)) notes.push("Some servers moved: use replacedBy, not url.");
  if (hits.some((h) => h.reachable === false)) {
    notes.push(
      "reachable false: the server is not on the hosts these tools know (newer in the registry than the lists shipped with them), so checkEndpoint and the other tools can't reach it; the oparl CLI can. Say so rather than calling it unavailable.",
    );
  }
  if (hits.some((h) => !h.working)) notes.push("working is a snapshot of the last check (checked, else the registry's fetched): checkEndpoint tells whether a server answers now.");
  if (hits.length === 0) {
    // The shipped lists' shared servers (no request): their bodies are not searched by name.
    // Aggregators and archives are no council's own server; a registry check has no title, so its
    // System's name stands in, with the host (several are just "OParl-Schnittstelle").
    const shared = [
      ...CURATED_ENDPOINTS.map((e) => ({ title: e.title, url: e.url, working: e.working, bodyCount: e.bodyCount, note: e.note })),
      ...REGISTRY_CHECKS.map((e) => {
        const url = e.replacedBy ?? e.url;
        return { title: `${e.systemName ?? "OParl"} (${hostOf(url)})`, url, working: e.working, bodyCount: e.bodyCount ?? null, note: e.note };
      }),
    ]
      .filter((e) => e.working && (e.bodyCount ?? 0) > 1 && !/aggregator|archive/i.test(e.note ?? ""))
      // One server listed under http and https (VG Hagenbach) is named once, by its https URL.
      .sort((a, b) => (b.bodyCount ?? 0) - (a.bodyCount ?? 0) || Number(b.url.startsWith("https:")) - Number(a.url.startsWith("https:")))
      .filter((e, i, all) => all.findIndex((o) => endpointKey(o.url).replace(/^https?:/, "") === endpointKey(e.url).replace(/^https?:/, "")) === i)
      .slice(0, 15)
      .map((e) => ({ title: e.title, url: e.url, bodyCount: e.bodyCount ?? 0 }));
    const reason =
      "No known endpoint matches. That does not mean there is no OParl server: both lists are incomplete, and the search matches titles, URLs and notes only, " +
      "not the bodies a shared server hosts. Try the county, the Verbandsgemeinde or the regional data centre, look at the bodies of the shared servers " +
      "(sharedServers, with checkEndpoint), or look for an OParl link on the council portal.";
    return done({ status: "empty", reason, searched, total: 0, offset, endpoints: [], ...(shared.length > 0 ? { sharedServers: shared } : {}), notes }, read);
  }
  const page = hits.slice(offset, offset + limit);
  if (page.length === 0) {
    const reason = `offset ${offset} is past the end: ${hits.length} endpoint${hits.length === 1 ? " matches" : "s match"}. Start again at offset 0 (or a lower one).`;
    return done({ status: "empty", reason, searched, total: hits.length, offset, endpoints: [], notes }, read);
  }
  const more = offset + page.length < hits.length ? { nextOffset: offset + page.length } : {};
  return done({ status: "ok", searched, total: hits.length, offset, endpoints: page, ...more, notes }, read);
}

// ---- checkEndpoint ----------------------------------------------------------------------------

/** A body as checkEndpoint lists it. */
export interface BodySummary {
  /** The Body URL: what findPapers, findMeetings and listObjects take. */
  id: string;
  name?: string;
  shortName?: string;
  ags?: string;
  oparlVersion?: string;
  website?: string;
  licence: LicenceStatement;
  /** The lists the body links (listObjects' types). */
  lists: ListType[];
}

export interface CheckEndpointParams {
  /** A System URL (from findEndpoints). */
  url: string;
  /** Pages of the body list to read (default 1). */
  maxPages?: number | undefined;
  extraHosts?: readonly string[] | undefined;
  /** The caller's deadline or cancellation: a page missing after it aborted is noted as such. */
  signal?: AbortSignal | undefined;
}

export interface CheckEndpointAnswer {
  status: "ok";
  url: string;
  /** Whether the System answered now. */
  live: boolean;
  /** Why not, as the client said it. */
  problem?: string;
  /** What it means and what to do (oparl-endpoint-finder, step 2). */
  advice?: string;
  /** The entry of the shipped lists for this URL, when there is one. */
  known?: { title?: string; working: boolean; checked: string; replacedBy?: string; note?: string };
  system?: { name?: string; oparlVersion?: string; product?: string; vendor?: string; website?: string; contactEmail?: string; licence: LicenceStatement };
  bodies: BodySummary[];
  notes: string[];
}

/** The lists a body links, under the spec field or a known fallback. */
function listsOf(body: JsonObject): ListType[] {
  return (Object.keys(LIST_TYPES) as ListType[]).filter((type) => typeof bodyListUrl(body, type) === "string");
}

function bodySummary(body: JsonObject): BodySummary {
  const text = (key: string) => textOf(body[key]);
  const version = versionOfType(body["type"]);
  return {
    id: text("id") ?? "",
    ...(text("name") === undefined ? {} : { name: text("name") as string }),
    ...(text("shortName") === undefined ? {} : { shortName: text("shortName") as string }),
    ...(text("ags") === undefined ? {} : { ags: text("ags") as string }),
    ...(version === undefined ? {} : { oparlVersion: version }),
    ...(text("website") === undefined ? {} : { website: text("website") as string }),
    licence: licenceOf(body["license"], body["licenseValidSince"]),
    lists: listsOf(body),
  };
}

/** What a failed System request means, in the skill's words. */
function adviceFor(err: OparlError): string {
  const message = err.message;
  if (err instanceof OparlNetworkError) {
    if (/certificate/i.test(message)) return "The server is up but doesn't send its intermediate TLS certificate; a client needs NODE_EXTRA_CA_CERTS with it. Never turn certificate checks off.";
    if (/closed the connection|HTTP 101/i.test(message)) return "Something answers at that address, but not with an HTTP response: not an OParl endpoint.";
    return "No answer in time or no connection: the server may just be slow or down for now. Try once more later before calling it gone.";
  }
  if (err instanceof OparlApiError) {
    if (err.status === 404 || err.status === 410) return "The endpoint moved or is gone: report it with the last check's date and any replacedBy.";
    if (err.status >= 500) return "The server is up but failing. Try once more; if it fails again, report it as not answering today rather than gone.";
    return "The server refused the request: report it as not answering.";
  }
  return "No OParl System there (an HTML page or another object): the endpoint moved or is gone.";
}

/**
 * Why an object the server answered with is not a System to check, and what that means: another
 * OParl object or a list page (the server answers; the URL is not its entry point), a System
 * without the URL of its list of bodies (a server-side defect), or no OParl object at all.
 */
function notASystem(url: string, object: JsonObject): { live: boolean; problem: string; advice: string } | undefined {
  const type = textOf(object["type"]) ?? "";
  if (/\/System$/.test(type)) {
    if (typeof object["body"] === "string") return undefined;
    return {
      live: false,
      problem: `${url} is an OParl System, but it has no URL of its list of bodies (body), so its bodies can't be listed.`,
      advice: "The URL is right, but the server's System is broken (no URL of its list of bodies): a server-side defect, not a wrong URL.",
    };
  }
  const kind = versionOfType(type) === undefined ? undefined : kindOf(type);
  const what = kind !== undefined ? `an OParl ${kind}` : Array.isArray(object["data"]) ? "a page of a list" : undefined;
  if (what === undefined) {
    return { live: false, problem: `${url} is not an OParl System (type: ${kindOf(type) ?? "missing"}).`, advice: "No OParl System there (an HTML page or another object): the endpoint moved or is gone." };
  }
  const system = textOf(object["system"]);
  return {
    live: true,
    problem: `This URL is ${what}, not the server's System (its entry point).`,
    advice:
      `The server answers: pass its System URL to checkEndpoint (findEndpoints' url${system === undefined ? "" : `; this object names its System: ${system}`}). ` +
      "A Body's id goes straight to findPapers, findMeetings or listObjects.",
  };
}

function knownEntry(url: string): CheckEndpointAnswer["known"] {
  const key = endpointKey(url);
  const curated = CURATED_ENDPOINTS.find((e) => endpointKey(e.url) === key);
  if (curated !== undefined) return { title: curated.title, working: curated.working, checked: curated.checked, ...(curated.note === null ? {} : { note: curated.note }) };
  const check = REGISTRY_CHECKS.find((e) => endpointKey(e.url) === key);
  if (check === undefined) return undefined;
  return {
    ...(check.systemName === undefined || check.systemName === null ? {} : { title: check.systemName }),
    working: check.working,
    checked: check.checked,
    ...(check.replacedBy === null ? {} : { replacedBy: check.replacedBy }),
    ...(check.note === null ? {} : { note: check.note }),
  };
}

/**
 * Whether an OParl server answers now, and what it offers: its System (product, vendor, version,
 * licence) and its bodies, each with the lists it links and its own licence. A server that doesn't
 * answer is an answer too (`live: false`, the problem and what it means), not an error.
 */
export async function checkEndpoint(client: OparlClient, params: CheckEndpointParams): Promise<CheckEndpointAnswer> {
  const url = reachable("url", params.url, params.extraHosts);
  const maxPages = count("maxPages", params.maxPages, 1, 20);
  const known = knownEntry(url);
  const notes: string[] = [];
  const base = { status: "ok" as const, url, ...(known === undefined ? {} : { known }) };
  if (known?.replacedBy !== undefined) notes.push(`The lists say this server moved to ${known.replacedBy}: check that URL.`);
  let system: JsonObject;
  try {
    system = await client.get<JsonObject>(url);
  } catch (err) {
    if (!(err instanceof OparlError) || err instanceof OparlValidationError) throw err;
    return done({ ...base, live: false, problem: err.message, advice: adviceFor(err), bodies: [], notes }, [url]);
  }
  // Another object the server answered with (a Body, a paper, a list page) or a broken System.
  const other = notASystem(url, system);
  if (other !== undefined) return done({ ...base, ...other, bodies: [], notes }, [url]);
  const bodiesUrl = textOf(system["body"]) ?? "";
  const version = textOf(system["oparlVersion"]);
  const summary = {
    ...(textOf(system["name"]) === undefined ? {} : { name: textOf(system["name"]) as string }),
    ...(version === undefined ? {} : { oparlVersion: shortOparlVersion(version) }),
    ...(textOf(system["product"]) === undefined ? {} : { product: textOf(system["product"]) as string }),
    ...(textOf(system["vendor"]) === undefined ? {} : { vendor: textOf(system["vendor"]) as string }),
    ...(textOf(system["website"]) === undefined ? {} : { website: textOf(system["website"]) as string }),
    ...(textOf(system["contactEmail"]) === undefined ? {} : { contactEmail: textOf(system["contactEmail"]) as string }),
    licence: licenceOf(system["license"]),
  };
  let walked: ListResult<JsonObject>;
  try {
    // The System is in hand: its list of bodies is walked directly (client.bodies would ask for the System again).
    walked = await client.walk<JsonObject>(resolveLink(url, bodiesUrl), undefined, maxPages);
  } catch (err) {
    if (!(err instanceof OparlError) || err instanceof OparlValidationError) throw err;
    if (err.partial === undefined || err instanceof OparlLinkError) {
      notes.push(`The System answered, but its list of bodies failed: ${err.message}`);
      return done({ ...base, live: true, system: summary, bodies: [], notes }, [url, bodiesUrl]);
    }
    walked = err.partial;
    notes.push(`${pageMissing(walked.pages + 1, err, params.signal)}: the bodies are those of the pages before it.`);
  }
  if (walked.note !== undefined) notes.push(walked.note);
  if (walked.next !== null && walked.stoppedEarly !== true && walked.note === undefined) notes.push(`More bodies than the ${walked.pages} page(s) read: raise maxPages.`);
  const bodies = walked.data.map(bodySummary);
  if (bodies.length > 1) notes.push("A shared server: pick the body by name; each body has its own id for findPapers and findMeetings.");
  if (bodies.some((b) => b.oparlVersion === "1.0")) notes.push("OParl 1.0 bodies link only organization, person, meeting and paper.");
  notes.push("Licence: the System's and each Body's own; a missing or unclear one means reuse beyond reading needs the operator's permission.");
  return done({ ...base, live: true, system: summary, bodies, notes }, [url, bodiesUrl]);
}

// ---- a body's lists ---------------------------------------------------------------------------

/** A body as the list answers name it. */
export interface BodyRef {
  id: string;
  name?: string;
  licence?: LicenceStatement;
}

/** The body's object and the URL of one of its lists, or an error naming the lists it has. */
async function openList(client: OparlClient, bodyUrl: string, type: ListType): Promise<{ body: BodyRef; listUrl: string }> {
  const body = await client.get<JsonObject>(bodyUrl);
  if (!/\/Body$/.test(textOf(body["type"]) ?? "")) {
    throw new OparlParseError(`${bodyUrl} is not an OParl Body (type: ${kindOf(body["type"]) ?? "missing"}). Take a body id from checkEndpoint.`);
  }
  const link = bodyListUrl(body, type);
  if (typeof link !== "string") {
    throw new OparlParseError(`This body has no ${type} list. It links: ${listsOf(body).join(", ") || "none"}.`);
  }
  const name = textOf(body["name"]);
  return {
    body: { id: textOf(body["id"]) ?? bodyUrl, ...(name === undefined ? {} : { name }), licence: licenceOf(body["license"], body["licenseValidSince"]) },
    listUrl: resolveLink(bodyUrl, link),
  };
}

/** The OParl kind of each list's objects. */
const LIST_KINDS: Readonly<Record<ListType, string>> = {
  organization: "Organization",
  person: "Person",
  meeting: "Meeting",
  paper: "Paper",
  "agenda-item": "AgendaItem",
  consultation: "Consultation",
  file: "File",
  membership: "Membership",
  location: "Location",
  "legislative-term": "LegislativeTerm",
};

/** A body URL as compared: host, port, path and query (http and https alike). */
const bodyKey = (url: string): string => endpointKey(url).replace(/^https?:/, "");

/**
 * The objects of the pages read from a caller's `next`, checked: of the list's kind and, where they
 * name their body, of this body. A next of another list, or of another body on the same server (a
 * shared server hosts several), is refused rather than answered as this body's `what`.
 */
function checkNextObjects(objects: readonly JsonObject[], type: ListType, bodyUrl: string, what: string): void {
  const kind = LIST_KINDS[type];
  const other = objects.map((o) => kindOf(o["type"])).find((k) => k !== undefined && k !== kind);
  if (other !== undefined) {
    throw new OparlValidationError(`Invalid next: its page holds ${other} objects, not ${what}. Pass the next of an answer about this body's ${what}.`);
  }
  if (objects.some((o) => typeof o["body"] === "string" && bodyKey(o["body"]) !== bodyKey(bodyUrl))) {
    throw new OparlValidationError(`Invalid next: its page holds the ${what} of another body. Pass the next of an answer about this body (${what}).`);
  }
}

/** `next` checked: reachable, and on the body's host (a page of its list). */
function nextOf(next: string | undefined, bodyUrl: string, extraHosts: readonly string[] | undefined): string | undefined {
  if (next === undefined) return undefined;
  const url = reachable("next", next, extraHosts);
  if (hostOf(url) !== hostOf(bodyUrl)) throw new OparlValidationError("Invalid next: it is not on the body's server. Pass the next of an answer about this body.");
  return url;
}

// ---- findPapers -------------------------------------------------------------------------------

export const DEFAULT_PAPERS = 30;
export const MAX_PAPERS = 200;

export interface PaperHit {
  id: string;
  reference?: string;
  name?: string;
  paperType?: string;
  /** The paper's date (the day it was issued); missing on many ALLRIS 1.0 papers. */
  date?: string;
  created?: string;
  modified?: string;
  /** Dated (else created) on or after since; null when the paper says neither. */
  new?: boolean | null;
  web?: string;
}

export interface FindPapersParams {
  /** A Body URL (checkEndpoint's bodies[].id). */
  body: string;
  /** Papers new or changed since this day (YYYY-MM-DD): the server's modified_since. */
  since?: string | undefined;
  /** With since: "new" (default: dated, else created, on or after since) or "changed" (every paper modified since). */
  only?: "new" | "changed" | undefined;
  /** Words that must all appear in the title or the reference (searched here, over the pages read). */
  query?: string | undefined;
  /** Part of the paper type (Antrag, Anfrage, Beschlussvorlage, …). */
  paperType?: string | undefined;
  maxPages?: number | undefined;
  limit?: number | undefined;
  /** Matches of the pages read to skip: an earlier answer's nextOffset, with the same arguments. */
  offset?: number | undefined;
  /** A next of an earlier answer: go on from there (the same filters). */
  next?: string | undefined;
  extraHosts?: readonly string[] | undefined;
  /** The caller's deadline or cancellation: a page missing after it aborted is noted as such. */
  signal?: AbortSignal | undefined;
  /** The clock (tests). */
  now?: Date | undefined;
}

export interface FindPapersAnswer {
  status: "ok" | "empty";
  reason?: string;
  body: BodyRef;
  searched: Record<string, JsonValue>;
  /** Papers that match, of the pages read. */
  total: number;
  /** Where `papers` starts among them. */
  offset: number;
  papers: PaperHit[];
  /** More matches of the pages read than shown: pass it as offset, with the same arguments. */
  nextOffset?: number;
  /** What the pages held besides: deleted stubs, papers only edited since, papers without a date. */
  counts: { fetched: number; deleted: number; editedOnly: number; undated: number };
  /** With since: honoured, ignored (objects modified before it came back), unusable (fake change dates), or emptyWindow. */
  dateFilter?: "honoured" | "ignored" | "unusable" | "emptyWindow";
  pagesRead: number;
  /** The next page of the list, to go on (next), or null at its end. */
  next: string | null;
  notes: string[];
}

/**
 * True when every object's modified is the same day, `today` or the day before, though the window
 * (`since`) reaches further back: stamped, not real. Asked for changes since today or yesterday,
 * an honest server returns exactly such dates, so the check can't tell then and says no.
 */
function fakeTimestamps(objects: JsonObject[], today: string, since: string): boolean {
  if (objects.length < 3) return false;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (since >= yesterday) return false;
  const days = new Set(objects.map((o) => dayOf(o["modified"])));
  const [day] = [...days];
  return days.size === 1 && (day === today || day === yesterday);
}

/**
 * Why page `n` of a list is missing, for a note: the caller's deadline or cancellation (`signal`
 * aborted: the request was stopped, it didn't time out or fail), else the error.
 */
function pageMissing(n: number, err: Error, signal: AbortSignal | undefined): string {
  return signal?.aborted === true ? `Page ${n} was not read: the call's time ran out (or it was cancelled) first` : `Page ${n} failed (${err.message})`;
}

/** A walk's result, or the part a later page's failure left (with a note naming `what` the list holds). */
async function walkKeeping(walk: () => Promise<ListResult<JsonObject>>, notes: string[], what: string, signal: AbortSignal | undefined): Promise<ListResult<JsonObject>> {
  try {
    return await walk();
  } catch (err) {
    if (!(err instanceof OparlError) || err.partial === undefined) throw err;
    notes.push(`${pageMissing(err.partial.pages + 1, err, signal)}: the ${what} are those of the pages before it, the list is incomplete; next is that page.`);
    return err.partial;
  }
}

/**
 * A body's papers new or changed since a day, or of the first pages without one, newest first.
 * The skill's checks are made here: deleted stubs dropped and counted; a server that ignored the
 * date filter is named, and the papers are filtered here; change dates that are all today (more!
 * rubin) are unusable, so the paper's date decides; papers only edited since are told apart from
 * new ones; papers without a date are kept and flagged; an HTTP 404 or 400 for the window (SD.NET
 * RIM) is checked against the list without a filter and read as an empty window.
 */
export async function findPapers(client: OparlClient, params: FindPapersParams): Promise<FindPapersAnswer> {
  const bodyUrl = reachable("body", params.body, params.extraHosts);
  const since = checkedDay("since", params.since);
  if (params.only !== undefined && params.only !== "new" && params.only !== "changed") {
    throw new OparlValidationError(`Invalid only: expected new or changed, got ${JSON.stringify(String(params.only))}.`);
  }
  const only = params.only ?? "new";
  const query = filterText("query", params.query);
  const paperType = filterText("paperType", params.paperType);
  const maxPages = count("maxPages", params.maxPages, 1, 20);
  const limit = count("limit", params.limit, DEFAULT_PAPERS, MAX_PAPERS);
  const offset = startAt(params.offset);
  const next = nextOf(params.next, bodyUrl, params.extraHosts);
  const today = berlinDay(params.now ?? new Date());
  const searched: Record<string, JsonValue> = {};
  if (since !== undefined) Object.assign(searched, { since, only });
  if (query !== undefined) searched["query"] = query;
  if (paperType !== undefined) searched["paperType"] = paperType;
  const notes: string[] = [];
  let body: BodyRef = { id: bodyUrl };
  let start: string;
  // With next, the body isn't asked: only the pages read are requests of this answer.
  const requests = next === undefined ? [bodyUrl] : [];
  if (next === undefined) {
    const opened = await openList(client, bodyUrl, "paper");
    body = opened.body;
    start = opened.listUrl;
  } else start = next;
  // The client's own query for the filter (listQuery: the day at midnight UTC, as the CLI sends it).
  const filter = since === undefined || next !== undefined ? undefined : listQuery({ modifiedSince: since });
  requests.push(encodeTimestampPlus(carryQuery(start, filter)));
  let walked: ListResult<JsonObject>;
  try {
    walked = await walkKeeping(() => client.walk<JsonObject>(start, filter, maxPages), notes, "papers", params.signal);
  } catch (err) {
    if (!(filter !== undefined && err instanceof OparlApiError && (err.status === 404 || err.status === 400))) throw err;
    // SD.NET RIM answers a window with no objects in it with 404 ("Die angeforderte Ressource
    // wurde nicht gefunden.") or 400 ("Keine Adressen vorhanden"): the same list without the
    // filter tells an empty window from a list that isn't there.
    let unfiltered: ListResult<JsonObject>;
    try {
      unfiltered = await client.walk<JsonObject>(start, undefined, 1);
    } catch {
      throw err;
    }
    if (unfiltered.data.length === 0) throw err;
    const reason =
      `No papers changed since ${since}: the server answered the date filter with HTTP ${err.status}, but the list without it answers, ` +
      "so the window is empty (SD.NET RIM servers answer an empty window so). Try an earlier day.";
    return done(
      { status: "empty", reason, body, searched, total: 0, offset, papers: [], counts: { fetched: 0, deleted: 0, editedOnly: 0, undated: 0 }, dateFilter: "emptyWindow", pagesRead: 1, next: null, notes },
      [...requests, start],
    );
  }
  if (next !== undefined) checkNextObjects(walked.data, "paper", bodyUrl, "papers");
  const live = walked.data.filter((p) => p["deleted"] !== true);
  const counts = { fetched: walked.data.length, deleted: walked.data.length - live.length, editedOnly: 0, undated: 0 };
  let dateFilter: FindPapersAnswer["dateFilter"];
  const unusable = since !== undefined && fakeTimestamps(live, today, since);
  if (since !== undefined) {
    const before = live.filter((p) => (dayOf(p["modified"]) ?? "9999") < since).length;
    dateFilter = unusable ? "unusable" : before > 0 ? "ignored" : "honoured";
    if (unusable) notes.push(`Every paper's change date is ${today} or the day before: this server stamps them (more! rubin), so they are unusable; the paper's own date decides here.`);
    if (dateFilter === "ignored") notes.push(`The server ignored the date filter (${before} papers modified before ${since} came back); they were filtered here.`);
  }
  const hits: PaperHit[] = [];
  for (const paper of live) {
    const text = (key: string) => textOf(paper[key]);
    const dated = dayOf(paper["date"]);
    if (dated === undefined) counts.undated += 1;
    // The day the paper was issued: its date, else when it was entered (unless those are stamped).
    const issued = dated ?? (unusable ? undefined : dayOf(paper["created"]));
    let isNew: boolean | null | undefined;
    if (since !== undefined) {
      isNew = issued === undefined ? null : issued >= since;
      // Modified since the cut-off, checked here too: a server may have ignored the filter.
      const changed = unusable || (dayOf(paper["modified"]) ?? "9999") >= since;
      if (!changed && isNew !== true) continue;
      if (isNew === false) counts.editedOnly += 1;
      // Only edited since: left out of "new", and always when the change dates are unusable.
      if ((only === "new" || unusable) && isNew === false) continue;
    }
    if (!matchesWords(query, text("name"), text("reference"))) continue;
    if (paperType !== undefined && !foldSearchText(text("paperType") ?? "").includes(foldSearchText(paperType))) continue;
    hits.push({
      id: text("id") ?? "",
      ...(text("reference") === undefined ? {} : { reference: text("reference") as string }),
      ...(text("name") === undefined ? {} : { name: text("name") as string }),
      ...(text("paperType") === undefined ? {} : { paperType: text("paperType") as string }),
      ...(dayOf(paper["date"]) === undefined ? {} : { date: dayOf(paper["date"]) as string }),
      ...(text("created") === undefined || dayOf(paper["date"]) !== undefined ? {} : { created: text("created") as string }),
      ...(text("modified") === undefined ? {} : { modified: text("modified") as string }),
      ...(isNew === undefined ? {} : { new: isNew }),
      ...(text("web") === undefined ? {} : { web: text("web") as string }),
    });
  }
  const sortKey = (p: PaperHit) => p.date ?? p.created?.slice(0, 10) ?? "";
  hits.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  if (walked.note !== undefined) notes.push(walked.note);
  if (counts.undated > 0) notes.push(`${counts.undated} papers have no date (common on ALLRIS 1.0): ${since === undefined ? "they are listed" : "created stands in for it; without either they are kept with new null"}. Report them, never drop them.`);
  if (since !== undefined && only === "new" && counts.editedOnly > 0) notes.push(`${counts.editedOnly} older papers were only edited since ${since}: not counted as new (only: changed lists them).`);
  if (query !== undefined || paperType !== undefined) notes.push(`OParl has no full-text search: titles were searched here, over ${walked.pages} page(s). Say how many pages were searched; more pages (maxPages, next) find more.`);
  if (walked.next !== null) notes.push(`The list goes on after ${walked.pages} page(s): pass next to read on.`);
  const { shown, nextOffset } = matchesPage(hits, offset, limit, "papers", notes);
  notes.push("Order is the server's; sorted here by date, newest first. Cite paper references and the body's name.");
  const searchedText = Object.keys(searched).length === 0 ? "the first pages" : JSON.stringify(searched);
  const answer: FindPapersAnswer = {
    status: shown.length === 0 ? "empty" : "ok",
    ...(hits.length === 0
      ? { reason: `No paper matches ${searchedText} on the ${walked.pages} page(s) read (${counts.fetched} objects, ${counts.deleted} deleted). Read more pages (maxPages, next), an earlier since, or fewer words.` }
      : shown.length === 0
        ? { reason: pastTheEnd(offset, hits.length) }
        : {}),
    body,
    searched,
    total: hits.length,
    offset,
    papers: shown,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    counts,
    ...(dateFilter === undefined ? {} : { dateFilter }),
    pagesRead: walked.pages,
    next: walked.next,
    notes,
  };
  return done(answer, requests);
}

// ---- findMeetings -----------------------------------------------------------------------------

export const DEFAULT_MEETINGS = 30;
export const MAX_MEETINGS = 200;

export interface MeetingHit {
  id: string;
  name?: string;
  start: string;
  end?: string;
  cancelled?: true;
  location?: string;
  /** The organizations (committees) holding it, by URL. */
  organization?: string[];
  agendaItems?: number;
  web?: string;
}

export interface FindMeetingsParams {
  body: string;
  /** From this day on (YYYY-MM-DD); default today, when to is not given either. */
  from?: string | undefined;
  /** Up to and including this day. */
  to?: string | undefined;
  /** Words that must all appear in the meeting's name. */
  query?: string | undefined;
  maxPages?: number | undefined;
  limit?: number | undefined;
  /** Matches of the pages read to skip: an earlier answer's nextOffset, with the same arguments. */
  offset?: number | undefined;
  next?: string | undefined;
  extraHosts?: readonly string[] | undefined;
  /** The caller's deadline or cancellation: a page missing after it aborted is noted as such. */
  signal?: AbortSignal | undefined;
  now?: Date | undefined;
}

export interface FindMeetingsAnswer {
  status: "ok" | "empty";
  reason?: string;
  body: BodyRef;
  searched: Record<string, JsonValue>;
  total: number;
  /** Where `meetings` starts among them. */
  offset: number;
  meetings: MeetingHit[];
  /** More matches of the pages read than shown: pass it as offset, with the same arguments. */
  nextOffset?: number;
  pagesRead: number;
  /** False when meetings of the window are left out: matches not shown (nextOffset), or pages left unread that could hold some (next). */
  complete: boolean;
  next: string | null;
  notes: string[];
}

function locationText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isObject(value)) return undefined;
  const parts = ["description", "room", "streetAddress", "postalCode", "locality"].map((k) => textOf(value[k])).filter((t) => t !== undefined);
  return parts.length === 0 ? textOf(value["id"]) : parts.join(", ");
}

function meetingHit(meeting: JsonObject): MeetingHit {
  const text = (key: string) => textOf(meeting[key]);
  const organization = Array.isArray(meeting["organization"]) ? meeting["organization"].filter((o): o is string => typeof o === "string") : [];
  const location = locationText(meeting["location"]);
  return {
    id: text("id") ?? "",
    ...(text("name") === undefined ? {} : { name: (text("name") as string).replace(/\s+/g, " ") }),
    start: text("start") ?? "",
    ...(text("end") === undefined ? {} : { end: text("end") as string }),
    ...(meeting["cancelled"] === true ? { cancelled: true as const } : {}),
    ...(location === undefined ? {} : { location }),
    ...(organization.length === 0 ? {} : { organization }),
    ...(Array.isArray(meeting["agendaItem"]) ? { agendaItems: meeting["agendaItem"].length } : {}),
    ...(text("web") === undefined ? {} : { web: text("web") as string }),
  };
}

/**
 * A body's meetings in a window, soonest first. Meeting lists are in the server's order (often far
 * future first, or by internal id, oldest first), so when the window is open towards the future (no
 * to) the pages are read until one holds no meeting of the window after one that held some (a list
 * that puts the future first has passed the window there), and up to maxPages otherwise; the
 * answer says how many pages were read and whether more could hold some (complete false while
 * next is set and no such page was reached).
 */
export async function findMeetings(client: OparlClient, params: FindMeetingsParams): Promise<FindMeetingsAnswer> {
  const bodyUrl = reachable("body", params.body, params.extraHosts);
  const to = checkedDay("to", params.to);
  const from = checkedDay("from", params.from) ?? (to === undefined ? berlinDay(params.now ?? new Date()) : undefined);
  if (from !== undefined && to !== undefined && from > to) throw new OparlValidationError("Invalid from/to: from is after to.");
  const query = filterText("query", params.query);
  const maxPages = count("maxPages", params.maxPages, 2, 20);
  const limit = count("limit", params.limit, DEFAULT_MEETINGS, MAX_MEETINGS);
  const offset = startAt(params.offset);
  const next = nextOf(params.next, bodyUrl, params.extraHosts);
  const searched: Record<string, JsonValue> = {};
  if (from !== undefined) searched["from"] = from;
  if (to !== undefined) searched["to"] = to;
  if (query !== undefined) searched["query"] = query;
  const notes: string[] = [];
  let body: BodyRef = { id: bodyUrl };
  let current: string | null;
  const requests = next === undefined ? [bodyUrl] : [];
  if (next === undefined) {
    const opened = await openList(client, bodyUrl, "meeting");
    body = opened.body;
    current = opened.listUrl;
  } else current = next;
  requests.push(current);
  const inWindow = (m: JsonObject): boolean => {
    const day = dayOf(m["start"]);
    return day !== undefined && (from === undefined || day >= from) && (to === undefined || day <= to);
  };
  const byId = new Map<string, JsonObject>();
  const seen = new Set<string>();
  let pages = 0;
  let stoppedByRule = false;
  let undated = 0;
  let deleted = 0;
  // Meetings before the window's start on the pages read, and whether any page held one of the window.
  let before = 0;
  let foundAny = false;
  while (current !== null && pages < maxPages) {
    seen.add(current);
    let page: ListResult<JsonObject>;
    try {
      page = await client.walk<JsonObject>(current, undefined, 1);
    } catch (err) {
      if (pages === 0 || !(err instanceof OparlError) || err instanceof OparlValidationError) throw err;
      notes.push(`${pageMissing(pages + 1, err, params.signal)}: the meetings are those of the pages before it; next is that page.`);
      break;
    }
    if (next !== undefined) checkNextObjects(page.data, "meeting", bodyUrl, "meetings");
    pages += 1;
    let found = 0;
    for (const meeting of page.data) {
      if (meeting["deleted"] === true) {
        deleted += 1;
        continue;
      }
      if (dayOf(meeting["start"]) === undefined) undated += 1;
      if (from !== undefined && (dayOf(meeting["start"]) ?? "9999") < from) before += 1;
      if (!inWindow(meeting)) continue;
      found += 1;
      byId.set(textOf(meeting["id"]) ?? `#${byId.size}`, meeting);
    }
    if (page.note !== undefined) notes.push(page.note);
    current = page.next !== null && seen.has(page.next) ? null : page.next;
    // A list that puts future meetings first has passed the window at a page without any: stop
    // there. Before the first page with one, the order is unknown (old meetings first, by
    // internal id): read on, up to maxPages.
    if (to === undefined && found === 0 && foundAny) {
      stoppedByRule = true;
      break;
    }
    if (found > 0) foundAny = true;
  }
  const hits = [...byId.values()]
    .filter((m) => matchesWords(query, textOf(m["name"])))
    .map(meetingHit)
    .sort((a, b) => a.start.localeCompare(b.start));
  const { shown, nextOffset } = matchesPage(hits, offset, limit, "meetings", notes);
  const complete = (current === null || stoppedByRule) && nextOffset === undefined;
  notes.push(
    stoppedByRule
      ? `Read ${pages} page(s), up to the first with no meeting of the window after one with some: pages are in the server's order, not by date.`
      : `Read ${pages} page(s)${current === null ? ", the whole list" : `; more pages could hold meetings of the window: pass next`}. Pages are in the server's order, not by date.`,
  );
  if (!foundAny && current !== null && pages > 0 && before > 0) {
    notes.push(`The ${pages} page(s) read hold only meetings before ${from}: this server may list old meetings first, so the window's can be on later pages. Read on with next (and a larger maxPages).`);
  }
  if (undated > 0) notes.push(`${undated} meetings have no start and are left out.`);
  if (deleted > 0) notes.push(`${deleted} deleted meetings were dropped.`);
  if (hits.some((m) => m.cancelled === true)) notes.push("cancelled: true marks meetings called off; say so.");
  const window = `${from ?? "the start"} to ${to ?? "any later day"}`;
  return done(
    {
      status: shown.length === 0 ? "empty" : "ok",
      ...(hits.length === 0
        ? { reason: `No meeting from ${window}${query === undefined ? "" : ` named ${JSON.stringify(query)}`} on the ${pages} page(s) read.${complete ? "" : " More pages (next, maxPages) may hold some."}` }
        : shown.length === 0
          ? { reason: pastTheEnd(offset, hits.length) }
          : {}),
      body,
      searched,
      total: hits.length,
      offset,
      meetings: shown,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      pagesRead: pages,
      complete,
      next: current,
      notes,
    },
    requests,
  );
}

// ---- listObjects ------------------------------------------------------------------------------

export const DEFAULT_OBJECTS = 50;
export const MAX_OBJECTS = 200;

export interface ListObjectsParams {
  body: string;
  type: ListType;
  modifiedSince?: string | undefined;
  createdSince?: string | undefined;
  /** Words that must all appear in the name (or short name, reference). */
  query?: string | undefined;
  maxPages?: number | undefined;
  limit?: number | undefined;
  /** Matches of the pages read to skip: an earlier answer's nextOffset, with the same arguments. */
  offset?: number | undefined;
  next?: string | undefined;
  extraHosts?: readonly string[] | undefined;
  /** The caller's deadline or cancellation: a page missing after it aborted is noted as such. */
  signal?: AbortSignal | undefined;
}

export interface ListObjectsAnswer {
  status: "ok" | "empty";
  reason?: string;
  body: { id: string };
  type: ListType;
  searched: Record<string, JsonValue>;
  total: number;
  /** Where `objects` starts among them. */
  offset: number;
  /** The objects with their own fields; embedded objects are left out and named in `embedded` (getObject has them). */
  objects: JsonObject[];
  /** More matches of the pages read than shown: pass it as offset, with the same arguments. */
  nextOffset?: number;
  pagesRead: number;
  next: string | null;
  notes: string[];
}

/** An object's own fields: text, numbers, flags and lists of URLs; embedded objects named instead. */
function flat(object: JsonObject): JsonObject {
  const out: JsonObject = {};
  const embedded: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (isObject(value) || (Array.isArray(value) && value.some((item) => isObject(item) || Array.isArray(item)))) embedded.push(key);
    else out[key] = value;
  }
  if (embedded.length > 0) out["embedded"] = embedded;
  return out;
}

/**
 * One of a body's lists (organizations: committees and groups; persons; legislative terms; …),
 * deleted objects dropped, each object with its own fields. A 1.0 body's embedded legislative
 * terms are listed as they are (pages 0).
 */
export async function listObjects(client: OparlClient, params: ListObjectsParams): Promise<ListObjectsAnswer> {
  const bodyUrl = reachable("body", params.body, params.extraHosts);
  if (!Object.hasOwn(LIST_TYPES, params.type)) {
    throw new OparlValidationError(`Invalid type: expected one of ${Object.keys(LIST_TYPES).join(", ")}, got ${JSON.stringify(String(params.type))}.`);
  }
  const modifiedSince = checkedDay("modifiedSince", params.modifiedSince);
  const createdSince = checkedDay("createdSince", params.createdSince);
  const query = filterText("query", params.query);
  const maxPages = count("maxPages", params.maxPages, 1, 20);
  const limit = count("limit", params.limit, DEFAULT_OBJECTS, MAX_OBJECTS);
  const offset = startAt(params.offset);
  const next = nextOf(params.next, bodyUrl, params.extraHosts);
  const searched: Record<string, JsonValue> = {};
  if (modifiedSince !== undefined) searched["modifiedSince"] = modifiedSince;
  if (createdSince !== undefined) searched["createdSince"] = createdSince;
  if (query !== undefined) searched["query"] = query;
  const notes: string[] = [];
  const walk =
    next === undefined
      ? () =>
          client.list(bodyUrl, params.type, {
            maxPages,
            ...(modifiedSince === undefined ? {} : { modifiedSince }),
            ...(createdSince === undefined ? {} : { createdSince }),
          }) as Promise<ListResult<JsonObject>>
      : () => client.walk<JsonObject>(next, undefined, maxPages);
  const walked = await walkKeeping(walk, notes, "objects", params.signal);
  if (next !== undefined) checkNextObjects(walked.data, params.type, bodyUrl, `${params.type} objects`);
  const live = walked.data.filter((o) => o["deleted"] !== true);
  const hits = live.filter((o) => matchesWords(query, textOf(o["name"]), textOf(o["shortName"]), textOf(o["reference"]))).map(flat);
  if (walked.note !== undefined) notes.push(walked.note);
  if (walked.data.length > live.length) notes.push(`${walked.data.length - live.length} deleted objects were dropped.`);
  if (walked.next !== null) notes.push(`The list goes on after ${walked.pages} page(s): pass next to read on.`);
  if (modifiedSince !== undefined || createdSince !== undefined) notes.push("Servers may ignore the date filters: check modified and created.");
  if (params.type === "person") notes.push("Person records are personal data: quote them, don't bulk-copy them.");
  const { shown, nextOffset } = matchesPage(hits, offset, limit, `${params.type} objects`, notes);
  return done(
    {
      status: shown.length === 0 ? "empty" : "ok",
      ...(hits.length === 0
        ? { reason: `No ${params.type} object matches ${JSON.stringify(searched)} on the ${walked.pages} page(s) read. Read more pages (next), or fewer words.` }
        : shown.length === 0
          ? { reason: pastTheEnd(offset, hits.length) }
          : {}),
      body: { id: bodyUrl },
      type: params.type,
      searched,
      total: hits.length,
      offset,
      objects: shown,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      pagesRead: walked.pages,
      next: walked.next,
      notes,
    },
    [next ?? bodyUrl],
  );
}

// ---- getObject --------------------------------------------------------------------------------

export interface GetObjectAnswer {
  status: "ok" | "empty";
  reason?: string;
  url: string;
  /** Paper, Meeting, Person, … (the type's last part). */
  kind?: string;
  object?: JsonObject;
  /** The object's own licence, when it names one (`licence` is the server-wide terms in a tool's result). */
  declaredLicence?: LicenceStatement;
}

/** Any OParl object (or list page) by its URL, as the server sends it. */
export async function getObject(client: OparlClient, params: { url: string; extraHosts?: readonly string[] | undefined }): Promise<GetObjectAnswer> {
  const url = reachable("url", params.url, params.extraHosts);
  let object: OparlObject;
  try {
    object = await client.get(url);
  } catch (err) {
    if (err instanceof OparlApiError && (err.status === 404 || err.status === 410)) {
      return done({ status: "empty", reason: `Nothing at that URL (HTTP ${err.status}). Take URLs from these tools' answers (ids, next), never build one.`, url }, [url]);
    }
    if (err instanceof OparlLinkError) throw new OparlValidationError(err.message);
    throw err;
  }
  const kind = kindOf(object["type"]);
  return done(
    {
      status: "ok",
      url,
      ...(kind === undefined ? {} : { kind }),
      object,
      ...(object["license"] === undefined ? {} : { declaredLicence: licenceOf(object["license"], object["licenseValidSince"]) }),
    },
    [url],
  );
}
