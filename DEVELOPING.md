# Developing & integrating

This document is for developers who want to use `oparl-cli` as a **TypeScript
library**, build it from source, or understand how it is put together. For command
usage, see the [README](README.md) and [Usage.md](Usage.md).

## The one thing to know: there is no API host

Most maschinenlesbar.org clients talk to one API behind a `--base-url`. OParl is a
*standard*, not a service: every municipality runs its own server, found in the
registry at `https://dev.oparl.org/api/endpoints` or in the curated list this package ships
(see [The endpoint list](#the-endpoint-list)). So the client works on **absolute URLs**
throughout:

- the user supplies a System URL (or Body / object URL);
- the servers supply every further URL — `System.body`, a Body's list URLs, the
  `links.next` of each list page.

Following server-supplied URLs is the security-relevant part. `resolveLink` in
`src/client/engine.ts` resolves every such link (and every redirect `Location`) against
the URL it came from and only follows it on the **same host and port**, upgrading
`http:` to `https:` on that host and never downgrading. A link it refuses ends the walk
with a note rather than an error, so the pages already fetched are not lost, and the
refused URL is never handed back as a continuation link. List walks also stop when a
`next` link repeats a page already fetched (compared as the URL actually requested,
filters included). OParl is anonymous, so any `user:password@`
in a URL — typed or handed out — is dropped: never sent as Basic auth, never echoed.
`OparlClient` does this itself for every URL a caller hands it (`get`, `system`, `bodies`,
`list`, `page`, `walk`, `registryUrl`): it works with `parseHttpUrl(url).href` from then on,
in the request and in its own messages, so a library caller gets the same messages as the CLI.
Credential headers a library caller sets in `defaultHeaders` go only to the origin a
request starts at: a same-origin redirect (relative or absolute `Location`) keeps them, the
http→https upgrade drops them for the rest of the chain — a 401/403 there says so and asks
for the https URL (`OparlApiError.credentialsDropped`) — and any other origin is refused
anyway. The transport is told `redirect: "manual"`; a response whose `url` shows that the
transport followed a redirect to another origin itself fails as an `OparlNetworkError`.
A URL typed without its scheme (`bob:hunter2@ris.example/oparl`) parses with the scheme
`bob:` and keeps its password in the path; `redactUrl` cuts it out by text, using
`credentialsIn`, which finds the exact userinfo of a URL-like value whether it parses or
not. The CLI goes further, because commander quotes rejected arguments raw: `run()` wraps
its output (`withRedactedOutput`) so that the exact userinfo of every argument — also in an
`--option=value` token, and in its terminal-stripped and JSON-escaped forms — is printed as
`***` on stdout and stderr. A pattern can't delimit a password holding a space, `/`, `#` or
`@`; the exact strings can. Anything else shaped `scheme://user@` on stderr is redacted by
pattern (`redactUserinfo`).

"The URL it came from" is the URL the request **ended** on: `RequestEngine.fetchJson`
returns the last redirect target alongside the decoded body (`getJson` is the same call
without it), and `client.ts` resolves `System.body`, a Body's list URLs and `links.next`
against that, as RFC 3986 §5.1.3 requires. A server that redirects `/oparl` to
`/v1/system` and hands out a relative `"body": "bodies"` otherwise sends the client to
`/bodies`. The engine also re-applies the caller's query on every redirect hop, so a
server that redirects a filtered list URL to a path without the query cannot answer the
unfiltered list unnoticed; `walk()` hands it the query for every page, not only the
first (a page-2 redirect used to lose the filters, or send the server's stale ones), and
`get()`/`page()` hand it the OParl filters the URL itself carries, so `oparl get <next>`
stays filtered too (`test/redirect-filters.test.ts`, on two local servers). One rule for all of it: `carryQuery` **sets** the caller's
parameters, replacing whatever copy the URL carried — the requested URL, a redirect
target and a `next` link alike — and leaves the server's other parameters exactly as it
wrote them (no `%20` → `+`, no `flag` → `flag=`) (`withQuery`, which appends, is no longer used for
requests; sending `limit` twice with different values let the server choose).

What we found probing real servers (September 2026) and designed around:

| Server (product) | Behaviour |
| --- | --- |
| Solingen (SD.NET RIM, 1.1) | 38 s for one page of meetings; `modified_since` answered with an HTML 503, `limit` with a 400; 404s as `{ error, code }` JSON; `http` → `https` 301 |
| Köln (Somacos Session, 1.1) | fast; filters and `limit` honoured; no totals in `pagination`; 404 as `text/plain`; `links.next` echoes `modified_since=…+00:00` unencoded, and the server reads that `+` as a space (a different page, whose own `next` drops the filter) — so the engine sends a literal `+` in the four timestamp parameters as `%2B` (`encodeTimestampPlus`), which keeps `oparl get <.links.next>` filtered |
| Düsseldorf (Somacos Session, 1.1, `ris-oparl.itk-rheinland.de`) | the Body links `consultations` and `files` instead of the spec's `consultation` and `file`; `list` falls back to those two names |
| Freiburg (more! rubin, 1.0) | `limit` ignored; `created`/`modified` stamped with the current date on every object, so date filters match everything; paths like `/page/2`; unknown paths answer 200 with the System object; only four Body lists |
| Leipzig (ALLRIS) | System answered HTTP 500 on the day |
| Essen (SD.NET RIM, 1.1) | serves a bare `[]` for its `legislativeterm` list instead of a list page, which `page()` reads as one page |
| Bremen / Essen (SD.NET RIM, 1.1) | a date window with no objects in it answers HTTP **404** (`{ error, code }`), so the CLI exits 4 although the list exists. Documented in the README, Usage, the glossaries and the council-activity skill; never translated into an empty result in code, since a 404 also means a wrong URL |
| OWL-IT (SessionNet, 1.1) | serves all 27 bodies under every `?page=n`, with an ever-new `next`: the walk's unproductive-page counter ends it after four requests |
| Berlin BVV Mitte (ALLRIS, 1.0) | embedded legislative terms without the mandatory `created`/`modified`, so a local date filter can only keep them and say so; list URLs carry a query (`papers.asp?body=1`), which is why filters replace rather than append; `limit=n` returns `n` objects and **no `next` link** (checked 2026-09-26: 3 of 17 papers), so the walk adds a `note` when a last page holds exactly `limit` objects |
| Aachen (`ratsinfo.aachen.de`) | answers some list URLs with HTTP **200** `text/html` and an error page that begins with an HTML comment — hence the body *and* `Content-Type` sniffing in `decode` |

Hence: a 120 s default timeout, filters passed through with a clear caveat, type checks on
every object (`system` must be a System, `list` needs a Body, pages need a `data` array of
objects), and exit-1 hints for 400/5xx answers — the "retry without the filters" one only
when the failing request actually carried filters or `limit`.

## Build from source

```bash
git clone https://github.com/maschinenlesbar-org/oparl-cli
cd oparl-cli
npm install
npm run build        # tsc -> dist/
npm test             # builds, then runs node --test dist/test/*.test.js
node dist/src/cli/index.js endpoints --search köln
```

## Library usage

```ts
import { OparlClient, OparlApiError, OparlLinkError } from "@maschinenlesbar.org/oparl-cli";

const client = new OparlClient();

const [cologne] = await client.endpoints({ search: "koeln", working: true });
const system = await client.system(cologne!.url);
const { data: bodies } = await client.bodies(system.id);

const papers = await client.list(bodies[0]!.id, "paper", {
  modifiedSince: "2026-09-01",
  maxPages: 2,
});
console.log(papers.data.length, papers.next);

const one = await client.get(papers.data[0]!.id);
```

### Client options

`new OparlClient(options)` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `registryUrl` | `https://dev.oparl.org/api/endpoints` | Endpoint registry used by `endpoints()`; an http(s) URL, checked by the constructor (`Invalid registryUrl: …`), with any `user:password@` dropped |
| `curatedEndpoints` | `CURATED_ENDPOINTS` | Endpoints the registry lacks, appended by `endpoints()` |
| `registryChecks` | `REGISTRY_CHECKS` | Live checks applied to registry entries by `endpoints()` |
| `timeoutMs` | `120000` | Time limit per request, covering the whole response body, not only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms, where `--timeout` rejects a larger value). Enforced by the engine for every transport |
| `maxRetries` | `2` | Retries for 429/503 (see `retryDelayMs` for the waits) and for a connection reset (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the error's `cause` chain); 0 to `MAX_RETRIES` (10). A timeout is not retried |
| `retryDelayMs` | `500` | Backoff base, 0 to 30 000: linear per attempt for a 503 or a reset; a 429 waits at least 1 s, doubling per attempt. A `Retry-After` (seconds or an HTTP date) can lengthen a wait, never shorten it — `Retry-After: 0` or a past date doesn't make a burst — and every wait is capped at 30 s |
| `maxRedirects` | `3` | 0 to `MAX_REDIRECTS` (10). Same-host redirects (301/302/303/307/308 with a `Location`) followed per request; any other 3xx is an `OparlApiError` naming the target (`redirect to … not followed`, `… (no Location header)`, and `(stopped after n redirects)` at the limit) |
| `maxResponseBytes` | 100 MiB | Response size cap (0 = unlimited), applied to the decompressed body too, and checked by the engine on the body any transport returns |
| `userAgent` | `oparl-cli` | `User-Agent` header; ASCII or Latin-1 and not blank, else an `OparlValidationError` (`Invalid userAgent: …`). Only an absent `userAgent` selects the default; `""` or whitespace is rejected, as `--user-agent` rejects it |
| `defaultHeaders` | none | Extra headers on every request. OParl is anonymous; a credential header (`Authorization`, `Proxy-Authorization`, `X-API-Key`, `Cookie`) is kept in a private field — `util.inspect`, `console.log` and `JSON.stringify` of a client don't show it — and its value is scrubbed (`***`) from error bodies, details, messages and `cause` chains that echo the request |
| `transport` | node http/https | Swap the HTTP layer (tests inject a mock); see *Custom transports* below |

The numeric options must be integers in their range — `timeoutMs` and `maxResponseBytes`
non-negative, `retryDelayMs` from 0 to 30 000, `maxRetries` and `maxRedirects` from 0 to 10. Anything
else (NaN, Infinity, a fraction, a negative number) is an `OparlValidationError` from the
constructor, such as `Invalid maxRetries: Expected an integer from 0 to 10.`; it would
otherwise silently remove the timeout, the size cap or the end of the retry and redirect
loops. The CLI's flags take the same ranges. Wrong-typed input is the same
`OparlValidationError`, never a raw `TypeError`: a timestamp filter that is not a string (a
`Date`), `omitInternal` or `working` that is not a boolean, a `userAgent` or header value
that is not a string, `defaultHeaders` that is not an object, and a `transport` or `sleep`
that is not a function.

The constructor, `list()`, `bodies()` and `endpoints()`/`endpointsReport()` reject an
options key they don't take — an unknown or misspelled one, the OParl parameter name
instead of the option (`modified_since` for `modifiedSince`), or `__proto__` from parsed
JSON — with an `OparlValidationError` (`Unknown list option "modified_since" (did you mean
modifiedSince?).`). Such a key was ignored, so the filter was never sent and the server
answered the whole list. The CLI makes a repeated single-value option a usage error.

### Methods

| Method | Returns |
| --- | --- |
| `endpoints({ source, search, oparlVersion, working })` | `RegistryEntry[]` — the registry (all pages, projected, with the live checks applied) followed by the curated list; `source` `"registry"` or `"curated"` for one of them. The filters are the CLI's `--search`, `--oparl-version` and `--working` (`filterEndpoints` in `endpoints-search.ts`): `search` matches title, URL and note ignoring case and accents, with the umlaut spellings (`koeln` → `Köln`) as a fallback; `oparlVersion` takes `1.1` or a version URI. A blank `search` or another version string is an `OparlValidationError`, before any request |
| `endpointsReport(options)` | `{ entries, registryError? }` — as `endpoints`, but with `source` `"all"` a registry that cannot be read (any `OparlError` but a validation error) is not thrown: `entries` holds the curated list alone, filtered alike, and `registryError` says why. This is what `oparl endpoints` prints, with the error as a stderr note; `endpoints()` is the same call that throws `registryError` |
| `system(url)` | `OparlSystem` — checks `type` and `body` |
| `bodies(systemUrl, { maxPages })` | `ListResult<OparlBody>` — all pages by default. `maxPages` (here and in `list` and `walk`) must be a non-negative integer, checked before any request |
| `list(bodyUrl, type, options)` | `ListResult` — one page by default; `LIST_TYPES` maps CLI names to Body fields. `type` must be one of its own keys (`isListType`), so an inherited name such as `constructor` or `__proto__` is an `OparlValidationError` (`Unknown list type …`) before any request, as the CLI's `<type>` choices reject it. `limit` must be an integer from 1 to `MAX_LIST_LIMIT` (1000), the bound `--limit` uses; anything else is an `OparlValidationError` before any request |
| `page(url, query?)` | one `OparlListPage`; every entry of `data` must be an object, and a bare JSON array is read as a single page |
| `walk(url, query?, maxPages)` | `ListResult` — follows `links.next` with the same-host rule |
| `get(url)` | any object; rejects arrays and `{ error }` objects |

`ListResult` is `{ data, pages, next }`, plus `looped: true` when the walk gave up before the
end of the list, and an optional `note` (one sentence for the user, which the CLI prints on
stderr) saying why. It gives up when a `next` link leads back to a page already fetched, or
when `MAX_UNPRODUCTIVE_PAGES` (3) pages in a row add no object that wasn't already listed —
the same page, or an empty one, under ever-new `?page=n` links. Two such pages are tolerated,
because an insertion into the list during a walk looks exactly like a repeat. `maxPages: 0`
fetches at most `MAX_PAGES_HARD_LIMIT` (10,000) pages, in case a server's `next` links never
end; a walk that stops there adds a `note` (not `looped`). `next` is
whatever the last page fetched offered, so a walk that gave up on unproductive pages can be
resumed by hand — except after a `next` leading back to a page already fetched, where it is
`null` (following it would only go round the loop again); a
`next` the same-host rule refuses — or a redirect it refuses on page 2 or later — ends the
walk with a `note` and keeps the pages already fetched. Any other failure after the first
page (an HTTP error, a timeout, a page that is not a list) is thrown as it is, but carries
the walk so far in `err.partial` (`OparlError.partial`: the objects of the pages fetched,
`next` = the page that failed, and a `note`); the CLI prints that result and then reports
the error with its usual exit code. Objects are listed once per `id` across pages, keeping the **last** copy sent, since
that is the newer one (an object edited mid-walk, or the spec's `deleted: true` tombstone).
`normalizeTimestamp` writes every accepted input in
the form the spec uses, `YYYY-MM-DDThh:mm:ss±hh:mm`: `YYYY-MM-DD` becomes midnight UTC, `Z`
becomes `+00:00`, `±hhmm`/`±hh` offsets get their colon, missing seconds become `:00` and
fractional seconds are dropped. A date-time without an offset is rejected.

## Architecture

```
src/
  client/
    types.ts     # OParl object, list page, registry entry types (open records)
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # absolute-URL GETs, retries, same-host redirects, gzip/deflate/br
                 # decoding, JSON decoding, resolveLink (the same-host rule),
                 # sanitizeServerText, error mapping
    errors.ts    # OparlError / OparlApiError / OparlNetworkError / OparlParseError /
                 # OparlValidationError / OparlLinkError
    validate.ts  # Problem rules + assertValid (input checks before any request)
    client.ts    # OparlClient — endpoints, System, bodies, lists, get
    endpoints-search.ts  # endpoints() filters: accent/umlaut search, OParl version, working
    endpoints-list.ts  # the curated endpoint list (generated, see below)
    index.ts
  cli/
    io.ts        # injectable I/O seam (CliDeps / CliIO)
    shared.ts    # option parsers (URLs, timestamps), global options, JSON rendering
    commands/oparl.ts
    program.ts   # assembles the commander program
    run.ts       # argv -> exit code (no process.exit; testable)
    index.ts     # bin shim
  index.ts       # library entry
```

Zero runtime HTTP dependencies: built on `node:http`/`https`; the CLI's only runtime
dependency is `commander`.

### Error types

| Error | Raised when | CLI exit |
| --- | --- | --- |
| `OparlValidationError` | bad URL, timestamp, header value or option before any request | 2 |
| `OparlApiError` | non-2xx status, or a redirect not followed (`location` names its target) | 4 for 404, else 1 |
| `OparlNetworkError` | DNS, connection, timeout, size cap, a request that ends without a response | 6 |
| `OparlParseError` | not JSON (an HTML page, a PDF, a content coding it cannot decode), wrong object type, `{ error }` object | 1 |
| `OparlLinkError` | a link or redirect to another host/port, or a non-http link | 1 |

**The library owns the input rules.** Every check on what a request may contain lives in
`src/client` and runs before any request, so a library caller and a CLI user get the same
answer for the same input. A rule is a pure, exported `…Problem(value)` function (in
`validate.ts` or next to the parameter it checks) returning the reason a value is invalid
or `undefined`; `assertValid(name, value, problem)` throws an `OparlValidationError`
reading `Invalid <name>: <reason>` (a method that returns a promise rejects with it). The
CLI's commander parsers call the same functions and turn the reason into a usage error, and
`run.ts` maps an `OparlValidationError` raised in an action to exit 2 (`Error: <message>`).

Server text that reaches an error message goes through `sanitizeServerText`: control
characters are dropped, whitespace (newlines and the Unicode line separators included) is
collapsed to single spaces, and the result is cut to 200 characters. A hostile or
man-in-the-middled endpoint would otherwise drive ANSI/OSC escape sequences into the
terminal, print an `Error:` line of its own next to the CLI's, or bury the diagnostic
under kilobytes of its own text. It applies to every server-derived string, the object
`type` of the type checks and a response's `Content-Type` included; the JSON output
escapes the same characters instead (`escapeControlChars`). Messages also quote the
user's own arguments as typed (`<url> is not an OParl System`), and the documented
workflows feed server data into those (`oparl get "$(jq -r .data[0].id)"`), so the CLI
additionally drops terminal control characters from everything it writes to stderr
(`stripTerminalControls`, applied in `run.ts` next to the userinfo redaction). JSON deeper than 256
levels is rejected before it can blow the stack.

A non-JSON body is named by what it is — an HTML page (sniffed in the first 200
characters *and* by `Content-Type`, since Aachen's error page starts with an HTML comment
and Apache's with an XML declaration), an XML document or a PDF — and a body that starts
like JSON is reported as broken JSON whatever the server declared. A body is decoded by the
charset its `Content-Type` declares (UTF-8 when none; a byte order mark is dropped): JSON is
UTF-8 by RFC 8259, but a server that declares `ISO-8859-1` and sends Latin-1 would otherwise
have every umlaut turned into U+FFFD without a word. An unknown charset is an
`OparlParseError`. JSON under a
`text/html` content type is still accepted: several servers send it that way. A
`Content-Encoding` of gzip, x-gzip, deflate (with or without the zlib wrapper) or br is
decoded with `node:zlib`; no `Accept-Encoding` is sent, but RFC 9110 §12.5.3 lets a
server compress anyway.

**Custom transports.** The engine holds the transport to the documented limits itself, so a
`fetch` or `node:http` transport gets the same guarantees as the built-in one. It runs every
call under the `timeoutMs` deadline and passes an `AbortSignal` (`HttpRequest.signal`) that
fires then; the call rejects at the deadline whether the transport stops or not. It checks
`maxResponseBytes` on the body it gets back. It accepts the body as a Buffer, any
`ArrayBuffer` view (fetch's `Uint8Array`, from any realm) or an `ArrayBuffer`, and the
headers as a plain record in any case, a `Headers` object or a `Map` — `Location` and
`Retry-After` are found in all of them. A response without an integer status from 100 to
599, without a headers object or without a byte-array body is an `OparlNetworkError`, never
data; so is whatever the transport throws (a string, fetch's `TypeError`, an `AbortError`),
with the original as `cause`.

The transport rejects a request that ends without a response — a server answering
HTTP 101 (`upgrade`), a socket closed after the headers — instead of leaving the promise
pending: with `timeoutMs` 0 nothing else would ever settle it, and the CLI exited 0 with
no output at all. Header values Node refuses (a `--user-agent` outside ASCII/Latin-1, a
control character, a name that is not a token) are rejected by the engine as an
`OparlValidationError`, and the transport's synchronous `request()` throw is wrapped as
well, so neither reaches the caller as an internal fault. The rules are exported —
`headerValueProblem`/`assertHeaderValue` for header values, `userAgentProblem` for the
User-Agent (that rule plus no blank value), `parseHttpUrl` for URLs (blank, malformed, not
http(s)) — and the CLI's `--user-agent` and URL parsers call them, so the CLI rejects the
same values with the library's words, at parse time.

## The endpoint list

The registry at dev.oparl.org is fed by
[OParl/resources](https://github.com/OParl/resources/blob/main/endpoints.yml) and is rarely
updated: in September 2026 it had 127 entries (3 duplicates), 103 of them working, while
many working servers weren't listed at all. So the package ships
`src/client/endpoints-list.ts`:

- `CURATED_ENDPOINTS` — servers the registry lacks, each with the result of its last live
  check (`working`, `checked`, `problem`) and the System's version, vendor and body count;
- `REGISTRY_CHECKS` — the same check for every registry entry, with the version, name,
  vendor and body count the check read from its System (the registry's own cached copy of
  them is rarely refreshed, and missing for some endpoints), plus `replacedBy` (the new
  URL of a server that moved) and `note`.

`endpoints()` applies the checks to the registry entries and appends the curated ones,
leaving out any System listed twice (compared by `endpointKey`: scheme, host, port, path
and query, ignoring host case and a trailing slash). The scheme is part of the key because
the registry lists a few councils under both `http://` and `https://`, and those two don't
always answer alike. Where both lists hold a System — the registry can catch up with a
curated server — it is listed once, under the registry's entry, reporting whichever of the
two live checks is newer.

**Refreshing it.** `npm run check-endpoints` builds, then runs `scripts/check-endpoints.mjs`.
The script checks every registry and curated endpoint live: an endpoint works when its
System and the first 20 pages of its bodies list load. It then rewrites the file. `title`,
`url`, `note` and `replacedBy` are kept as written, and `working`, `checked` and `problem`
always come from the run; the System's version, name, vendor and body count are refreshed
by a check that reached the System and keep their last known values when a check fails, so
an endpoint that is down still shows what it last served. A failing endpoint is checked a
second time after a short pause, so that one timeout doesn't record a healthy server as
down — the list ships to every user. It takes a few minutes, since some servers need 40
seconds for a page. The lists it starts from are read
from `src/client/endpoints-list.ts` itself, not from `dist/`, so a hand-added entry is
checked and kept (keep such an edit in the same plain JSON as the rest of the file).
Options: `--dry-run` (report only), `--concurrency <n>` (default 4), `--timeout <ms>`
(default 60000), `--only registry|curated`, `--allow-shrink` (write even when the registry
answers with far fewer endpoints than are on record — without it, such an answer aborts the
run rather than deleting the checks and notes of the missing ones). An unknown or mistyped
option is a usage error, so a slip like `--dryrun` cannot rewrite the file.
Run it before a release and commit the result; it also reports entries that changed state.
A curated entry the registry has caught up with is folded into `REGISTRY_CHECKS` (keeping
its `note`, and its check where that is the newer one) and dropped from
`CURATED_ENDPOINTS`, so that the file keeps one record per System.

**Adding a server.** Verify it first (`oparl system <url>` and `oparl bodies <url>`). Then
append an object to `CURATED_ENDPOINTS` with `title` (the council's official name), `url`
(the System URL) and, if useful, a `note`. Set the other fields to `null`/`false` and
`checked` to today, and run the script. When a registry entry moved, set its `replacedBy`
in `REGISTRY_CHECKS` to the new URL, which must be an endpoint this package knows — a
curated entry or another registry entry (the test `the shipped curated list is consistent`
checks this). Good places to look for servers:
[mandari's source list](https://github.com/mandariOSS/mandari/blob/main/ingestor/src/sources.py),
the CKAN portals of GovData, Open.NRW and daten.berlin.de (search "oparl"), and the council
portal of the municipality itself.

## Testing

```bash
npm test
node --test dist/test/client.test.js   # one file, after a build
```

The suite runs in-process on Node's test runner with a mock `Transport`
(`test/helpers.ts`, `routes()` serves fixtures by URL); `test/http.test.ts` exercises the
real transport against a loopback server. `parity()` in `test/helpers.ts` drives one input
through `run()` and through a library call on the same recording transport, so a test can
assert both reject without a request or both send the same requests. Fixtures in `test/fixtures.ts` are shaped after
real 1.1 and 1.0 servers and the registry, moved to example hosts.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — typecheck, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: test, `npm pack`, CycloneDX SBOMs, a changelog, and a
  GitHub Release.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no
  stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/oparl-cli/> in English and
<https://maschinenlesbar-org.github.io/oparl-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/oparl-cli/
```

## License

Dual-licensed AGPL-3.0-or-later OR commercial — see [LICENSING.md](LICENSING.md).
