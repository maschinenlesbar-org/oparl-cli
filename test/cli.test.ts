import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { OparlClient } from "../src/client/client.js";
import { CURATED_ENDPOINTS, REGISTRY_CHECKS } from "../src/client/endpoints-list.js";
import { OparlNetworkError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import type { CuratedEndpoint, RegistryCheck } from "../src/client/types.js";
import { hasControlChar, hostileText, jsonResponse, makeMockTransport, queryOf, rawResponse, routes } from "./helpers.js";
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

function makeCli(
  responder?: (req: HttpRequest) => HttpResponse,
  lists: { curatedEndpoints?: CuratedEndpoint[]; registryChecks?: RegistryCheck[] } = {},
) {
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
    createClient: (opts) =>
      new OparlClient({
        curatedEndpoints: lists.curatedEndpoints ?? [],
        registryChecks: lists.registryChecks ?? [],
        ...opts,
        transport: mt.transport,
      }),
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

test("endpoints --oparl-version takes the short form or a version URI, and rejects the rest", async () => {
  const uri = makeCli();
  assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--oparl-version", "https://schema.oparl.org/1.0/"], uri.deps), 0);
  assert.deepEqual((uri.json() as Array<{ title: string }>).map((e) => e.title), ["Gemeinde Musterdorf"]);

  const padded = makeCli();
  assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--oparl-version", " 1.1 "], padded.deps), 0);
  assert.deepEqual((padded.json() as Array<{ title: string }>).map((e) => e.title), ["Stadt Beispiel"]);

  // These used to return an empty list and exit 0, which reads as "no such servers".
  for (const bad of ["1", "v1.1", "1.0.0", "https://schema.oparl.org/", "eins"]) {
    const cli = makeCli();
    assert.equal(await run(["endpoints", "--oparl-version", bad], cli.deps), 2, bad);
    assert.match(cli.err.join("\n"), /Expected an OParl version/, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
  }
});

test("the curated servers the README advertises are found by their place name", async () => {
  // "Bremische Bürgerschaft" was in the list and working, but no `--search bremen`
  // could match it: the place name was in the note, which the search does not read.
  const found = async (search: string) => {
    const cli = makeCli(undefined, { curatedEndpoints: [...CURATED_ENDPOINTS] });
    assert.equal(await run(["endpoints", "--source", "curated", "--search", search], cli.deps), 0);
    return (cli.json() as Array<{ title: string }>).map((e) => e.title);
  };
  assert.deepEqual(await found("bremen"), ["Bremische Bürgerschaft (Bremen)"]);
  for (const place of ["essen", "karlsruhe", "köln", "berlin"]) {
    assert.ok((await found(place)).length > 0, place);
  }
});

test("endpoints --search ignores Unicode form, accents and umlaut spellings", async () => {
  const entry = (title: string, url: string) => ({ title, url, system: [] });
  const registry = {
    data: [
      entry("Köln", "https://ratsinformation.stadt-koeln.de/oparl/system"),
      entry("Dusseldorf", "https://ris.duesseldorf.de/oparl/system"),
      entry("Münster", "https://www.stadt-muenster.de/sessionnetbi/oparl/system"),
      entry("Gießen", "https://ris.giessen.de/oparl/system"),
      entry("Aue", "https://aue.ratsinfomanagement.net/oparl/system"),
      entry("Bad Aibling", "https://aibling.example.org/oparl/system"),
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
  assert.deepEqual(await titles("duesseldorf"), ["Dusseldorf"]);
  assert.deepEqual(await titles("irgendwo"), []);
});

test("endpoints --search does not collapse ordinary vowel pairs", async () => {
  // The umlaut pass ("koeln" finds "Köln") must not turn "ae"/"aue" into "a"/"au",
  // which used to match almost every entry.
  const entry = (title: string, url: string) => ({ title, url, system: [] });
  const registry = {
    data: [
      entry("Köln", "https://ratsinformation.stadt-koeln.de/oparl/system"),
      entry("Aue", "https://aue.ratsinfomanagement.net/oparl/system"),
      entry("Bad Aibling", "https://aibling.example.org/oparl/system"),
      entry("Gemeinde Ahaus", "https://ahaus.example.org/oparl/system"),
    ],
    meta: {},
  };
  const titles = async (search: string) => {
    const cli = makeCli(() => jsonResponse(registry));
    assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--search", search], cli.deps), 0);
    return (cli.json() as Array<{ title: string }>).map((e) => e.title);
  };
  assert.deepEqual(await titles("ae"), [], "a two-letter term must not reach the umlaut pass");
  assert.deepEqual(await titles("Aue"), ["Aue"], "a literal hit wins over the umlaut pass");
  assert.deepEqual(await titles("ahaus"), ["Gemeinde Ahaus"]);
  assert.deepEqual(await titles("koeln"), ["Köln"], "the umlaut pass still works");
});

test("a URL argument's credentials are not echoed in a parse error", async () => {
  const cli = makeCli();
  assert.equal(await run(["get", "ftp://user:hunter2@example.org/x"], cli.deps), 2);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /hunter2/, err);
  assert.match(err, /<redacted>@/);
});

test("-o with an empty name is a usage error, not stdout", async () => {
  const cli = makeCli();
  assert.equal(await run(["system", fx.SYSTEM_URL, "-o", ""], cli.deps), 2);
  assert.equal(cli.out.join(""), "");
});

test("endpoints --source and --working use the curated list and the live checks", async () => {
  const lists = {
    curatedEndpoints: [
      { title: "Stadt Neu", url: "https://ris.neu.example/oparl/system", working: true, checked: "2026-09-16", problem: null, oparlVersion: "1.1", systemName: null, vendor: null, bodyCount: 1, note: null },
      { title: "Stadt Kaputt", url: "https://ris.kaputt.example/oparl/system", working: false, checked: "2026-09-16", problem: "HTTP 500", oparlVersion: null, systemName: null, vendor: null, bodyCount: null, note: null },
    ],
    registryChecks: [
      { url: fx.SYSTEM_URL, working: false, checked: "2026-09-16", problem: "HTTP 404", replacedBy: "https://ris.neu.example/oparl/system", note: null },
    ],
  };
  const titles = async (args: string[]) => {
    const cli = makeCli(undefined, lists);
    assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, ...args], cli.deps), 0);
    return { titles: (cli.json() as Array<{ title: string }>).map((e) => e.title), calls: cli.mt.calls.length };
  };
  assert.deepEqual((await titles([])).titles, ["Stadt Beispiel", "Amt Irgendwo", "Gemeinde Musterdorf", "Stadt Neu", "Stadt Kaputt"]);
  assert.deepEqual(await titles(["--source", "curated"]), { titles: ["Stadt Neu", "Stadt Kaputt"], calls: 0 });
  assert.deepEqual((await titles(["--source", "registry"])).titles, ["Stadt Beispiel", "Amt Irgendwo", "Gemeinde Musterdorf"]);
  // The live check overrides the registry's own flag: Stadt Beispiel is out, Musterdorf stays.
  assert.deepEqual((await titles(["--working"])).titles, ["Gemeinde Musterdorf", "Stadt Neu"]);

  const bad = makeCli(undefined, lists);
  assert.equal(await run(["endpoints", "--source", "everything"], bad.deps), 2);
});

test("bodies notes on stderr when the server's pages repeat, and hands back a next link", async () => {
  const repeating = (req: HttpRequest) => {
    if (req.url === fx.SYSTEM_URL) return jsonResponse(fx.system);
    const n = Number(new URL(req.url).searchParams.get("page") ?? "1");
    return jsonResponse({ data: fx.bodyList.data, links: { next: `${fx.BODIES_URL}?page=${n + 1}` } });
  };
  const cli = makeCli(repeating);
  assert.equal(await run(["bodies", fx.SYSTEM_URL], cli.deps), 0);
  const result = cli.json() as { data: unknown[]; pages: number; next: string | null; looped?: boolean };
  assert.deepEqual(
    { n: result.data.length, pages: result.pages, next: result.next, looped: result.looped },
    { n: fx.bodyList.data.length, pages: 4, next: `${fx.BODIES_URL}?page=5`, looped: true },
  );
  assert.match(cli.err.join("\n"), /Note: stopped after page 4: the last 3 pages added no object/);
});

test("endpoints falls back to the curated list when the registry is unreachable", async () => {
  const lists = {
    curatedEndpoints: [
      { title: "Stadt Neu", url: "https://ris.neu.example/oparl/system", working: true, checked: "2026-09-16", problem: null, oparlVersion: "1.1", systemName: null, vendor: null, bodyCount: 1, note: null },
    ],
  };
  const dead = () => {
    throw new OparlNetworkError("connect ECONNREFUSED 127.0.0.1:1");
  };
  const cli = makeCli(dead, lists);
  assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--search", "neu"], cli.deps), 0);
  assert.deepEqual((cli.json() as Array<{ title: string }>).map((e) => e.title), ["Stadt Neu"]);
  assert.match(cli.err.join("\n"), /registry at https:\/\/registry\.example\.org\/api\/endpoints could not be read/);
  assert.match(cli.err.join("\n"), /curated endpoints that ship with this tool/);

  // --source registry has nothing else to show, so it still reports the failure.
  const registryOnly = makeCli(dead, lists);
  assert.equal(await run(["endpoints", "--registry-url", fx.REGISTRY_URL, "--source", "registry"], registryOnly.deps), 6);
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

test("list prints the pages fetched when a later page fails, and still exits with the error", async () => {
  const cli = makeCli((req) => {
    if (req.url === fx.BODY_URL) return jsonResponse(fx.body);
    if (req.url === fx.MEETINGS_URL) return jsonResponse(fx.meetingPages[1]);
    return jsonResponse({ error: "boom" }, 500);
  });
  assert.equal(await run(["--compact", "list", "meeting", fx.BODY_URL, "--max-pages", "0"], cli.deps), 1);
  const result = cli.json() as { data: Array<{ id: string }>; pages: number; next: string; note: string };
  assert.deepEqual(
    { ids: result.data.map((m) => m.id), pages: result.pages, next: result.next },
    { ids: fx.meetingPages[1].data.map((m) => m.id), pages: 1, next: `${fx.MEETINGS_URL}?page=2` },
  );
  assert.match(cli.err[0] ?? "", /^Note: stopped after page 1 because page 2 failed/);
  assert.match(cli.err[1] ?? "", /^Error: HTTP 500 for GET .*\?page=2: boom$/);
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
    ["--timeout", "3000000000", "get", fx.SYSTEM_URL],
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

test("a 500 exits 1 with a hint about filters only when the request carried some", async () => {
  const fail = (status: number) => () => rawResponse("<!DOCTYPE html><title>error</title>", "text/html", status);

  // `get` and `system` take neither filters nor --limit, so the filter advice is wrong there.
  for (const argv of [["get", fx.SYSTEM_URL], ["system", fx.SYSTEM_URL]]) {
    const cli = makeCli(fail(500));
    assert.equal(await run(["--max-retries", "0", ...argv], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Hint: .*server error\. Try again later/);
    assert.doesNotMatch(cli.err.join("\n"), /--limit/);

    const bad = makeCli(fail(400));
    assert.equal(await run(["--max-retries", "0", ...argv], bad.deps), 1);
    assert.doesNotMatch(bad.err.join("\n"), /Hint:/);
  }

  for (const status of [500, 400]) {
    const cli = makeCli((req) => (req.url === fx.BODY_URL ? jsonResponse(fx.body) : fail(status)()));
    assert.equal(await run(["--max-retries", "0", "list", "meeting", fx.BODY_URL, "--modified-since", "2026-09-01"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Hint: .*--limit or the date filters|Hint: .*fail on filters or --limit/);
  }
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

test("no server string reaches stdout or stderr as a terminal escape", async () => {
  // Whatever the server puts in a field, neither stream may carry an escape byte: the
  // JSON output escapes them, messages are sanitised.
  const hostile = hostileText("/NotASystem");
  const served = { id: fx.SYSTEM_URL, type: hostile, name: hostile, body: hostile };
  for (const argv of [
    ["system", fx.SYSTEM_URL],
    ["get", fx.SYSTEM_URL],
    ["list", "meeting", fx.SYSTEM_URL],
    ["bodies", fx.SYSTEM_URL],
  ]) {
    const cli = makeCli(() => jsonResponse(served));
    await run(argv, cli.deps);
    for (const [stream, lines] of [["stdout", cli.out], ["stderr", cli.err]] as const) {
      const text = lines.join("\n");
      assert.ok(!hasControlChar(text.replace(/\n/g, "")), `${stream} of ${argv.join(" ")}: ${JSON.stringify(text)}`);
    }
    // And no message runs over more than the line the CLI printed it on.
    assert.ok(cli.err.every((line) => !line.includes("\n")), cli.err.join("|"));
  }
});

test("a --user-agent outside Latin-1 is a usage error (exit 2)", async () => {
  // Node refuses these header values; the throw came out of the transport as
  // "Unexpected error" with exit 1, the code for an internal fault.
  for (const userAgent of ["bot \u{1f680}", "oparl-cli/a–b"]) {
    const cli = makeCli();
    assert.equal(await run(["--user-agent", userAgent, "system", fx.SYSTEM_URL], cli.deps), 2, userAgent);
    assert.match(cli.err.join("\n"), /cannot be sent in an HTTP header/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    assert.equal(cli.mt.calls.length, 0);
  }
  const ok = makeCli();
  assert.equal(await run(["--user-agent", "oparl-cli/Köln (kontakt@example.de)", "system", fx.SYSTEM_URL], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "oparl-cli/Köln (kontakt@example.de)");
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

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli();
  assert.equal(await run(["--timeout", "2147483647", "system", fx.SYSTEM_URL], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli();
  assert.equal(await run(["--timeout", "2147483648", "system", fx.SYSTEM_URL], over.deps), 2);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli();
  assert.equal(await run([], cli.deps), 0);
  assert.match(cli.out.join("\n"), /Usage: oparl/);
});

test("control characters in a URL argument never reach stderr", async () => {
  // `oparl system "$(jq -r .data[0].id)"`: jq -r decodes a hostile id's \u001b, and the
  // "is not an OParl System/Body" errors quote the argument as typed.
  const esc = String.fromCharCode(0x1b);
  const hostile = `?x=${esc}]0;pwned${String.fromCharCode(0x07)}${esc}[31mRED${String.fromCharCode(0x9b)}2J`;
  for (const argv of [
    ["system", `${fx.BODY_URL}${hostile}`],
    ["list", "meeting", `${fx.SYSTEM_URL}${hostile}`],
  ]) {
    const cli = makeCli();
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    const stderr = cli.err.join("\n");
    assert.match(stderr, /is not an OParl (System|Body)/);
    assert.ok(!hasControlChar(stderr.replaceAll("\n", " ")), JSON.stringify(stderr));
    assert.match(stderr, /\]0;pwned\[31mRED2J/);
  }
});

test("the --max-redirects hint only follows a redirect the limit stopped", async () => {
  const noLocation = makeCli(() => ({ status: 301, headers: {}, body: Buffer.alloc(0) }));
  assert.equal(await run(["get", fx.SYSTEM_URL], noLocation.deps), 1);
  assert.deepEqual(noLocation.err, [`Error: HTTP 301 for GET ${fx.SYSTEM_URL}: redirect not followed (no Location header)`]);

  let n = 0;
  const loop = makeCli(() => ({ status: 302, headers: { location: `/hop/${(n += 1)}` }, body: Buffer.alloc(0) }));
  assert.equal(await run(["get", fx.SYSTEM_URL], loop.deps), 1);
  assert.match(loop.err[0] ?? "", /: redirect to https:\/\/ris\.example\.de\/hop\/4 not followed \(stopped after 3 redirects\)$/);
  assert.match(loop.err[1] ?? "", /^Hint: the server redirected more often than --max-redirects allows/);
});

test("endpoints --search finds the municipalities the shipped note names on a shared server", async () => {
  // ris-oparl.itk-rheinland.de hosts five bodies under the title "Landeshauptstadt
  // Dusseldorf"; the search sees title, URL and note only, so the note names the others.
  const url = "https://ris-oparl.itk-rheinland.de/Oparl/system";
  const check = REGISTRY_CHECKS.find((c) => c.url === url);
  assert.ok(check, "the shipped checks hold the ITK Rheinland server");
  const registry = { data: [{ title: "Landeshauptstadt Dusseldorf", url }], meta: {} };
  for (const term of ["Mönchengladbach", "moenchengladbach", "Neuss", "Grevenbroich", "Rheinkreis", "Rhein-Kreis"]) {
    const cli = makeCli(() => jsonResponse(registry), { registryChecks: [check] });
    assert.equal(await run(["--compact", "endpoints", "--search", term, "--registry-url", fx.REGISTRY_URL], cli.deps), 0);
    assert.deepEqual((cli.json() as Array<{ url: string }>).map((e) => e.url), [url], term);
  }
});

test("list rejects an inverted date window as a usage error", async () => {
  const cli = makeCli();
  assert.equal(
    await run(["list", "paper", fx.BODY_URL, "--modified-since", "2026-09-10", "--modified-until", "2026-09-01"], cli.deps),
    2,
  );
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err[0] ?? "", /^Error: The modified window is empty: modified_since \(2026-09-10T00:00:00\+00:00\) is after/);
});

test("a blank --user-agent is a usage error, not silently replaced", async () => {
  for (const ua of ["", "   "]) {
    const cli = makeCli();
    assert.equal(await run(["--user-agent", ua, "get", fx.SYSTEM_URL], cli.deps), 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Expected a non-empty value\./);
  }
});
