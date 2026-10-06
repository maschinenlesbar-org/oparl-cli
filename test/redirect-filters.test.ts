// A filtered walk keeps the caller's filters on every page and every redirect hop, against
// two real local servers (two ports play two hosts): finding oparl-cli 01#1 / 06#1 of the
// 2026-10-05 exploratory review. Page 2 redirects — to a path without the filters, to one
// with the server's stale values, or to the other host — and nothing unfiltered may reach
// the result, the `-o` file included.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OparlClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";

const SINCE = "2026-09-01T00:00:00+00:00";

interface Mock {
  origin: string;
  seen: URL[];
  close(): Promise<void>;
}

/** A local server that records each request (as a URL) and answers with `answer`. */
async function mock(answer: (url: URL, res: http.ServerResponse, origin: string) => void): Promise<Mock> {
  const seen: URL[] = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    seen.push(url);
    answer(url, res, origin);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const sendJson = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Whether a request carried the caller's filter (and limit 2), not a stale one. */
const filtered = (url: URL): boolean => url.searchParams.get("modified_since") === SINCE && url.searchParams.get("limit") === "2";

/**
 * A council server whose page 2 redirects to `target(origin)`. Every list answer says
 * whether it was asked with the caller's filter: an unfiltered one returns an object
 * marked `unfiltered`, which must never reach the result.
 */
function council(target: (origin: string) => string) {
  return (url: URL, res: http.ServerResponse, origin: string): void => {
    const page = url.searchParams.get("page");
    if (url.pathname === "/body") {
      return sendJson(res, { id: `${origin}/body`, type: "https://schema.oparl.org/1.1/Body", paper: `${origin}/papers` });
    }
    if (url.pathname === "/papers" && page === "2") {
      res.writeHead(302, { location: target(origin) });
      res.end();
      return;
    }
    const n = page ?? "1";
    const object = filtered(url) ? { id: `${origin}/papers/${n}` } : { id: `${origin}/papers/${n}-all`, unfiltered: true };
    const next = n === "1" ? `${origin}/papers?page=2&modified_since=${encodeURIComponent(SINCE)}&limit=2` : n === "moved" ? `${origin}/papers?page=3` : null;
    return sendJson(res, { data: [object], links: next === null ? {} : { next } });
  };
}

const options = { modifiedSince: "2026-09-01", limit: 2, maxPages: 0 };

test("a page-2 redirect without the filters, or with the server's stale ones, gets the caller's filters again", async () => {
  for (const target of [
    (origin: string) => `${origin}/papers?page=moved`,
    () => `/papers?page=moved&modified_since=1999-01-01T00:00:00Z&limit=999`,
    (origin: string) => `${origin}/papers?page=moved&modified_since=1999-01-01T00:00:00+00:00&limit=999`,
  ]) {
    const a = await mock(council(target));
    try {
      const result = await new OparlClient({ maxRetries: 0 }).list(`${a.origin}/body`, "paper", options);
      assert.deepEqual(
        result.data.map((o) => o["id"]),
        [`${a.origin}/papers/1`, `${a.origin}/papers/moved`, `${a.origin}/papers/3`],
        JSON.stringify(result),
      );
      assert.ok(result.data.every((o) => o["unfiltered"] === undefined));
      const moved = a.seen.filter((u) => u.searchParams.get("page") === "moved");
      assert.equal(moved.length, 1);
      assert.ok(filtered(moved[0]!), `the redirect target was asked ${moved[0]!.search}`);
    } finally {
      await a.close();
    }
  }
});

test("a page-2 redirect to the other host is refused: nothing reaches it, the walk ends with a note", async () => {
  const b = await mock((_url, res, origin) => sendJson(res, { data: [{ id: `${origin}/papers/b`, unfiltered: true }], links: {} }));
  const a = await mock(council(() => `${b.origin}/papers?page=2`));
  try {
    const result = await new OparlClient({ maxRetries: 0 }).list(`${a.origin}/body`, "paper", options);
    assert.deepEqual(result.data.map((o) => o["id"]), [`${a.origin}/papers/1`]);
    assert.equal(result.next, null);
    assert.match(result.note ?? "", /another (host|port)/);
    assert.equal(b.seen.length, 0, "the other host got no request");
  } finally {
    await a.close();
    await b.close();
  }
});

test("the -o file of a walk through a redirecting page holds only filtered objects", async () => {
  const a = await mock(council((origin) => `${origin}/papers?page=moved&modified_since=1999-01-01T00:00:00Z`));
  try {
    const files = new Map<string, string>();
    const err: string[] = [];
    const deps: CliDeps = {
      io: { out: () => {}, err: (s) => err.push(s), writeFile: (path, data) => void files.set(path, data.toString("utf8")) },
      createClient: (opts) => new OparlClient(opts),
    };
    const argv = ["list", "paper", `${a.origin}/body`, "--max-pages", "0", "--modified-since", "2026-09-01", "--limit", "2", "-o", "delta.json"];
    assert.equal(await run(argv, deps), 0, err.join("\n"));
    const written = JSON.parse(files.get("delta.json") ?? "null") as { data: Array<Record<string, unknown>> };
    assert.equal(written.data.length, 3);
    assert.ok(written.data.every((o) => o["unfiltered"] === undefined), JSON.stringify(written));
    // Every list request carried the caller's filters.
    assert.ok(a.seen.filter((u) => u.pathname === "/papers" && u.searchParams.get("page") !== "2").every(filtered));
  } finally {
    await a.close();
  }
});

test("get on a page URL keeps the URL's filters across a redirect", async () => {
  const a = await mock(council((origin) => `${origin}/papers?page=moved`));
  try {
    const next = `${a.origin}/papers?page=2&modified_since=${encodeURIComponent(SINCE)}&limit=2`;
    const page = await new OparlClient({ maxRetries: 0 }).get(next);
    assert.deepEqual((page["data"] as Array<Record<string, unknown>>).map((o) => o["id"]), [`${a.origin}/papers/moved`]);
    const moved = a.seen.find((u) => u.searchParams.get("page") === "moved");
    assert.ok(moved !== undefined && filtered(moved), moved?.search);
  } finally {
    await a.close();
  }
});
