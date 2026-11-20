// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.
//
// OParl has no one API host: every council runs its own server, and the tools take the URLs those
// servers publish (a System, a Body, an object, a page), on the hosts of the known servers only
// (operations.ts, reachProblem). What --base-url names is the endpoint registry findEndpoints reads
// (dev.oparl.org's by default, the CLI's `endpoints --registry-url`); its host is reachable too, so
// a server run for one's own OParl server can be pointed at a registry on that host.

import { DEFAULT_REGISTRY_URL, OparlClient, parseUrlArgument, type OparlClientOptions } from "@maschinenlesbar.org/oparl-client";

export {
  OparlError as ClientError,
  OparlNetworkError as NetworkError,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/oparl-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/oparl-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/oparl-client/internal/errors";

/** The endpoint registry the server reads without --base-url. */
export const DEFAULT_BASE_URL = DEFAULT_REGISTRY_URL;

/** The client, with the kit's `baseUrl` as the registry it reads. */
export class Client extends OparlClient {
  constructor(options: OparlClientOptions & { baseUrl?: string } = {}) {
    const { baseUrl, ...rest } = options;
    super(baseUrl === undefined ? rest : { ...rest, registryUrl: baseUrl });
  }
}

/** Why `value` can't be the registry URL (--base-url), or undefined. */
export function baseUrlProblem(value: string): string | undefined {
  try {
    parseUrlArgument(value);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Where the registry is (`--base-url`, else dev.oparl.org's), up to its last path segment
 * (https://dev.oparl.org/api): findEndpoints' source is the registry under it, the other tools'
 * the URLs of the council servers they asked; its host is one the tools may reach.
 */
export function apiBase(baseUrl: string | undefined): string {
  const url = new URL(baseUrl ?? DEFAULT_BASE_URL);
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/[^/]*$/, "");
}
