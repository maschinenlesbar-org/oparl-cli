// OparlClient — a typed, read-only client for OParl, the standard API of German
// municipal council information systems (Ratsinformationssysteme). No auth.
//
// There is no central OParl host: every municipality runs its own server, found in
// the public registry at dev.oparl.org. Navigation is by URL — a System lists its
// bodies, each Body links its object lists (meetings, papers, persons, …), and
// lists are paged through `links.next`.
//
//   const c = new OparlClient();
//   const endpoints = await c.endpoints();                  // the public registry
//   const system = await c.system(endpoints[0].url);        // an endpoint's System
//   const { data: bodies } = await c.bodies(system.id);     // its bodies
//   const meetings = await c.list(bodies[0].id, "meeting"); // first page of meetings

import { RequestEngine, parseHttpUrl, resolveLink, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { OparlParseError, OparlValidationError } from "./errors.js";
import type {
  JsonObject,
  JsonValue,
  ListResult,
  OparlBody,
  OparlListPage,
  OparlObject,
  OparlSystem,
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

/** Guard against a server whose `next` links never end. */
const MAX_PAGES_HARD_LIMIT = 10_000;
const MAX_REGISTRY_PAGES = 50;

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
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: JsonValue | undefined): string | null => (typeof value === "string" ? value : null);

/**
 * Normalise an OParl timestamp filter: a date (`2026-09-01`) becomes midnight UTC,
 * `Z` becomes `+00:00` (the spec's `±hh:mm` form). Anything else is rejected.
 */
export function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(trimmed);
  const parts = date ?? dateTime;
  if (!parts) {
    throw new OparlValidationError(
      `Invalid timestamp "${value}": use YYYY-MM-DD or YYYY-MM-DDThh:mm:ss±hh:mm.`,
    );
  }
  const [, y, m, d] = parts;
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) {
    throw new OparlValidationError(`Invalid timestamp "${value}": no such date.`);
  }
  if (dateTime && (Number(dateTime[4]) > 23 || Number(dateTime[5]) > 59 || Number(dateTime[6]) > 59)) {
    throw new OparlValidationError(`Invalid timestamp "${value}": no such time.`);
  }
  if (date) return `${trimmed}T00:00:00+00:00`;
  return trimmed.replace(/Z$/, "+00:00");
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

  constructor(options: OparlClientOptions = {}) {
    this.engine = new RequestEngine(options);
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
  }

  /**
   * Fetch one OParl object by URL. Rejects non-objects and OParl/vendor error objects
   * (`{ "error": "…" }` without an `id`) with an OparlParseError.
   */
  async get<T extends JsonObject = OparlObject>(url: string): Promise<T> {
    const value = await this.engine.getJson<unknown>(url);
    if (!isObject(value)) {
      throw new OparlParseError(`Expected an OParl object from ${url} but got ${Array.isArray(value) ? "an array" : typeof value}.`);
    }
    if (typeof value["id"] !== "string" && (typeof value["error"] === "string" || typeof value["message"] === "string")) {
      const message = String(value["error"] ?? value["message"]);
      throw new OparlParseError(`The server at ${url} answered with an error object: ${message.slice(0, 200)}`);
    }
    return value as T;
  }

  /** Fetch a System, the entry point of an OParl server. */
  async system(url: string): Promise<OparlSystem> {
    const system = await this.get<JsonObject>(url);
    const type = str(system["type"]) ?? "";
    if (!/\/System$/.test(type) || typeof system["body"] !== "string") {
      throw new OparlParseError(
        `${url} is not an OParl System (type: ${type || "missing"}). Use the endpoint's System URL, e.g. from \`oparl endpoints\`.`,
      );
    }
    return system as OparlSystem;
  }

  /** Fetch one list page and check it has a `data` array. */
  async page<T extends JsonObject = OparlObject>(url: string, query?: QueryParams): Promise<OparlListPage<T>> {
    const value = await this.engine.getJson<unknown>(url, query);
    if (!isObject(value) || !Array.isArray(value["data"])) {
      const type = isObject(value) ? str(value["type"]) : null;
      throw new OparlParseError(
        `${url} is not an OParl object list${type ? ` (got an object of type ${type})` : ""}.`,
      );
    }
    return value as unknown as OparlListPage<T>;
  }

  /**
   * Walk a list from its first page along `links.next`, staying on the same host.
   * `maxPages` 0 fetches every page (with a loop guard).
   */
  async walk<T extends JsonObject = OparlObject>(url: string, query?: QueryParams, maxPages = 1): Promise<ListResult<T>> {
    if (!Number.isInteger(maxPages) || maxPages < 0) {
      throw new OparlValidationError("maxPages must be a non-negative integer.");
    }
    const limit = maxPages === 0 ? MAX_PAGES_HARD_LIMIT : maxPages;
    const data: T[] = [];
    const seen = new Set<string>();
    let current: string | null = url;
    let pages = 0;
    let next: string | null = null;
    while (current !== null && pages < limit) {
      const page: OparlListPage<T> = await this.page<T>(current, pages === 0 ? query : undefined);
      seen.add(current);
      pages += 1;
      data.push(...page.data);
      const link = page.links?.next;
      next = typeof link === "string" && link !== "" ? resolveLink(current, link) : null;
      if (next !== null && seen.has(next)) {
        next = null; // the server's `next` points back at a page already fetched
      }
      current = next;
    }
    return { data, pages, next };
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
    const listUrl = body[field];
    if (typeof listUrl !== "string") {
      const available = Object.entries(LIST_TYPES)
        .filter(([, key]) => typeof body[key] === "string")
        .map(([name]) => name);
      throw new OparlParseError(
        `This body has no ${type} list. It links: ${available.join(", ") || "none"}` +
          (/\/1\.0\//.test(bodyType) ? " (OParl 1.0 bodies only link organization, person, meeting and paper)." : "."),
      );
    }
    return this.walk(resolveLink(bodyUrl, listUrl), query, options.maxPages ?? 1);
  }

  /**
   * The public OParl endpoint registry, projected to the useful fields. The registry
   * is a snapshot: `working` and `fetched` say when it last reached each endpoint.
   */
  async endpoints(): Promise<RegistryEntry[]> {
    parseHttpUrl(this.registryUrl);
    const entries: RegistryEntry[] = [];
    let url: string | null = this.registryUrl;
    const seen = new Set<string>();
    for (let page = 1; url !== null && page <= MAX_REGISTRY_PAGES; page++) {
      const value: unknown = await this.engine.getJson<unknown>(url, page === 1 ? { page: 1, limit: 100 } : undefined);
      seen.add(url);
      if (!isObject(value) || !Array.isArray(value["data"])) {
        throw new OparlParseError(`${url} is not the OParl endpoint registry (no data array).`);
      }
      for (const raw of value["data"]) {
        if (isObject(raw)) entries.push(projectEntry(raw));
      }
      const meta = isObject(value["meta"]) ? value["meta"] : {};
      const nextLink = str(meta["next"]);
      url = nextLink ? resolveLink(url, nextLink) : null;
      if (url !== null && seen.has(url)) url = null;
    }
    return entries;
  }
}

function projectEntry(raw: JsonObject): RegistryEntry {
  const system = isObject(raw["system"]) ? raw["system"] : null;
  const version = system ? str(system["oparlVersion"]) : null;
  return {
    title: str(raw["title"]) ?? "",
    url: str(raw["url"]) ?? "",
    working: system !== null && typeof system["body"] === "string",
    oparlVersion: version ? (/\/(\d+\.\d+)\/?$/.exec(version)?.[1] ?? version) : null,
    systemName: system ? str(system["name"]) : null,
    vendor: system ? str(system["vendor"]) : null,
    bodyCount: typeof raw["bodyCount"] === "number" ? raw["bodyCount"] : null,
    wikidata: str(raw["wikidata"]),
    fetched: str(raw["fetched"]),
  };
}
