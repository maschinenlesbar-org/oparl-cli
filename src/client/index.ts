// Public entry point for the API client library.

export {
  OparlClient,
  DEFAULT_REGISTRY_URL,
  LIST_TYPES,
  MAX_PAGES_HARD_LIMIT,
  endpointKey,
  isListType,
  listQuery,
  normalizeTimestamp,
  shortOparlVersion,
} from "./client.js";
export type { EndpointSource, EndpointsOptions, EndpointsReport, ListOptions, ListType, OparlClientOptions } from "./client.js";
export {
  MIN_UMLAUT_PASS_LENGTH,
  checkEndpointFilters,
  contractUmlautSpellings,
  filterEndpoints,
  foldSearchText,
  normalizeOparlVersion,
  oparlVersionProblem,
  searchMatches,
  searchTextProblem,
} from "./endpoints-search.js";
export type { EndpointFilters } from "./endpoints-search.js";
export { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "./endpoints-list.js";
export {
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  carryQuery,
  encodeTimestampPlus,
  headerValueProblem,
  parseHttpUrl,
  parseRetryAfter,
  resolveLink,
  sanitizeServerText,
  upgradeSameHostUrls,
  userAgentProblem,
  withQuery,
} from "./engine.js";
export type { EngineOptions, JsonResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export { MAX_LIST_LIMIT, assertValid, intRangeProblem, listLimitProblem, maxPagesProblem } from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryPrimitive, QueryValue } from "./query.js";
export {
  OparlError,
  OparlApiError,
  OparlNetworkError,
  OparlValidationError,
  OparlParseError,
  OparlLinkError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
