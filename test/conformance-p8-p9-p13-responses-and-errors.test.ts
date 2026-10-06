// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { OparlClient as Client } from "../src/client/client.js";
import {
  OparlError as BaseError,
  OparlParseError as ParseError,
  OparlValidationError as ValidationError,
} from "../src/client/errors.js";
const SYSTEM = "https://ris.example/oparl/system";
const BODY = "https://ris.example/oparl/bodies/1";
const SYSTEM_TYPE = "https://schema.oparl.org/1.1/System";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.system(SYSTEM);
const textBody = (text: string): unknown => ({ id: SYSTEM, type: SYSTEM_TYPE, body: `${SYSTEM}/bodies`, name: text });
const readText = (result: unknown): string => (result as { name: string }).name;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42,
  { id: BODY, type: "https://schema.oparl.org/1.1/Body" },
  { error: "boom" },
  { type: "https://schema.oparl.org/1.1/Error", message: "boom" },
  { id: SYSTEM, type: SYSTEM_TYPE, body: null },
];
/** A transport for the P13 calls: they must fail before any request, and none may reach a network. */
const offline = {
  transport: async (): Promise<HttpResponse> => {
    throw new Error("P13: a rejected input must not send a request");
  },
};
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["system(5)", () => new Client(offline).system(5 as unknown as string)],
  ["get(null)", () => new Client(offline).get(null as unknown as string)],
  ["page({})", () => new Client(offline).page({} as unknown as string)],
  ["list(body, 5)", () => new Client(offline).list(BODY, 5 as unknown as "paper")],
  ["list(body, 'paper', { modifiedSince: 5 })", () => new Client(offline).list(BODY, "paper", { modifiedSince: 5 as unknown as string })],
  ["list(body, 'paper', { createdUntil: new Date() })", () => new Client(offline).list(BODY, "paper", { createdUntil: new Date() as unknown as string })],
  ["list(body, 'paper', { limit: '2' })", () => new Client(offline).list(BODY, "paper", { limit: "2" as unknown as number })],
  ["list(body, 'paper', { maxPages: -1 })", () => new Client(offline).list(BODY, "paper", { maxPages: -1 })],
  ["list(body, 'paper', { omitInternal: 'yes' })", () => new Client(offline).list(BODY, "paper", { omitInternal: "yes" as unknown as boolean })],
  ["walk(url, undefined, '1')", () => new Client(offline).walk(BODY, undefined, "1" as unknown as number)],
  ["bodies(system, { maxPages: 1.5 })", () => new Client(offline).bodies(SYSTEM, { maxPages: 1.5 })],
  ["endpoints({ search: 5 })", () => new Client(offline).endpoints({ search: 5 as unknown as string, source: "curated" })],
  ["endpoints({ oparlVersion: {} })", () => new Client(offline).endpoints({ oparlVersion: {} as unknown as string, source: "curated" })],
  ["endpoints({ working: 'yes' })", () => new Client(offline).endpoints({ working: "yes" as unknown as boolean, source: "curated" })],
  ["endpoints({ source: 5 })", () => new Client(offline).endpoints({ source: 5 as unknown as "all" })],
  ["timeoutMs: 'x'", () => new Client({ ...offline, timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ ...offline, timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ ...offline, maxRetries: 1.5 })],
  ["registryUrl: 5", () => new Client({ ...offline, registryUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ ...offline, userAgent: {} as unknown as string })],
  ["defaultHeaders: 'x'", () => new Client({ ...offline, defaultHeaders: "x" as unknown as Record<string, string> })],
  ["defaultHeaders: { A: 5 }", () => new Client({ ...offline, defaultHeaders: { A: 5 } as unknown as Record<string, string> })],
  ["transport: 'x'", () => new Client({ ...offline, transport: "x" as never })],
  ["sleep: 5", () => new Client({ ...offline, sleep: 5 as never })],
  ["curatedEndpoints: 'x'", () => new Client({ ...offline, curatedEndpoints: "x" as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
