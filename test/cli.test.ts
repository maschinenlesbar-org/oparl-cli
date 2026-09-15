import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { OparlClient } from "../src/client/client.js";
import { OparlNetworkError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { jsonResponse, makeMockTransport, queryOf, rawResponse, routes } from "./helpers.js";
import * as fx from "./fixtures.js";

const site = {
  [fx.SYSTEM_URL]: jsonResponse(fx.system),
  [fx.BODIES_URL]: jsonResponse(fx.bodyList),
  [fx.BODY_URL]: jsonResponse(fx.body),
  [fx.MEETINGS_URL]: jsonResponse(fx.meetingPages[1]),
  [`${fx.MEETINGS_URL}?page=2`]: jsonResponse(fx.meetingPages[2]),
  [`${fx.MEETINGS_URL}?page=3`]: jsonResponse(fx.meetingPages[3]),
  [`${fx.REGISTRY_URL}?page=1&limit=100`]: jsonResponse(fx.registryPage1),
  [`${fx.REGISTRY_URL}?page=2&limit=100`]: jsonResponse(fx.registryPage2),
};

function makeCli(responder?: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, Buffer> = {};
  const mt = responder ? makeMockTransport(responder) : routes(site);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => {
        files[p] = d;
      },
    },
    createClient: (opts) => new OparlClient({ ...opts, transport: mt.transport }),
  };
  const json = () => JSON.parse(out.join("\n")) as unknown;
  return { deps, out, err, mt, files, json };
}

test("endpoints lists the registry across pages", async () => {
  const cli = makeCli();
  assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL], cli.deps), 0);
  assert.equal((cli.json() as unknown[]).length, 3);
  assert.equal(queryOf(cli.mt.calls[0]!).get("limit"), "100");
});

test("endpoints --search, --oparl-version and --working filter client-side", async () => {
  const cli = makeCli();
  await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--working", "--oparl-version", "1.0"], cli.deps);
  assert.deepEqual((cli.json() as Array<{ title: string }>).map((e) => e.title), ["Gemeinde Musterdorf"]);

  const cli2 = makeCli();
  await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--search", "IRGENDWO"], cli2.deps);
  assert.deepEqual((cli2.json() as Array<{ title: string }>).map((e) => e.title), ["Amt Irgendwo"]);
});

test("endpoints --registry-url points at another registry", async () => {
  const cli = makeCli(() => jsonResponse({ data: [], meta: {} }));
  assert.equal(await run(["endpoints", "--registry-url", "https://mirror.example.org/endpoints"], cli.deps), 0);
  assert.match(cli.mt.last().url, /^https:\/\/mirror\.example\.org\/endpoints\?/);
});

test("system prints the System object", async () => {
  const cli = makeCli();
  assert.equal(await run(["system", fx.SYSTEM_URL], cli.deps), 0);
  assert.equal((cli.json() as { body: string }).body, fx.BODIES_URL);
});

test("bodies prints { data, pages, next }", async () => {
  const cli = makeCli();
  await run(["bodies", fx.SYSTEM_URL], cli.deps);
  const result = cli.json() as { data: Array<{ id: string }>; pages: number; next: string | null };
  assert.deepEqual({ ids: result.data.map((b) => b.id), pages: result.pages, next: result.next }, { ids: [fx.BODY_URL], pages: 1, next: null });
});

test("list meeting fetches one page and passes the filters", async () => {
  const cli = makeCli();
  assert.equal(await run(["list", "meeting", fx.BODY_URL, "--modified-since", "2026-09-01T10:00:00Z", "--limit", "25"], cli.deps), 0);
  const result = cli.json() as { data: unknown[]; pages: number; next: string };
  assert.deepEqual({ n: result.data.length, pages: result.pages }, { n: 2, pages: 1 });
  const q = queryOf(cli.mt.calls[1]!);
  assert.equal(q.get("modified_since"), "2026-09-01T10:00:00+00:00");
  assert.equal(q.get("limit"), "25");
  // `next` keeps the filters, so `oparl get <next>` continues the same filtered list.
  const next = new URL(result.next).searchParams;
  assert.deepEqual([next.get("page"), next.get("modified_since"), next.get("limit")], ["2", "2026-09-01T10:00:00+00:00", "25"]);
});

