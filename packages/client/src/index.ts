// Public entry point for the API client library.

export {
  OparlClient,
  DEFAULT_REGISTRY_URL,
  bodyListUrl,
  LIST_TYPES,
  MAX_PAGES_HARD_LIMIT,
  MAX_REGISTRY_PAGES,
  endpointKey,
  isListType,
  listQuery,
  normalizeTimestamp,
  shortOparlVersion,
} from "./client.js";
export type { EndpointSource, EndpointsOptions, EndpointsReport, ListOptions, ListType, OparlClientOptions } from "./client.js";
export {
  ENGLISH_PLACE_NAMES,
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
  cleartextProblem,
  encodeTimestampPlus,
  headerValueProblem,
  isBidiControl,
  parseHttpUrl,
  parseRetryAfter,
  parseUrlArgument,
  resolveLink,
  sanitizeServerText,
  upgradeSameHostUrls,
  userAgentProblem,
  withQuery,
} from "./engine.js";
export type { EngineOptions, JsonResponse, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export {
  MAX_LIST_LIMIT,
  assertValid,
  intRangeProblem,
  listLimitProblem,
  listProblem,
  maxPagesProblem,
  normalizeText,
  normalizeToken,
  splitList,
  textProblem,
  tokenProblem,
  urlArgumentProblem,
} from "./validate.js";
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
export {
  DEFAULT_ENDPOINTS,
  DEFAULT_MEETINGS,
  DEFAULT_OBJECTS,
  DEFAULT_PAPERS,
  MAX_ENDPOINTS,
  MAX_MEETINGS,
  MAX_OBJECTS,
  MAX_PAPERS,
  checkEndpoint,
  findEndpoints,
  findMeetings,
  findPapers,
  getObject,
  knownHosts,
  licenceOf,
  listObjects,
  reachProblem,
  requestsOf,
} from "./operations.js";
export type {
  BodyRef,
  BodySummary,
  CheckEndpointAnswer,
  CheckEndpointParams,
  EndpointHit,
  FindEndpointsAnswer,
  FindEndpointsParams,
  FindMeetingsAnswer,
  FindMeetingsParams,
  FindPapersAnswer,
  FindPapersParams,
  GetObjectAnswer,
  LicenceStatement,
  ListObjectsAnswer,
  ListObjectsParams,
  MeetingHit,
  PaperHit,
} from "./operations.js";
