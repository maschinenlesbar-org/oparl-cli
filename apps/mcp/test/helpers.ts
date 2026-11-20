// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream on the recorded answers of the ITK Rheinland OParl server (Düsseldorf) and the
// registry at dev.oparl.org (the client's oparl.ts, recorded on 2026-11-20), a mock registry over
// given entries, and the client's transport helpers. The generic harness (a connection, a config,
// a log recorder, the HTTP server) is harness.ts.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/oparl-client/test/helpers";

export * from "@maschinenlesbar.org/oparl-client/test/helpers";
export * from "@maschinenlesbar.org/oparl-client/test/oparl";

/** A registry (any path) listing `entries` (title and url; a working System each), on one page. */
export function registryWith(entries: { title: string; url: string }[]): MockTransport {
  return makeMockTransport(() =>
    jsonResponse({
      data: entries.map((entry, i) => ({ id: i + 1, ...entry, system: { type: "https://schema.oparl.org/1.1/System", oparlVersion: "https://schema.oparl.org/1.1/", body: `${entry.url}/bodies` } })),
      meta: { page: 1, total: entries.length, totalPages: 1 },
    }),
  );
}