test("list --max-pages 0 walks every page", async () => {
  const cli = makeCli();
  await run(["list", "meeting", fx.BODY_URL, "--max-pages", "0"], cli.deps);
  assert.equal((cli.json() as { data: unknown[] }).data.length, 5);
});

test("usage errors exit 2 without a request", async () => {
  const cases = [
    ["list", "meetings", fx.BODY_URL],
    ["list", "meeting", "not-a-url"],
    ["list", "meeting", "ftp://ris.example.de/body"],
    ["list", "meeting", fx.BODY_URL, "--modified-since", "2026-02-30"],
    ["list", "meeting", fx.BODY_URL, "--limit", "0"],
    ["list", "meeting", fx.BODY_URL, "--max-pages", "-1"],
    ["get"],
    ["--max-redirects", "11", "get", fx.SYSTEM_URL],
    ["--user-agent", "bad\r\nX-Injected: 1", "get", fx.SYSTEM_URL],
    ["boguscmd"],
  ];
  for (const argv of cases) {
    const cli = makeCli();
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
  }
});

test("get prints any object", async () => {
  const cli = makeCli();
  await run(["get", `${fx.MEETINGS_URL}?page=3`, "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal((cli.json() as { data: unknown[] }).data.length, 1);
});

test("a 404 exits 4 with the server's message", async () => {
  const cli = makeCli();
  assert.equal(await run(["get", `${fx.HOST}/oparl/nope`], cli.deps), 4);
  assert.match(cli.err.join("\n"), /HTTP 404 .*Not found/);
});

test("a 500 exits 1 with a hint about filters", async () => {
  const cli = makeCli(() => rawResponse("<!DOCTYPE html><title>500</title>", "text/html", 500));
  assert.equal(await run(["--max-retries", "0", "get", fx.SYSTEM_URL], cli.deps), 1);
  assert.match(cli.err.join("\n"), /Hint: .*server error/);
});

test("a refused cross-host link exits 1", async () => {
  const cli = makeCli((req) => (req.url === fx.BODY_URL ? jsonResponse({ ...fx.body, meeting: "https://other.example.com/m" }) : jsonResponse({})));
  assert.equal(await run(["list", "meeting", fx.BODY_URL], cli.deps), 1);
  assert.match(cli.err.join("\n"), /another host/);
});

test("a network failure exits 6 with a timeout hint", async () => {
  const cli = makeCli(() => {
    throw new OparlNetworkError("Request timed out after 120000ms");
  });
  assert.equal(await run(["get", fx.SYSTEM_URL], cli.deps), 6);
  assert.match(cli.err.join("\n"), /Raise --timeout/);
});

test("a non-OParl response exits 1", async () => {
  const cli = makeCli(() => rawResponse("<html><body>Bürgerinfo</body></html>", "text/html"));
  assert.equal(await run(["system", fx.SYSTEM_URL], cli.deps), 1);
  assert.match(cli.err.join("\n"), /HTML page/);
});

test("--output writes to a file and keeps stdout clean", async () => {
  const cli = makeCli();
  await run(["--output", "/tmp/system.json", "system", fx.SYSTEM_URL], cli.deps);
  assert.equal(cli.out.length, 0);
  assert.ok(cli.files["/tmp/system.json"]);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes/);
});

test("a --output write failure reports a clean error (exit 1)", async () => {
  const err: string[] = [];
  const mt = routes(site);
  const deps: CliDeps = {
    io: {
      out: () => {},
      err: (s) => err.push(s),
      writeFile: () => {
        throw new Error("EISDIR: illegal operation on a directory, open '/tmp'");
      },
    },
    createClient: (opts) => new OparlClient({ ...opts, transport: mt.transport }),
  };
  assert.equal(await run(["--output", "/tmp", "system", fx.SYSTEM_URL], deps), 1);
  assert.match(err.join("\n"), /Could not write to \/tmp: EISDIR/);
  assert.doesNotMatch(err.join("\n"), /Unexpected error/);
});

test("global options reach the client", async () => {
  const cli = makeCli();
  await run(["--timeout", "5000", "--user-agent", "my-agent", "system", fx.SYSTEM_URL], cli.deps);
  assert.equal(cli.mt.last().timeoutMs, 5000);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "my-agent");
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli();
  assert.equal(await run([], cli.deps), 0);
  assert.match(cli.out.join("\n"), /Usage: oparl/);
});
