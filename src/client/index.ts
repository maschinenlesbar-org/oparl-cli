// Public entry point for the API client library.

export {
  OparlClient,
  DEFAULT_REGISTRY_URL,
  LIST_TYPES,
  endpointKey,
  listQuery,
  normalizeTimestamp,
  shortOparlVersion,
} from "./client.js";
export type { EndpointSource, ListOptions, ListType, OparlClientOptions } from "./client.js";
export { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "./endpoints-list.js";
export {
  RequestEngine,
  carryQuery,
  parseHttpUrl,
  resolveLink,
  sanitizeServerText,
  upgradeSameHostUrls,
  withQuery,
} from "./engine.js";
export type { EngineOptions } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryPrimitive, QueryValue } from "./query.js";
export {
  OparlError,
  OparlApiError,
  OparlNetworkError,
  OparlValidationError,
  OparlParseError,
  OparlLinkError,
} from "./errors.js";

export * from "./types.js";
