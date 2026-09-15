# Usage

Use-case-driven recipes for the `oparl` CLI, which reads German council information
systems through **OParl**, their open standard API. Every municipality runs its own
server, so each recipe starts from a System or Body URL. The examples use the City of
Cologne's server; substitute any endpoint from `oparl endpoints`.

```bash
SYSTEM=https://buergerinfo.stadt-koeln.de/oparl/system
BODY=https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln
```

> Council systems differ in speed and in how completely they implement OParl. Start with
> one page (the default), and add filters one at a time.

## Install

```bash
npm i -g @maschinenlesbar.org/oparl-cli
```

This installs the `oparl` command. All examples pipe JSON to [`jq`](https://jqlang.github.io/jq/),
which is optional.

## Finding a server

### 1. Find a municipality's endpoint

```bash
oparl endpoints --search köln | jq -r '.[] | "\(.title)\t\(.working)\t\(.url)"'
```

`endpoints` lists the public registry at dev.oparl.org, followed by a curated list of
servers the registry lacks (`source` says which). `working` is the result of the last
live check (`checked`, with the reason in `problem`); for a registry entry nobody has
checked, it is the registry's own last fetch (`fetched`). A server that moved has
`replacedBy`, the new System URL. Search by place name or by a part of the URL (e.g.
`--search ratsinfomanagement`). The search ignores case, accents and umlaut spellings:
`köln`, `koln` and `koeln` find the same entries.

### 2. All working endpoints on OParl 1.1

```bash
oparl endpoints --working --oparl-version 1.1 | jq -r '.[] | "\(.title)\t\(.systemName)"'

# Only the servers the registry doesn't list (no request is made)
oparl endpoints --source curated --working | jq -r '.[] | "\(.title)\t\(.url)"'
```

Not listed at all? Any System URL works: `oparl system <url>`. Council portals often link
their OParl interface, and many vendors use fixed paths (e.g. `…/webservice/oparl/v1.1/system`
on SD.NET, `…/oparl/system` on Session).

### 3. Check an endpoint before relying on it

```bash
oparl system "$SYSTEM" | jq '{name, oparlVersion, vendor, license}'
```

A System with a `body` URL is a live OParl server. Exit `1` with "not an OParl System"
means the URL is something else — often a portal page or a moved endpoint. Exit `1` with
"is an OParl System, but its `body` is …" means the URL is right and the server does not
publish the URL of its list of bodies; `oparl get "$SYSTEM"` shows what it sends instead.

## Bodies and their lists

### 4. List the bodies on a server

```bash
oparl bodies "$SYSTEM" | jq -r '.data[] | "\(.name)\t\(.id)"'
```

Most servers host one body; regional providers host several municipalities.

### 5. See which lists a body offers

```bash
oparl get "$BODY" | jq -r 'to_entries[] | select(.value | type == "string" and test("^https?://")) | .key'
```

OParl 1.0 bodies link only `organization`, `person`, `meeting` and `paper`.

## Meetings, papers, committees

### 6. Recent papers (motions, inquiries, proposals)

```bash
oparl list paper "$BODY" --modified-since 2026-09-01 \
  | jq -r '.data[] | select(.deleted != true) | "\(.date)\t\(.reference)\t\(.paperType // "")\t\(.name)"'
```

If a server ignores `--modified-since`, you get its first page unfiltered — compare the
`modified` field. Even when it honours the filter, the list holds every paper *changed*
since the date, including old papers edited since and deleted ones (`deleted: true`, with
empty fields), which the `select` drops. For new papers only, also compare `date`.

Some servers answer a filter they cannot satisfy with an error instead of an empty list:
SD.NET RIM (Bremen, Essen and most other `…/webservice/oparl/…` endpoints) replies HTTP
**404** when no object falls into the window, so the CLI exits `4` "not found" although
the list exists. Repeat the call without the filter: if that returns data, the window was
simply empty.

### 7. Meetings, several pages at once

```bash
oparl list meeting "$BODY" --max-pages 3 | jq -r '.data[] | "\(.start)\t\(.name)"'
```

The order is the server's; some list the newest or future meetings first.

### 8. Continue where a list stopped

```bash
next=$(oparl list meeting "$BODY" | jq -r .next)
oparl get "$next" | jq -r '.data[] | .name'
```

`next` is `null` on the last page. It is also the way on when a walk gave up early: with
`looped: true` and a `note` on stderr ("stopped after page N …"), `next` still points at
the page after the last one fetched, so `oparl get "$next"` continues from there.

### 9. Committees and groups

```bash
oparl list organization "$BODY" --max-pages 0 | jq -r '.data[] | "\(.classification // "")\t\(.name)"'
```

### 10. Legislative terms

```bash
oparl list legislative-term "$BODY" | jq -r '.data[] | "\(.startDate)\t\(.name)"'
```

OParl 1.0 bodies embed their terms instead of linking a list; those come back with
`pages: 0` and the date filters applied locally. Where such a term carries no
`created`/`modified` (ALLRIS 1.0 servers omit them), it is listed anyway and a `note`
says how many terms the filter could not be applied to.

### 11. Follow a reference

Objects point to each other by URL. Open a meeting's agenda item or a paper's consultation
with `get`:

```bash
paper=$(oparl list paper "$BODY" | jq -r '.data[0].id')
oparl get "$paper" | jq '{reference, name, consultation}'
```

## Keeping a local copy in sync

Fetch everything once, then only what changed:

```bash
oparl list paper "$BODY" --max-pages 0 -o papers-full.json
oparl list paper "$BODY" --max-pages 0 --modified-since 2026-09-01T00:00:00+02:00 -o papers-delta.json
```

Deleted objects may appear with `deleted: true` — apply them to your copy as deletions.
Each object appears once per `id`, and where a page repeated it (a list that changes while
it is being walked does that), the delta holds the **last** copy the server sent, so an
object edited or deleted mid-walk is not kept stale. On large servers `--max-pages 0` can
take a long time; raise `--timeout` rather than lowering it. An empty window can come back
as exit `4` on SD.NET servers — see recipe 6.

## Global options

```bash
# A slow server: 5 minutes per request, no retries
oparl --timeout 300000 --max-retries 0 list meeting "$BODY"

# Compact JSON straight into jq
oparl --compact bodies "$SYSTEM" | jq -c '.data[]'
```

See the README for the full table and the exit codes.
