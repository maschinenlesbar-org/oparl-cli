---
name: oparl-council-activity
description: >
  Follow what a German city or municipal council is doing — recent papers (Vorlagen,
  Anträge, Anfragen), upcoming or past meetings, committees and legislative terms — from
  its OParl council information system, using the oparl CLI. Trigger when the user asks
  "what did the Cologne council publish this week?", "which motions were filed in Münster
  since September?", "when does the Bezirksvertretung meet next?", "list the committees
  of the city council", "find papers about the Theatergebäude", or wants a digest of a
  council's recent activity. Walks OParl lists page by page with date filters, checks
  whether the server honoured them, and cites paper references.
compatibility: >
  Requires the `oparl` CLI (npm package @maschinenlesbar.org/oparl-cli) on PATH,
  installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to the municipal OParl servers being queried.
---

# OParl Council Activity

Reads a council's meetings, papers and committees through OParl. It needs a **Body URL**;
if the user names a place instead, run the `oparl-endpoint-finder` skill first.

## Tooling

This skill drives the `oparl` command. **Before anything else, validate it is available** — run `command -v oparl` (or `oparl --version`). If it is not on your PATH, STOP and inform the user that the `oparl` CLI (`@maschinenlesbar.org/oparl-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

OParl is read-only and needs **no key/account/config**. Pass `--compact` when piping to `jq`. Data licenses differ per server — see Traps.

## Commands

```bash
oparl list paper <bodyUrl> [--modified-since YYYY-MM-DD] [--max-pages n]
oparl list meeting <bodyUrl> [--max-pages n]
oparl list organization <bodyUrl> [--max-pages 0]
oparl list legislative-term <bodyUrl>
oparl get <url>            # any object, or the `next` page of a list
```

`list` returns `{ data, pages, next }`: `data` the objects (once per `id`, the newest copy
the server sent), `next` the link to continue (`null` at the end). A walk that gave up adds
`looped: true` and a `note` — see Traps. Default is **one page** — keep it small first;
some servers need a minute per page.

## Recipes

```bash
# Papers changed since the cut-off (not only new ones): date, reference, type, title
oparl list paper "$BODY" --modified-since 2026-09-01 --compact \
  | jq -r '.data[] | select(.deleted != true) | [.date // "", .reference // "", .paperType // "", .name] | @tsv'

# New papers only: a paper date on or after the cut-off — and those without a date
oparl list paper "$BODY" --modified-since 2026-09-01 --compact \
  | jq -r '.data[] | select(.deleted != true and ((.date // .created // "") >= "2026-09-01" or .date == null))
      | [.date // "(no date)", .reference // "", .name] | @tsv'

# Did the server honour the filter? Count objects modified before the cut-off
oparl list paper "$BODY" --modified-since 2026-09-01 --compact \
  | jq '[.data[] | select(.modified < "2026-09-01")] | length'

# Meetings on the first pages, with dates
oparl list meeting "$BODY" --max-pages 2 --compact | jq -r '.data[] | [.start // "", .name] | @tsv'

# Meetings from today on, on those pages, soonest first, plus the link to continue
oparl list meeting "$BODY" --max-pages 2 --compact \
  | jq -r --arg today "$(date +%F)" \
      '([.data[] | select(.deleted != true and (.start // "") >= $today)] | sort_by(.start)[] | [.start, .name] | @tsv), "next: \(.next)"'

# Committees and groups
oparl list organization "$BODY" --max-pages 0 --compact \
  | jq -r '.data[] | [.classification // "", .name] | @tsv'

# Search paper titles client-side across a few pages
oparl list paper "$BODY" --max-pages 5 --compact \
  | jq -r --arg q "theater" '.data[] | select(.name | ascii_downcase | contains($q)) | [.reference, .name] | @tsv'

# Details of one paper (consultations, files)
oparl get "<paper id>" --compact | jq '{reference, name, paperType, date, consultation, mainFile}'
```

## Traps

- **Not every paper has a `date`.** On ALLRIS 1.0 servers (the Berlin BVVs) `date` is
  absent on most papers, so a "new since" filter on `date` alone answers zero although the
  server returned papers. Fall back to `created`, and report papers without a date rather
  than dropping them.
- **Filters may be ignored.** Some servers return everything despite `--modified-since`;
  others fail with exit `1` and a 400/500 hint. Check `modified` against the cut-off
  (recipe 3) and say which happened. On a failure, retry without the filter and filter
  with `jq`.
- **Exit `4` after a date filter is usually an empty window, not a missing list.** SD.NET
  RIM servers (most `…/webservice/oparl/…` endpoints, e.g. Bremen and Essen) answer a
  window with no objects in it with HTTP 404 ("Die angeforderte Ressource wurde nicht
  gefunden."), a few with 400 ("Keine Adressen vorhanden"). Repeat the same call without
  the filter: if that returns data, report "no changes in that window", not "the list
  does not exist". Only if the unfiltered call also fails is the list really unavailable.
- **Some timestamps are fake.** more! rubin servers (e.g. Freiburg, OParl 1.0) stamp every
  object's `created` and `modified` with the current date, so a date filter "matches"
  everything and recipe 3 can't tell. If all `modified` values on a page share today's
  date, say that the server's change dates are unusable and use `date` (papers) or
  `start` (meetings) instead.
- **"Modified since" is not "new since".** A server that honours `--modified-since`
  still returns old papers that were only edited after the cut-off (Düsseldorf,
  2026-09-15: 66 of 158 papers were dated 2025-06-02 to 2026-08-31). For "new papers"
  also check `date` (recipe 2); say which one you report.
- **Deleted objects stay in lists.** Objects with `"deleted": true` have an empty
  `name`, `reference` and `paperType` (6 of those 158 papers). Drop them with
  `select(.deleted != true)` before printing or counting.
- **Order is the server's.** Meeting lists often start with far-future dates, and pages
  aren't sorted by date (Düsseldorf orders by internal id); sort by `start` yourself and
  don't call page 1 "the latest". For **upcoming** meetings, a page limit can cut some
  off (Düsseldorf's page 2 still held meetings in December 2026). Keep fetching with
  `oparl get <next>` (a raw page; its continuation is `.links.next`) while a page still
  has meetings from today on, and stop after the first page with none. Say how many
  pages you checked.
- **`--limit` can cut the whole list.** ALLRIS 1.0 servers (the Berlin BVVs) answer
  `--limit n` with `n` objects and no `next` link, so the list looks complete. A `note`
  ("the last page held exactly n objects …") flags it; leave `--limit` out on those
  servers, or re-run without it before reporting a count.
- **No full-text search in OParl.** Title search is client-side over the pages fetched —
  state how many pages you searched.
- **`next` is the way on.** For more than a few pages use `--max-pages n` or `oparl get
  <next>`; with `--max-pages 0` on a large server, warn that it can take very long.
- **A `note` on stderr says the walk stopped early.** `looped: true` with "stopped after
  page N" means the server kept serving pages that added nothing (the same page, or an
  empty one, under new page links) or pointed back at a page already fetched. Every
  distinct object is in `data`; `next` (also in the output) is where to continue, so say
  how far you got instead of calling the list complete. A note naming a refused link
  ("Refusing to follow … another host") means the same: the data so far is good.
- **A later page failing still prints the pages before it.** Then a `note` ("stopped
  after page N because page N+1 failed"), the JSON with `next` at the failing page, and an
  `Error:` line with a non-zero exit follow. Use the data you got, say the list is
  incomplete, and retry `next` once with `oparl get`.
- **1.0 bodies** have no `agenda-item`, `consultation`, `file`, `membership` or
  `location` lists; the error names what exists. `legislative-term` still works: it
  prints the terms the body embeds (`pages: 0`), with the date filters applied locally —
  terms the server left without `created`/`modified` are printed anyway and the `note`
  says the filter could not be applied to them. Some servers use non-spec field names
  (Düsseldorf links `consultations` and `files`; the CLI follows those two). If `list`
  says a 1.1 body lacks a list, look at the Body (`oparl get <bodyUrl>`) before telling
  the user it doesn't exist, and `oparl get` a matching list URL directly.
- **Cite references.** Quote paper `reference` numbers and the Body name. Council papers
  are largely *amtliche Werke*; motions from groups, attached files and person data are not
  free to republish — don't bulk-copy person records, and check the server's `license`.
