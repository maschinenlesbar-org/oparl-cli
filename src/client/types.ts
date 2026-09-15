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
}

/** An entry of the public OParl endpoint registry (dev.oparl.org), projected. */
export interface RegistryEntry {
  title: string;
  /** The endpoint's System URL. */
  url: string;
  /** True when the registry's last fetch returned a System object. */
  working: boolean;
  /** "1.0", "1.1", … taken from the cached System's oparlVersion; null when unknown. */
  oparlVersion: string | null;
  /** The System's `name` (usually the product), when cached. */
  systemName: string | null;
  vendor: string | null;
  bodyCount: number | null;
  wikidata: string | null;
  /** When the registry last fetched the endpoint (ISO 8601). */
  fetched: string | null;
}
