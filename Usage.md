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

`working` is the registry's last check (see `fetched`). Search by place name or by a part
of the URL (e.g. `--search ratsinfomanagement`).

### 2. All working endpoints on OParl 1.1

```bash
oparl endpoints --working --oparl-version 1.1 | jq -r '.[] | "\(.title)\t\(.systemName)"'
```

### 3. Check an endpoint before relying on it

```bash
oparl system "$SYSTEM" | jq '{name, oparlVersion, vendor, license}'
```

A System with a `body` URL is a live OParl server. Exit `1` with "not an OParl System"
means the URL is something else — often a portal page or a moved endpoint.

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
  | jq -r '.data[] | "\(.date)\t\(.reference)\t\(.paperType // "")\t\(.name)"'
```

If a server ignores `--modified-since`, you get its first page unfiltered — compare the
`modified` field.

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

`next` is `null` on the last page.

### 9. Committees and groups

```bash
oparl list organization "$BODY" --max-pages 0 | jq -r '.data[] | "\(.classification // "")\t\(.name)"'
```

### 10. Legislative terms

```bash
oparl list legislative-term "$BODY" | jq -r '.data[] | "\(.startDate)\t\(.name)"'
```

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

Deleted objects may appear with `deleted: true`. On large servers `--max-pages 0` can take
a long time; raise `--timeout` rather than lowering it.

## Global options

```bash
# A slow server: 5 minutes per request, no retries
oparl --timeout 300000 --max-retries 0 list meeting "$BODY"

# Compact JSON straight into jq
oparl --compact bodies "$SYSTEM" | jq -c '.data[]'
```

See the README for the full table and the exit codes.
