// OparlClient — a typed, read-only client for OParl, the standard API of German
// municipal council information systems (Ratsinformationssysteme). No auth.
//
// There is no central OParl host: every municipality runs its own server, found in
// the public registry at dev.oparl.org or in the curated list shipped with this
// package (endpoints-list.ts). Navigation is by URL — a System lists its bodies, each
// Body links its object lists (meetings, papers, persons, …), and lists are paged
// through `links.next`.
//
//   const c = new OparlClient();
//   const endpoints = await c.endpoints();                  // registry + curated list
//   const system = await c.system(endpoints[0].url);        // an endpoint's System
//   const { data: bodies } = await c.bodies(system.id);     // its bodies
//   const meetings = await c.list(bodies[0].id, "meeting"); // first page of meetings

import { RequestEngine, carryQuery, parseHttpUrl, resolveLink, sanitizeServerText, withQuery, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { OparlLinkError, OparlParseError, OparlValidationError } from "./errors.js";
import { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "./endpoints-list.js";
import type {
  CuratedEndpoint,
  JsonObject,
  JsonValue,
  ListResult,
  OparlBody,
  OparlListPage,
  OparlObject,
  OparlSystem,
  RegistryCheck,
  RegistryEntry,
} from "./types.js";

export const DEFAULT_REGISTRY_URL = "https://dev.oparl.org/api/endpoints";

/**
 * The object lists a Body can link, by the name used on the command line, mapped to
 * the Body field holding the list URL. OParl 1.0 bodies only link organization,
 * person, meeting and paper; the rest arrived with 1.1.
 */
export const LIST_TYPES = {
  organization: "organization",
  person: "person",
  meeting: "meeting",
  paper: "paper",
  "agenda-item": "agendaItem",
  consultation: "consultation",
  file: "file",
  membership: "membership",
  location: "locationList",
  "legislative-term": "legislativeTermList",
} as const;

export type ListType = keyof typeof LIST_TYPES;

/**
 * Non-spec Body fields some servers use instead of the spec name, tried when the spec
 * field is missing. Düsseldorf's Somacos server (ris-oparl.itk-rheinland.de) links
 * `consultations` and `files`.
 */
const LIST_FIELD_FALLBACKS: Partial<Record<ListType, string>> = {
  consultation: "consultations",
  file: "files",
};

/** The list URL a Body links for `type`, under the spec field or its known fallback. */
function bodyListUrl(body: JsonObject, type: ListType): JsonValue | undefined {
  const url = body[LIST_TYPES[type]];
  if (typeof url === "string") return url;
  const fallback = LIST_FIELD_FALLBACKS[type];
  return fallback !== undefined && typeof body[fallback] === "string" ? body[fallback] : url;
}

/** Guard against a server whose `next` links never end. */
const MAX_PAGES_HARD_LIMIT = 10_000;
const MAX_REGISTRY_PAGES = 50;
/**
 * Consecutive pages that may add nothing new before a walk gives up: a server that
 * serves the same page (or an empty one) under ever-new `?page=n` links would
 * otherwise be paged until the hard limit. Two such pages in a row are tolerated,
 * because a list that grows or is reordered while it is being walked also repeats a
 * page, and the walk should get past that instead of truncating the list.
 */
const MAX_UNPRODUCTIVE_PAGES = 3;

/** The lists an OParl 1.0 Body links; 1.1 added the rest of LIST_TYPES. */
const LIST_TYPES_1_0: readonly ListType[] = ["organization", "person", "meeting", "paper"];

export interface ListOptions {
  /** Pages to fetch; 0 means all. Defaults to 1. */
  maxPages?: number;
  /** Only objects created at or after this time (OParl `created_since`). */
  createdSince?: string;
  /** Only objects created at or before this time (OParl `created_until`). */
  createdUntil?: string;
  /** Only objects modified at or after this time (OParl `modified_since`). */
  modifiedSince?: string;
  /** Only objects modified at or before this time (OParl `modified_until`). */
  modifiedUntil?: string;
  /** Page size hint (OParl `limit`); servers may ignore or reject it. */
  limit?: number;
  /** Ask the server to leave out embedded objects (OParl `omit_internal`). */
  omitInternal?: boolean;
}

export interface OparlClientOptions extends EngineOptions {
  /** URL of the endpoint registry. Defaults to https://dev.oparl.org/api/endpoints */
  registryUrl?: string;
  /** Endpoints the registry lacks. Defaults to the list shipped with this package. */
  curatedEndpoints?: readonly CuratedEndpoint[];
  /** Live checks of registry entries. Defaults to the checks shipped with this package. */
  registryChecks?: readonly RegistryCheck[];
}

/** Which endpoints `endpoints()` returns. */
export type EndpointSource = "all" | "registry" | "curated";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: JsonValue | undefined): string | null => (typeof value === "string" ? value : null);

/** Whether a URL is one this client could fetch: a valid absolute http/https URL. */
function isFetchableUrl(url: string): boolean {
  try {
    parseHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a caller-supplied endpoint list (the `curatedEndpoints` and `registryChecks`
 * options). Both are keyed by their `url`, so an entry without one, or a value that is
 * not an array at all, would otherwise surface as a TypeError from inside `endpoints()`.
 */
function checkedEndpointList<T extends { url: string }>(list: readonly T[], option: string): readonly T[] {
  if (!Array.isArray(list)) {
    throw new OparlValidationError(`The ${option} option must be an array of endpoints.`);
  }
  for (const entry of list) {
    const url: unknown = (entry as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || !isFetchableUrl(url)) {
      throw new OparlValidationError(
        `Every entry of the ${option} option needs a \`url\` holding an http(s) System URL.`,
      );
    }
  }
  return list;
}

/** What arrived where an OParl object or URL was expected, for an error message. */
function describeJson(value: JsonValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * The objects of a list page's `data`. A `null` or scalar entry is rejected here
 * rather than crashing the walk or reaching the user as if it were an object.
 */
function listItems(url: string, items: readonly JsonValue[]): JsonObject[] {
  for (const item of items) {
    if (!isObject(item)) {
      throw new OparlParseError(
        `The list at ${url} has an entry in \`data\` that is not an OParl object (${describeJson(item)}).`,
      );
    }
  }
  return items as JsonObject[];
}

/**
 * The message of an OParl or vendor error object — `{ "type": ".../Error", "message": "…" }`
 * or `{ "error": "…" }`, without an `id` — stripped of control characters and capped.
 * Null for anything else.
 */
function errorObjectMessage(value: JsonObject): string | null {
  if (typeof value["id"] === "string") return null;
  const message = str(value["message"]) ?? str(value["error"]);
  if (message === null && !/\/Error$/.test(str(value["type"]) ?? "")) return null;
  return sanitizeServerText(message ?? "(no message)").slice(0, 200);
}

/**
 * Normalise an OParl timestamp filter to the spec's `YYYY-MM-DDThh:mm:ss±hh:mm` form.
 * Accepts a date (`2026-09-01`, midnight UTC) or an ISO 8601 date-time with an offset:
 * seconds and fractional seconds are optional (fractions are dropped), the offset may be
 * `Z`, `±hh`, `±hhmm` or `±hh:mm`, and `T`/`Z` may be lowercase. A date-time without an
 * offset is rejected, since the server would have to guess the time zone.
 */
export function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  const invalid = (reason: string) => new OparlValidationError(`Invalid timestamp "${value}": ${reason}`);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/.exec(trimmed);
  const parts = date ?? dateTime;
  if (!parts) {
    throw invalid("use YYYY-MM-DD or an ISO 8601 date-time such as 2026-09-01T12:00:00+02:00.");
  }
  const [, y, m, d] = parts;
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) {
    throw invalid("no such date.");
  }
  if (!dateTime) return `${trimmed}T00:00:00+00:00`;
  const [, , , , hh = "", mm = "", ss = "00", zone] = dateTime;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) throw invalid("no such time.");
  if (zone === undefined) throw invalid("add a time zone offset, e.g. Z or +02:00.");
  let offset = "+00:00";
  if (!/^z$/i.test(zone)) {
    const digits = zone.slice(1).replace(":", "");
    const offsetH = digits.slice(0, 2);
    const offsetM = digits.slice(2) || "00";
    if (Number(offsetH) > 23 || Number(offsetM) > 59) throw invalid("no such time zone offset.");
    offset = `${zone[0]}${offsetH}:${offsetM}`;
  }
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${offset}`;
}

/** The OParl filter query for a list request. */
export function listQuery(options: ListOptions): QueryParams {
  return {
    created_since: options.createdSince !== undefined ? normalizeTimestamp(options.createdSince) : undefined,
    created_until: options.createdUntil !== undefined ? normalizeTimestamp(options.createdUntil) : undefined,
    modified_since: options.modifiedSince !== undefined ? normalizeTimestamp(options.modifiedSince) : undefined,
    modified_until: options.modifiedUntil !== undefined ? normalizeTimestamp(options.modifiedUntil) : undefined,
    limit: options.limit,
    omit_internal: options.omitInternal ? true : undefined,
  };
}

export class OparlClient {
  private readonly engine: RequestEngine;
  private readonly registryUrl: string;
  private readonly curatedEndpoints: readonly CuratedEndpoint[];
  private readonly registryChecks: readonly RegistryCheck[];

  constructor(options: OparlClientOptions = {}) {
    this.engine = new RequestEngine(options);
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.curatedEndpoints = checkedEndpointList(options.curatedEndpoints ?? CURATED_ENDPOINTS, "curatedEndpoints");
    this.registryChecks = checkedEndpointList(options.registryChecks ?? REGISTRY_CHECKS, "registryChecks");
  }

  /**
   * Fetch one OParl object by URL. Rejects non-objects and OParl/vendor error objects
   * (`{ "type": ".../Error", "message": "…" }`, `{ "error": "…" }`) with an OparlParseError.
   */
  async get<T extends JsonObject = OparlObject>(url: string): Promise<T> {
    const value = await this.engine.getJson<unknown>(url);
    if (!isObject(value)) {
      throw new OparlParseError(`Expected an OParl object from ${url} but got ${Array.isArray(value) ? "an array" : typeof value}.`);
    }
    const message = errorObjectMessage(value);
    if (message !== null) {
      throw new OparlParseError(`The server at ${url} answered with an error object: ${message}`);
    }
    return value as T;
  }

  /** Fetch a System, the entry point of an OParl server. */
  async system(url: string): Promise<OparlSystem> {
    const system = await this.get<JsonObject>(url);
    const type = str(system["type"]) ?? "";
    if (!/\/System$/.test(type)) {
      throw new OparlParseError(
        `${url} is not an OParl System (type: ${type || "missing"}). Use the endpoint's System URL, e.g. from \`oparl endpoints\`.`,
      );
    }
    if (typeof system["body"] !== "string") {
      throw new OparlParseError(
        `${url} is an OParl System, but its \`body\` is ${describeJson(system["body"])} instead of the URL of its list ` +
          "of bodies, so its bodies cannot be listed. `oparl get` shows the object as the server sent it.",
      );
    }
    return system as OparlSystem;
  }

  /**
   * Fetch one list page and check it has a `data` array of objects. A server that
   * answers a list URL with a bare JSON array instead of a list page (seen on an
   * SD.NET RIM build in Essen) is read as a single page holding those objects.
   */
  async page<T extends JsonObject = OparlObject>(url: string, query?: QueryParams): Promise<OparlListPage<T>> {
    const value = await this.engine.getJson<unknown>(url, query);
    if (Array.isArray(value)) {
      return { data: listItems(url, value as JsonValue[]) as T[] };
    }
    if (!isObject(value) || !Array.isArray(value["data"])) {
      const message = isObject(value) ? errorObjectMessage(value) : null;
      if (message !== null) {
        throw new OparlParseError(`The server at ${url} answered with an error object: ${message}`);
      }
      const type = isObject(value) ? str(value["type"]) : null;
      throw new OparlParseError(
        `${url} is not an OParl object list${type ? ` (got an object of type ${type})` : ""}.`,
      );
    }
    listItems(url, value["data"]);
    return value as unknown as OparlListPage<T>;
  }

  /**
   * Walk a list from its first page along `links.next`, staying on the same host.
   * `maxPages` 0 fetches every page. The `query` (filters) is set on every page,
   * including on the server's `next` links (see carryQuery), and on the `next` returned.
   *
   * Objects are listed once per `id`; when a page repeats an `id`, the later copy wins,
   * since that is the newer one — a list that changes while it is being walked serves
   * the edited object, or the spec's `deleted: true` tombstone, on the later page.
   *
   * The walk gives up early — `looped: true` plus a `note` saying why — when the
   * server's `next` points back at a page already fetched, or when MAX_UNPRODUCTIVE_PAGES
   * pages in a row add no object that wasn't already listed (some servers serve the same
   * page, or an empty one, under ever-new `?page=n` links). The `next` of the last page
   * fetched is still returned in that case, so the walk can be resumed by hand. A `next`
   * this client refuses to follow (another host, not http) also ends the walk with a
   * `note`, keeping the pages already fetched.
   */
  async walk<T extends JsonObject = OparlObject>(url: string, query?: QueryParams, maxPages = 1): Promise<ListResult<T>> {
    if (!Number.isInteger(maxPages) || maxPages < 0) {
      throw new OparlValidationError("maxPages must be a non-negative integer.");
    }
    const limit = maxPages === 0 ? MAX_PAGES_HARD_LIMIT : maxPages;
    const data: T[] = [];
    const seenPages = new Set<string>();
    const positionById = new Map<string, number>();
    let current: string | null = url;
    let pages = 0;
    let next: string | null = null;
    let looped = false;
    let note: string | undefined;
    let unproductive = 0;
    while (current !== null && pages < limit) {
      const pageQuery = pages === 0 ? query : undefined;
      const page: OparlListPage<T> = await this.page<T>(current, pageQuery);
      // The URL the request actually went to, filters included, so that a `next` link
      // leading back to it is recognised.
      seenPages.add(withQuery(parseHttpUrl(current).href, pageQuery));
      pages += 1;
      let added = 0;
      for (const object of page.data) {
        const id = object["id"];
        if (typeof id === "string") {
          const at = positionById.get(id);
          if (at !== undefined) {
            data[at] = object; // the later copy is the newer one
            continue;
          }
          positionById.set(id, data.length);
        }
        data.push(object);
        added += 1;
      }
      unproductive = added === 0 ? unproductive + 1 : 0;
      const link = page.links?.next;
      if (typeof link !== "string" || link === "") {
        next = null; // the last page
        break;
      }
      try {
        next = carryQuery(resolveLink(current, link), query);
      } catch (err) {
        if (!(err instanceof OparlLinkError)) throw err;
        next = null; // keep the pages already fetched and say why the walk stopped
        note = `stopped after page ${pages}: ${err.message}`;
        break;
      }
      if (seenPages.has(next)) {
        next = null; // the server's `next` points back at a page already fetched
        looped = true;
        note = `stopped after page ${pages}: the server's next link points back to a page already fetched.`;
        break;
      }
      if (unproductive >= MAX_UNPRODUCTIVE_PAGES) {
        looped = true;
        note =
          `stopped after page ${pages}: the last ${unproductive} pages added no object that wasn't already ` +
          "listed. Pass the returned `next` to `oparl get` if you think the list goes on.";
        break;
      }
      current = next;
    }
    return {
      data,
      pages,
      next,
      ...(looped ? { looped: true as const } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }

  /** The bodies (Körperschaften) of a System — usually one per municipality. */
  async bodies(systemUrl: string, options: { maxPages?: number } = {}): Promise<ListResult<OparlBody>> {
    const system = await this.system(systemUrl);
    return this.walk<OparlBody>(resolveLink(systemUrl, system.body), undefined, options.maxPages ?? 0);
  }

  /**
   * Walk one of a Body's object lists (meetings, papers, persons, …). Filters are
   * passed to the server as OParl query parameters; servers are required to support
   * the date filters, but in practice some ignore them.
   *
   * A Body without a `legislativeTermList` URL (every OParl 1.0 body) embeds its terms
   * in `legislativeTerm`; those are returned as they are (`pages: 0`, nothing fetched),
   * with the date filters applied locally. A term the server left without the mandatory
   * `created`/`modified` cannot be excluded by a date filter, so it is kept and the
   * result's `note` says how many terms the filter could not be applied to.
   */
  async list(bodyUrl: string, type: ListType, options: ListOptions = {}): Promise<ListResult<OparlObject>> {
    const field = LIST_TYPES[type];
    if (field === undefined) {
      throw new OparlValidationError(`Unknown list type "${String(type)}". Use one of: ${Object.keys(LIST_TYPES).join(", ")}.`);
    }
    const query = listQuery(options);
    const body = await this.get<JsonObject>(bodyUrl);
    const bodyType = str(body["type"]) ?? "";
    if (!/\/Body$/.test(bodyType)) {
      throw new OparlParseError(`${bodyUrl} is not an OParl Body (type: ${bodyType || "missing"}). Use a body URL from \`oparl bodies\`.`);
    }
    const listUrl = bodyListUrl(body, type);
    const embedded = body["legislativeTerm"];
    if (field === "legislativeTermList" && typeof listUrl !== "string" && Array.isArray(embedded)) {
      const terms = embedded.filter(isObject) as OparlObject[];
      const data: OparlObject[] = [];
      let undated = 0;
      for (const term of terms) {
        const outcome = matchDateFilters(term, query);
        if (outcome === "no-match") continue;
        if (outcome === "undated") undated += 1;
        data.push(term);
      }
      return {
        data,
        pages: 0,
        next: null,
        ...(undated > 0
          ? {
              note:
                `${undated} of ${terms.length} embedded legislative terms carry no created/modified timestamp, ` +
                "so the date filter could not be applied to them; they are listed.",
            }
          : {}),
      };
    }
    if (typeof listUrl !== "string") {
      const available = (Object.keys(LIST_TYPES) as ListType[]).filter((name) => typeof bodyListUrl(body, name) === "string");
      // Only add the 1.0 note when the body really links no list beyond the 1.0 four:
      // some servers publish a 1.0 `type` on a body that links all of them.
      const only1_0 = available.every((name) => LIST_TYPES_1_0.includes(name));
      throw new OparlParseError(
        `This body has no ${type} list. It links: ${available.join(", ") || "none"}` +
          (/\/1\.0\//.test(bodyType) && only1_0 ? " (OParl 1.0 bodies only link organization, person, meeting and paper)." : "."),
      );
    }
    return this.walk(resolveLink(bodyUrl, listUrl), query, options.maxPages ?? 1);
  }

  /**
   * Known OParl endpoints: the public registry at dev.oparl.org merged with the curated
   * list (`source` "all", the default), or either one alone. The registry is a snapshot
   * that is rarely updated; the live checks shipped with this package decide what an
   * entry reports (`working`, `checked`, `problem`, `replacedBy`, `note` and the System
   * data). Curated entries follow the registry's. A System listed twice appears once —
   * under the registry's entry where both lists hold it, reporting whichever of the two
   * live checks is newer. `source` "curated" makes no request.
   */
  async endpoints(options: { source?: EndpointSource } = {}): Promise<RegistryEntry[]> {
    const source = options.source ?? "all";
    if (source !== "all" && source !== "registry" && source !== "curated") {
      throw new OparlValidationError(`Unknown endpoint source "${String(source)}". Use all, registry or curated.`);
    }
    const checks = new Map(this.registryChecks.map((check) => [endpointKey(check.url), check]));
    const listed = new Map<string, number>();
    const registry: RegistryEntry[] = [];
    for (const entry of source === "curated" ? [] : await this.registry()) {
      const key = endpointKey(entry.url);
      if (listed.has(key)) continue; // the registry lists a few Systems twice
      listed.set(key, registry.length);
      registry.push(applyCheck(entry, checks));
    }
    if (source === "registry") return registry;
    const curated: RegistryEntry[] = [];
    for (const entry of this.curatedEndpoints) {
      const listedAt = listed.get(endpointKey(entry.url));
      const projected = curatedRegistryEntry(entry);
      if (listedAt === undefined) curated.push(projected);
      else registry[listedAt] = preferFresherCheck(registry[listedAt]!, projected);
    }
    return [...registry, ...curated];
  }

  /**
   * The registry at `registryUrl`, projected to the useful fields, without the curated
   * checks. Entries whose `url` is missing or not an http(s) URL are left out.
   */
  private async registry(): Promise<RegistryEntry[]> {
    parseHttpUrl(this.registryUrl);
    const entries: RegistryEntry[] = [];
    let url: string | null = this.registryUrl;
    const seen = new Set<string>();
    for (let page = 1; url !== null && page <= MAX_REGISTRY_PAGES; page++) {
      const query = page === 1 ? { page: 1, limit: 100 } : undefined;
      const value: unknown = await this.engine.getJson<unknown>(url, query);
      seen.add(withQuery(parseHttpUrl(url).href, query)); // the URL requested, not the base URL
      if (!isObject(value) || !Array.isArray(value["data"])) {
        throw new OparlParseError(`${url} is not the OParl endpoint registry (no data array).`);
      }
      for (const raw of value["data"]) {
        if (!isObject(raw)) continue;
        const entry = projectEntry(raw);
        // Skip an entry whose `url` is missing or not an http(s) URL: it is nothing
        // this client can fetch, and every such entry would key alike and so hide
        // the others (the registry does carry a few without a `url`).
        if (isFetchableUrl(entry.url)) entries.push(entry);
      }
      const meta = isObject(value["meta"]) ? value["meta"] : {};
      const nextLink = str(meta["next"]);
      url = nextLink ? resolveLink(url, nextLink) : null;
      if (url !== null && seen.has(url)) url = null;
    }
    return entries;
  }
}

/**
 * The created/modified filters of a list query, checked locally against an object's
 * `created`/`modified`: "no-match" when a timestamp is outside a filter's window,
 * "undated" when the object carries no parseable timestamp for a filter and none of the
 * others excludes it. An undated object cannot be excluded on the evidence — the spec
 * makes both fields mandatory, but 1.0 servers do omit them — so the caller keeps it and
 * reports that the filter could not be applied.
 */
function matchDateFilters(object: JsonObject, query: QueryParams): "match" | "no-match" | "undated" {
  const bounds = [
    ["created_since", "created", 1],
    ["created_until", "created", -1],
    ["modified_since", "modified", 1],
    ["modified_until", "modified", -1],
  ] as const;
  let undated = false;
  for (const [param, field, direction] of bounds) {
    const bound = query[param];
    if (typeof bound !== "string") continue;
    const value = object[field];
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(at)) {
      undated = true;
      continue;
    }
    if ((at - Date.parse(bound)) * direction < 0) return "no-match";
  }
  return undated ? "undated" : "match";
}

function projectEntry(raw: JsonObject): RegistryEntry {
  const system = isObject(raw["system"]) ? raw["system"] : null;
  const version = system ? str(system["oparlVersion"]) : null;
  return {
    title: str(raw["title"]) ?? "",
    url: str(raw["url"]) ?? "",
    source: "registry",
    working: system !== null && typeof system["body"] === "string",
    oparlVersion: version ? shortOparlVersion(version) : null,
    systemName: system ? str(system["name"]) : null,
    vendor: system ? str(system["vendor"]) : null,
    bodyCount: typeof raw["bodyCount"] === "number" ? raw["bodyCount"] : null,
    wikidata: str(raw["wikidata"]),
    fetched: str(raw["fetched"]),
    checked: null,
    problem: null,
    replacedBy: null,
    note: null,
  };
}

/** "https://schema.oparl.org/1.1/" → "1.1"; anything else unchanged. */
export function shortOparlVersion(version: string): string {
  return /\/(\d+\.\d+)\/?$/.exec(version)?.[1] ?? version;
}

/**
 * The key two endpoint URLs share when they name the same System: scheme, host
 * (lowercase, without a default port), path without a trailing slash, and query.
 *
 * The scheme is part of the key because `http://` and `https://` on the same host are
 * not interchangeable: of the councils the registry lists under both, some answer only
 * over one of them (Harsum's http vhost redirects to a host that does not exist, while
 * its https one answers HTTP 500). Ignoring it pasted the check taken on one scheme
 * onto the entry showing the other.
 */
export function endpointKey(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port === "" || u.port === "80" || u.port === "443" ? "" : `:${u.port}`;
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** A curated endpoint as `endpoints()` lists it. */
function curatedRegistryEntry(entry: CuratedEndpoint): RegistryEntry {
  return {
    title: entry.title,
    url: entry.url,
    source: "curated",
    working: entry.working,
    oparlVersion: entry.oparlVersion,
    systemName: entry.systemName,
    vendor: entry.vendor,
    bodyCount: entry.bodyCount,
    wikidata: null,
    fetched: null,
    checked: entry.checked,
    problem: entry.problem,
    replacedBy: null,
    note: entry.note,
  };
}

/**
 * A registry entry and a curated entry for the same System: whichever carries the newer
 * live check says whether the endpoint works and why not, while the registry's entry
 * keeps its `title`, `source`, `wikidata`, `fetched` and `replacedBy`. The generated
 * list normally holds one record per System — `check-endpoints` folds a curated entry
 * the registry has caught up with into the registry checks — but an installed copy of
 * this package is merged with a registry snapshot it never saw.
 */
function preferFresherCheck(listed: RegistryEntry, curated: RegistryEntry): RegistryEntry {
  if (curated.checked === null) return listed;
  if (listed.checked !== null && listed.checked >= curated.checked) return listed;
  return {
    ...listed,
    working: curated.working,
    oparlVersion: curated.oparlVersion ?? listed.oparlVersion,
    systemName: curated.systemName ?? listed.systemName,
    vendor: curated.vendor ?? listed.vendor,
    bodyCount: curated.bodyCount ?? listed.bodyCount,
    checked: curated.checked,
    problem: curated.problem,
    note: curated.note ?? listed.note,
  };
}

function applyCheck(entry: RegistryEntry, checks: Map<string, RegistryCheck>): RegistryEntry {
  const check = checks.get(endpointKey(entry.url));
  if (check === undefined) return entry;
  return {
    ...entry,
    working: check.working,
    // The check read the live System; the registry's cached copy of it is rarely
    // refreshed and missing altogether for some endpoints. Where the check has no
    // value (it failed, or the server doesn't publish the field), the registry's stands.
    oparlVersion: check.oparlVersion ?? entry.oparlVersion,
    systemName: check.systemName ?? entry.systemName,
    vendor: check.vendor ?? entry.vendor,
    bodyCount: check.bodyCount ?? entry.bodyCount,
    checked: check.checked,
    problem: check.problem,
    replacedBy: check.replacedBy,
    note: check.note,
  };
}
