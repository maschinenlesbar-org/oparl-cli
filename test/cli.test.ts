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

test("endpoints --search ignores Unicode form, accents and umlaut spellings", async () => {
  const entry = (title: string, url: string) => ({ title, url, system: [] });
  const registry = {
    data: [
      entry("Köln", "https://ratsinformation.stadt-koeln.de/oparl/system"),
      entry("Dusseldorf", "https://ris.duesseldorf.de/oparl/system"),
      entry("Münster", "https://www.stadt-muenster.de/sessionnetbi/oparl/system"),
      entry("Gießen", "https://ris.giessen.de/oparl/system"),
    ],
    meta: {},
  };
  const titles = async (search: string) => {
    const cli = makeCli(() => jsonResponse(registry));
    assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--search", search], cli.deps), 0);
    return (cli.json() as Array<{ title: string }>).map((e) => e.title);
  };
  assert.deepEqual(await titles("Köln".normalize("NFD")), ["Köln"]);
  assert.deepEqual(await titles("koeln"), ["Köln"]);
  assert.deepEqual(await titles("düsseldorf"), ["Dusseldorf"]);
  assert.deepEqual(await titles("MUNSTER"), ["Münster"]);
  assert.deepEqual(await titles("giessen"), ["Gießen"]);
  assert.deepEqual(await titles("irgendwo"), []);
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

test("bodies prints https ids for a server that publishes http ids, so list stays on https", async () => {
  // Somacos servers (Dresden, Düsseldorf) serve https but publish http:// ids.
  const httpIds = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("https://ris.example.de", "http://ris.example.de")) as unknown;
  const cli = makeCli((req) => {
    if (req.url === fx.SYSTEM_URL) return jsonResponse(httpIds(fx.system));
    if (req.url === fx.BODIES_URL) return jsonResponse(httpIds(fx.bodyList));
    if (req.url === fx.BODY_URL) return jsonResponse(httpIds(fx.body));
    if (req.url.startsWith(fx.MEETINGS_URL)) return jsonResponse(httpIds(fx.meetingPages[1]));
    return jsonResponse({ error: "unexpected" }, 404);
  });
  await run(["bodies", fx.SYSTEM_URL], cli.deps);
  const bodyId = (cli.json() as { data: Array<{ id: string }> }).data[0]!.id;
  assert.equal(bodyId, fx.BODY_URL);

  cli.out.length = 0;
  assert.equal(await run(["list", "meeting", bodyId], cli.deps), 0);
  assert.ok(cli.mt.calls.every((c) => c.url.startsWith("https://")), cli.mt.calls.map((c) => c.url).join(" "));
  assert.match((cli.json() as { next: string }).next, /^https:\/\//);
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

test("list accepts ISO 8601 timestamps with fractional seconds", async () => {
  const cli = makeCli();
  const since = new Date(Date.UTC(2026, 8, 1, 10, 0, 0, 123)).toISOString(); // 2026-09-01T10:00:00.123Z
  assert.equal(await run(["list", "meeting", fx.BODY_URL, "--created-since", since], cli.deps), 0);
  assert.equal(queryOf(cli.mt.calls[1]!).get("created_since"), "2026-09-01T10:00:00+00:00");
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
    ["list", "meeting", fx.BODY_URL, "--modified-since", "2026-09-01T10:00:00"],
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

test("a URL with user:password never sends or prints the credentials", async () => {
  const cli = makeCli();
  const code = await run(["get", `https://user:s3cret@ris.example.de/oparl/nope`], cli.deps);
  assert.equal(code, 4);
  assert.equal(cli.mt.last().url, `${fx.HOST}/oparl/nope`);
  assert.doesNotMatch(cli.err.join("\n"), /s3cret|user:/);
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { ...fx.system, name: `Rat${controls}`, vendor: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "system", fx.SYSTEM_URL], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Rat\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(cli.json(), served);
  }
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
