// Response types. OParl objects are typed only as far as this client relies on
// them (the entry-point fields and list links); everything else stays an open
// record, because servers add vendor fields (e.g. "STERNBERG:RIMVersion") and
// OParl 1.0 and 1.1 differ in detail.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Any OParl object: at least an `id` (its own URL) and a `type` URI. */
export interface OparlObject extends JsonObject {
  id: string;
  type: string;
}

/** The entry point of an OParl server. */
export interface OparlSystem extends OparlObject {
  /** OParl version URI, e.g. "https://schema.oparl.org/1.1/". */
  oparlVersion: string;
  /** URL of the list of bodies (Körperschaften) on this server. */
  body: string;
}

/** A body (Körperschaft) — usually one municipality or district. */
export interface OparlBody extends OparlObject {
  name: string;
}

/** One page of an OParl object list. */
export interface OparlListPage<T extends JsonObject = OparlObject> {
  data: T[];
  pagination?: JsonObject;
  links?: { next?: string; [key: string]: JsonValue | undefined };
}

/** The result of walking an object list across one or more pages. */
export interface ListResult<T extends JsonObject = OparlObject> {
  /** Every object from the pages fetched, in server order. */
  data: T[];
  /** Number of pages fetched. */
  pages: number;
  /** The `next` link of the last page fetched, or null when the list is exhausted. */
  next: string | null;
  /**
   * Present (and true) when the walk stopped at a paging loop: the server's `next` link
   * pointed back at a page already fetched, or a page only repeated objects already
   * listed. `data` then holds every distinct object seen.
   */
  looped?: true;
}

/**
 * An OParl endpoint as `endpoints()` lists it: an entry of the public registry at
 * dev.oparl.org, or of the curated list shipped with this package.
 */
export interface RegistryEntry {
  title: string;
  /** The endpoint's System URL. */
  url: string;
  /** Where the entry comes from: the dev.oparl.org registry or the curated list. */
  source: "registry" | "curated";
  /**
   * Whether the endpoint answered with a System and its bodies: from the most recent
   * live check (`checked`) when there is one, else from the registry's last fetch.
   */
  working: boolean;
  /** "1.0", "1.1", … taken from the System's oparlVersion; null when unknown. */
  oparlVersion: string | null;
  /** The System's `name` (usually the product), when known. */
  systemName: string | null;
  vendor: string | null;
  bodyCount: number | null;
  wikidata: string | null;
  /** When the registry last fetched the endpoint (ISO 8601); null for curated entries. */
  fetched: string | null;
  /** The day of the last live check by this package's maintainers (YYYY-MM-DD), or null. */
  checked: string | null;
  /** Why that check failed (e.g. "HTTP 404"), or null. */
  problem: string | null;
  /** The System URL that replaces this one, when the server moved. */
  replacedBy: string | null;
  /** A short note, e.g. that the server is an archive or needs a certificate workaround. */
  note: string | null;
}

/** An OParl endpoint the dev.oparl.org registry lacks, kept in the curated list. */
export interface CuratedEndpoint {
  title: string;
  /** The System URL. */
  url: string;
  working: boolean;
  /** The day of the last live check (YYYY-MM-DD). */
  checked: string;
  problem: string | null;
  oparlVersion: string | null;
  systemName: string | null;
  vendor: string | null;
  bodyCount: number | null;
  note: string | null;
}

/** The result of a live check of a registry entry, keyed by its System URL. */
export interface RegistryCheck {
  url: string;
  working: boolean;
  /** The day of the check (YYYY-MM-DD). */
  checked: string;
  problem: string | null;
  replacedBy: string | null;
  note: string | null;
}
