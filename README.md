# oparl-cli

[![CI](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/oparl-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/oparl-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/oparl-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/oparl-cli/de/) — command reference, guides and API docs

Read German **municipal council information** — meetings, agendas, motions, committees
and members — from your terminal. `oparl` is a command-line tool and TypeScript client
for [OParl](https://oparl.org/), the open standard API of council information systems
(*Ratsinformationssysteme*): find a municipality's endpoint, open its bodies, and walk
their meetings, papers or persons as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **One tool, many councils** — every OParl server works the same way, whether it runs
  SD.NET, Session, more! rubin or ALLRIS. `oparl endpoints` knows about 170 servers: the
  public registry plus a curated list of servers it lacks, among them Essen, Bremen,
  Karlsruhe and five Berlin district assemblies. About 150 worked at their last check.
- **No API key** — OParl access is anonymous and read-only.
- **Follows the standard's navigation** — `endpoints` → `system` → `bodies` → `list`,
  paging through `links.next` for you, or `get` any object by URL.
- **Careful with the network** — links and redirects are only followed on the server
  they came from, your filters survive a redirect, pagination loops are detected (also
  servers that serve the same page, or an empty one, over and over) and leave you a link
  to resume from, compressed answers are decoded, and slow servers get a 2-minute timeout.
- **Clean JSON output** — pretty by default, `--compact` for scripting, `-o <file>` to
  write to disk.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/oparl-cli
```

This installs the **`oparl`** command. Requires **Node.js 20+**. No API key.

Check it works:

```bash
oparl endpoints --search köln | jq -r '.[] | "\(.title)\t\(.url)"'
```

## Quickstart

```bash
# 1. Find a municipality's OParl endpoint (its System URL)
oparl endpoints --search köln | jq -r '.[].url'

# 2. List the bodies on that server — usually one per municipality
oparl bodies https://buergerinfo.stadt-koeln.de/oparl/system | jq -r '.data[] | "\(.name)\t\(.id)"'

# 3. Papers (Vorlagen, Anträge, Anfragen) changed since a date
oparl list paper https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln \
  --modified-since 2026-09-01 | jq -r '.data[] | select(.deleted != true) | "\(.date)\t\(.reference)\t\(.name)"'

# 4. The first page of meetings
oparl list meeting https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln \
  | jq -r '.data[] | "\(.start)\t\(.name)"'
```

## Commands

| Command | What it does |
| --- | --- |
| `endpoints` | Known OParl servers: the dev.oparl.org registry plus a curated list, with their last live check (`--search <text>`, `--oparl-version <v>`, `--working`, `--source <source>`) |
| `system <url>` | An endpoint's System object: OParl version, vendor, the URL of its bodies |
| `bodies <systemUrl>` | The bodies (*Körperschaften*) on a server, usually one per municipality |
| `list <type> <bodyUrl>` | One of a body's object lists, paged — see types below |
| `get <url>` | Any OParl object or list page by URL |

New to *Body*, *Paper* or *Consultation*? The **[Glossary](GLOSSARY.md)** decodes every term.

### `list` types

`organization` · `person` · `meeting` · `paper` · `agenda-item` · `consultation` · `file` ·
`membership` · `location` · `legislative-term`

OParl 1.0 bodies only link `organization`, `person`, `meeting` and `paper`; asking for
another list on such a body names what it does link. The exception is `legislative-term`:
1.0 bodies embed their terms, and `list` prints those (`pages: 0`, date filters applied
locally).

### `list` options

| Option | Meaning |
| --- | --- |
| `--max-pages <n>` | Pages to fetch along `links.next` (default `1`; `0` = all, up to 10,000 pages — a `note` says when that limit ended the walk, and a larger number goes further) |
| `--modified-since <time>` / `--modified-until <time>` | Only objects modified in that window |
| `--created-since <time>` / `--created-until <time>` | Only objects created in that window |
| `--limit <n>` | Page size hint (1..1000). On ALLRIS 1.0 servers it cuts the whole list to `n` objects with no `next` link; a `note` warns when the last page holds exactly `n` objects |
| `--omit-internal` | Ask the server to leave out embedded objects |

Times are `YYYY-MM-DD` (midnight UTC) or an ISO 8601 date-time with a time zone offset
(`2026-09-01T12:30:00+02:00`, `2026-09-01T10:30:00.123Z`, `…T12:30+0200`); they are sent in
the spec's `YYYY-MM-DDThh:mm:ss±hh:mm` form, fractional seconds dropped. The filters are
sent to the server as the OParl `modified_since`, `limit`, … parameters. **Servers don't
all honour them**: some ignore them silently, a few fail with a 400 or 500 — check the
`modified`/`created` fields when it matters.

Each filter is sent **once per request, with your value**: where the server's list URL or
its `next` link already carries that parameter, yours replaces it — on the first page, on
every following one, and again if the server redirects. Without that, a list URL such as
ALLRIS's `papers.asp?body=1&limit=100` would be asked for two page sizes at once, and a
redirect that drops the query would quietly answer the unfiltered list. Every request
also sends a literal `+` in the four date parameters as `%2B`: Somacos servers put
`modified_since=…+00:00` unencoded into their `next` links, and would read the `+` as a
space, so a raw page's `.links.next` can be passed to `oparl get` as it is.

`list` returns `{ "data": [...], "pages": n, "next": "…" }`. `next` is the link to the
following page, or `null` at the end: continue with `oparl get <next>` or a higher
`--max-pages`. Each object appears once, by `id`; where a page repeated an object, the
last copy the server sent is kept — the newer one, including a `deleted: true`
tombstone. A walk that gives up early adds `"looped": true` and a `"note"` saying why
(also printed on stderr). If a page after the first fails (a server error, a timeout),
the pages already fetched are still printed, with `next` set to the page that failed and a
`note`, and the command then reports the error and exits with its code (`1`, `4` or `6`).

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into `jq`
stays clean.

```bash
# How many working endpoints per OParl version?
oparl endpoints --working | jq -r 'group_by(.oparlVersion)[] | "\(.[0].oparlVersion): \(length)"'

# Which object lists does a body link?
oparl get https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln \
  | jq -r 'to_entries[] | select(.key | test("^(organization|person|meeting|paper|agendaItem|consultation|consultations|file|files|membership|locationList|legislativeTermList)$")) | .key'

# Continue a list from where the last call stopped
next=$(oparl list meeting "$BODY" | jq -r .next)
oparl get "$next" | jq '.data | length'
```

Use `--compact` for single-line JSON and `-o <file>` to write to a file — both are
**global options** that work before or after the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Not found (`404` from the server) — on SD.NET servers also an empty date-filter window, see Troubleshooting |
| `6` | Network / transport failure (DNS, connection, timeout, size cap, no response at all) |
| `1` | Any other error — a non-OParl response, a refused link, another HTTP status |

## Troubleshooting

- **The registry is unreachable** — dev.oparl.org is a single third-party host. When it
  cannot be read, `oparl endpoints` says so on stderr and lists only the curated servers
  that ship with this tool, as of the last live check before this release (`checked`);
  `--source curated` does the same without trying the network at all. `--source registry`
  still reports the error.
- **A listed endpoint fails** — `working`, `checked` and `problem` in `oparl endpoints`
  show the last live check; servers switch OParl off or move. Where a server moved,
  `replacedBy` gives the new System URL. A municipality that isn't listed may still have
  OParl: any System URL works with `oparl system`.
- **"unable to verify the first certificate"** (exit `6`) — the server doesn't send its
  intermediate TLS certificate (seen on Kaiserslautern). Browsers fetch the missing
  certificate themselves; Node.js doesn't. Fetch it yourself, check that it chains to a
  root your system trusts (it becomes a trusted CA for the command), and pass it in:

  ```bash
  echo | openssl s_client -connect ris.kaiserslautern.de:443 2>/dev/null \
    | openssl x509 -noout -ext authorityInfoAccess      # shows the "CA Issuers" URL
  curl -s http://certificates.starfieldtech.com/repository/sfig2.crt \
    | openssl x509 -inform DER -out intermediate.pem
  openssl verify intermediate.pem                        # must print "intermediate.pem: OK"
  NODE_EXTRA_CA_CERTS=$PWD/intermediate.pem oparl system https://ris.kaiserslautern.de/oparl/system
  ```

  Don't turn off certificate checks.
- **A note "stopped after page N"** — the walk gave up: either the server's `next` led
  back to a page already fetched, or three pages in a row added nothing new (servers that
  serve the same page, or an empty one, under ever-new `?page=n` links — seen on the
  OWL-IT server). The output holds every distinct object, `looped: true` and, where the
  server offered one, a `next` to continue from with `oparl get`.
- **Exit `4` "not found" after adding a date filter** — SD.NET RIM servers (most of the
  working endpoints, e.g. Bremen) answer a date window with no objects in it with HTTP 404
  (`Die angeforderte Ressource wurde nicht gefunden.`) instead of an empty list, and a few
  answer 400 (`Keine Adressen vorhanden`). The list is not gone: re-run without the filter
  — if that works, the window was simply empty. The CLI does not turn such a 404 into an
  empty result, because a 404 also means a wrong URL.
- **Exit `6` / "timed out"** — council systems can take a minute or more for one list
  page. Raise `--timeout <ms>` (`0` = no timeout) and keep `--max-pages` small.
- **Exit `6` / "closed the connection without sending a response"**, or "answered with
  HTTP 101 (protocol upgrade)" — something answered at that address, but not with an HTTP
  response: a proxy, or a WebSocket endpoint rather than an OParl one. Check the URL
  against `oparl endpoints`.
- **"but received an HTML page / a PDF file"** (exit `1`) — the URL answers with something
  other than OParl JSON, and the message names the content type the server sent. Council
  systems serve error and portal pages with HTTP 200, so this is what a wrong path usually
  looks like. A file URL answers with the file: `oparl` prints file metadata (`oparl get`
  on the `file` object) and does not download files.
- **Exit `1` with a 400 or 500 after adding a filter** — the server doesn't support that
  filter or `--limit`; drop it and filter the `modified` field yourself.
- **Every object is "modified today"** — some servers (seen on more! rubin) stamp
  `created`/`modified` with the current date, so date filters match everything. Use the
  objects' own dates (`date` on papers, `start` on meetings) instead.
- **"Refusing to follow … another host"** — the server handed out a link to a different
  host. The CLI only follows links on the server they came from; fetch the URL with
  `oparl get` if you trust it.
- **"is not an OParl System / Body"** — pass the System URL from `oparl endpoints` to
  `system`/`bodies`, and a Body `id` from `oparl bodies` to `list`. "…is an OParl System,
  but its `body` is …" means the URL is right and the server's System is wrong: it does
  not publish the URL of its list of bodies. `oparl get <url>` shows what it does send.

## Global options

Given **before or after** the command, e.g. `oparl --compact bodies <url>`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `120000`; `0` = none; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value (ASCII or Latin-1 — an emoji or an en dash is rejected with exit `2`) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (0..10, default `2`) |
| `--max-redirects <n>` | Redirects to follow on the same host (0..10, default `3`) |
| `--max-response-bytes <n>` | Cap response body size in bytes, decompressed size included (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — OParl objects and terms explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. Every
OParl server belongs to its municipality, and **each sets its own terms**. See
**[DATA_LICENSE.md](DATA_LICENSE.md)**.

> Check the `license` field on the System and Body objects — most servers leave it
> empty, and those that set one range from CC BY 4.0 to "use only with permission".
> Council papers are largely *amtliche Werke*, but attached documents and personal data
> in person records are not free to republish.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
