// Public entry point for the API client library.

export { OparlClient, DEFAULT_REGISTRY_URL, LIST_TYPES, listQuery, normalizeTimestamp } from "./client.js";
export type { ListOptions, ListType, OparlClientOptions } from "./client.js";
export { RequestEngine, parseHttpUrl, resolveLink, sanitizeServerText, withQuery } from "./engine.js";
export type { EngineOptions } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
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
