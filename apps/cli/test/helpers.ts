// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/oparl-client/internal/http";
import { OparlClient, type OparlClientOptions } from "@maschinenlesbar.org/oparl-client/internal/client";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/oparl-client/test/helpers";

export * from "@maschinenlesbar.org/oparl-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [oparl.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** What the CLI did with one input: exit code, output, and the requests it sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, and the requests it sent. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  requests: HttpRequest[];
}

/**
 * Drive one input through the CLI (`run(argv)`, its client built on the recording mock
 * transport) and through a library call on the same transport, and return both
 * outcomes, each with the requests it sent. A parity test then asserts the two agree:
 * both reject without a request, or both send the same requests and give the same
 * result.
 *
 * `clientOptions` are given to the CLI's client under the options the CLI derives from
 * argv (as the tests' own `makeCli` does with the endpoint lists); the library call
 * builds its own client from the transport it is handed.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse({}),
  clientOptions: Partial<OparlClientOptions> = {},
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {
        throw new Error("parity(): the CLI tried to write a file");
      },
    },
    createClient: (opts) => new OparlClient({ ...clientOptions, ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cliCalls = mt.calls.length;
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: mt.calls.slice(0, cliCalls) };
  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(cliCalls) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(cliCalls) };
  }
  return { cli, lib };
}
