# oparl-cli

[![CI](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/oparl-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/oparl-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/oparl-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/oparl-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/oparl-cli/de/) — command reference, guides and API docs

Read German **municipal council information** — meetings, agendas, motions, committees
and members — from your terminal. `oparl` is a command-line tool and TypeScript client
for [OParl](https://oparl.org/), the open standard API of council information systems
(*Ratsinformationssysteme*): find a municipality's endpoint in the public registry, open
its bodies, and walk their meetings, papers or persons as clean JSON you can pipe
straight into [`jq`](https://jqlang.github.io/jq/).

- **One tool, many councils** — every OParl server works the same way, whether it runs
  SD.NET, Session, more! rubin or ALLRIS; the registry lists about a hundred of them.
- **No API key** — OParl access is anonymous and read-only.
- **Follows the standard's navigation** — `endpoints` → `system` → `bodies` → `list`,
  paging through `links.next` for you, or `get` any object by URL.
- **Careful with the network** — links and redirects are only followed on the server
  they came from, pagination loops are detected, and slow servers get a 2-minute timeout.
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
  --modified-since 2026-09-01 | jq -r '.data[] | "\(.date)\t\(.reference)\t\(.name)"'

# 4. The first page of meetings
oparl list meeting https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln \
  | jq -r '.data[] | "\(.start)\t\(.name)"'
```

## Commands

| Command | What it does |
| --- | --- |
| `endpoints` | The public registry of OParl servers (`--search <text>`, `--oparl-version <v>`, `--working`) |
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
| `--max-pages <n>` | Pages to fetch along `links.next` (default `1`; `0` = all) |
| `--modified-since <time>` / `--modified-until <time>` | Only objects modified in that window |
| `--created-since <time>` / `--created-until <time>` | Only objects created in that window |
| `--limit <n>` | Page size hint (1..1000) |
| `--omit-internal` | Ask the server to leave out embedded objects |

Times are `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDThh:mm:ss±hh:mm`. The filters are
sent to the server as the OParl `modified_since`, `limit`, … parameters. **Servers don't
all honour them**: some ignore them silently, a few fail with a 400 or 500 — check the
`modified`/`created` fields when it matters.

`list` returns `{ "data": [...], "pages": n, "next": "…" }`. `next` is the link to the
following page, or `null` at the end: continue with `oparl get <next>` or a higher
`--max-pages`.

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into `jq`
stays clean.

```bash
# How many working endpoints per OParl version?
oparl endpoints --working | jq -r 'group_by(.oparlVersion)[] | "\(.[0].oparlVersion): \(length)"'

# Which lists does a body link?
oparl get https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln \
  | jq -r 'to_entries[] | select(.value | type == "string" and test("^https?://")) | .key'

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
| `4` | Not found (`404` from the server) |
| `6` | Network / transport failure (DNS, connection, timeout, size cap) |
| `1` | Any other error — a non-OParl response, a refused link, another HTTP status |

## Troubleshooting

- **The registry lists an endpoint that fails** — the registry is a snapshot; check
  `working` and `fetched` in `oparl endpoints`. Many entries marked `working: false`
  are gone for good.
- **Exit `6` / "timed out"** — council systems can take a minute or more for one list
  page. Raise `--timeout <ms>` (`0` = no timeout) and keep `--max-pages` small.
- **Exit `1` with a 400 or 500 after adding a filter** — the server doesn't support that
  filter or `--limit`; drop it and filter the `modified` field yourself.
- **Every object is "modified today"** — some servers (seen on more! rubin) stamp
  `created`/`modified` with the current date, so date filters match everything. Use the
  objects' own dates (`date` on papers, `start` on meetings) instead.
- **"Refusing to follow … another host"** — the server handed out a link to a different
  host. The CLI only follows links on the server they came from; fetch the URL with
  `oparl get` if you trust it.
- **"is not an OParl System / Body"** — pass the System URL from `oparl endpoints` to
  `system`/`bodies`, and a Body `id` from `oparl bodies` to `list`.

## Global options

Given **before or after** the command, e.g. `oparl --compact bodies <url>`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `120000`; `0` = none) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (0..10, default `2`) |
| `--max-redirects <n>` | Redirects to follow on the same host (0..10, default `3`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

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
