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
version: 1.0.0
userInvocable: true
---

# OParl Council Activity

Reads a council's meetings, papers and committees through OParl. It needs a **Body URL**;
if the user names a place instead, run the `oparl-endpoint-finder` skill first.

## Tooling

This skill drives the `oparl` command. **Before anything else, validate it is available** — run `command -v oparl` (or `oparl --version`). If it is not on your PATH, STOP and inform the user that the `oparl` CLI (`@maschinenlesbar.org/oparl-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

OParl is read-only and needs **no key/account/config**. Pass `--compact` when piping to `jq`. Data licenses differ per server — see Traps.

## Commands

```bash
oparl list paper <bodyUrl> [--modified-since YYYY-MM-DD] [--max-pages n]
oparl list meeting <bodyUrl> [--max-pages n]
oparl list organization <bodyUrl> [--max-pages 0]
oparl list legislative-term <bodyUrl>
oparl get <url>            # any object, or the `next` page of a list
```

`list` returns `{ data, pages, next }`: `data` the objects, `next` the link to continue
(`null` at the end). Default is **one page** — keep it small first; some servers need a
minute per page.

## Recipes

```bash
# Recent papers: date, reference, type, title
oparl list paper "$BODY" --modified-since 2026-09-01 --compact \
  | jq -r '.data[] | [.date // "", .reference // "", .paperType // "", .name] | @tsv'

# Did the server honour the filter? Count objects older than the cut-off
oparl list paper "$BODY" --modified-since 2026-09-01 --compact \
  | jq '[.data[] | select(.modified < "2026-09-01")] | length'

# Meetings on the first pages, with dates
oparl list meeting "$BODY" --max-pages 2 --compact | jq -r '.data[] | [.start // "", .name] | @tsv'

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

- **Filters may be ignored.** Some servers return everything despite `--modified-since`;
  others fail with exit `1` and a 400/500 hint. Check `modified` against the cut-off
  (recipe 2) and say which happened. On a failure, retry without the filter and filter
  with `jq`.
- **Some timestamps are fake.** more! rubin servers (e.g. Freiburg, OParl 1.0) stamp every
  object's `created` and `modified` with the current date, so a date filter "matches"
  everything and recipe 2 can't tell. If all `modified` values on a page share today's
  date, say that the server's change dates are unusable and use `date` (papers) or
  `start` (meetings) instead.
- **Order is the server's.** Meeting lists often start with far-future dates; sort by
  `start` yourself and don't call page 1 "the latest".
- **No full-text search in OParl.** Title search is client-side over the pages fetched —
  state how many pages you searched.
- **`next` is the way on.** For more than a few pages use `--max-pages n` or `oparl get
  <next>`; with `--max-pages 0` on a large server, warn that it can take very long.
- **1.0 bodies** have no `agenda-item`, `consultation`, `file`, `membership`,
  `location` or `legislative-term` lists; the error names what exists.
- **Cite references.** Quote paper `reference` numbers and the Body name. Council papers
  are largely *amtliche Werke*; motions from groups, attached files and person data are not
  free to republish — don't bulk-copy person records, and check the server's `license`.
