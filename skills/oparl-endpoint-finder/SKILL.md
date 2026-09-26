---
name: oparl-endpoint-finder
description: >
  Find a German municipality's OParl endpoint (its council information system API) and
  check that it works, using the oparl CLI. Trigger when the user asks "does Köln have an
  OParl API?", "find the Ratsinformationssystem API for Münster", "which councils publish
  OParl?", "is the OParl endpoint of Solingen still working?", "what software does
  Dresden's council system run?", or needs a System or Body URL before looking at meetings
  and papers. Searches the dev.oparl.org registry and the curated list shipped with the
  CLI, verifies the endpoint live, lists its bodies and the lists each body offers, and
  reports the declared data license.
compatibility: >
  Requires the `oparl` CLI (npm package @maschinenlesbar.org/oparl-cli) on PATH,
  installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to the municipal OParl servers being queried.
---

# OParl Endpoint Finder

OParl is the open standard API of German council information systems
(*Ratsinformationssysteme*). There is no central API: every municipality runs its own
server. This skill finds the right one and proves it answers.

## Tooling

This skill drives the `oparl` command. **Before anything else, validate it is available** — run `command -v oparl` (or `oparl --version`). If it is not on your PATH, STOP and inform the user that the `oparl` CLI (`@maschinenlesbar.org/oparl-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

OParl is read-only and needs **no key/account/config**. Pass `--compact` when piping to `jq`. Data licenses differ per server — see the last step.

## Step 1 — Search the known endpoints

```bash
oparl endpoints --search "<place or part of the URL>" --compact \
  | jq -r '.[] | [.title, .source, .working, .checked // .fetched, .problem // "", .replacedBy // "", .url] | @tsv'
```

`endpoints` lists the dev.oparl.org registry (`source: "registry"`) followed by a curated
list of servers the registry lacks (`source: "curated"`), e.g. Essen, Bremen, Karlsruhe or
the Berlin district assemblies (BVV). `working` is the result of the last live check made by
the CLI's maintainers (`checked`, reason in `problem`); only where `checked` is null is it
the registry's own last fetch (`fetched`).

- Search by place name (`köln`, `münster`) or product host (`ratsinfomanagement`,
  `gremien.info`). It matches the title, URL and note, ignoring case and accents
  (`düsseldorf` finds "Landeshauptstadt Dusseldorf"). Only when nothing matches literally
  does it fall back to the ä/ae spellings, so `duesseldorf` and `koeln` find their cities
  while a term like `Aue` isn't read as `Au`. A short term (under 4 characters) never gets
  that fallback.
- **`replacedBy` set** → the server moved; use that URL (it is listed too), not the old one.
- **`note` set** → read it: it flags aggregators, archives and servers with known problems.
- **A note on stderr that the registry could not be read** → only the curated servers are
  listed, as of their `checked` date. Say so before concluding that a place has no server.
- No hit does **not** mean the municipality has no OParl API — both lists are incomplete,
  and the search does not see the names of the bodies a **shared server** hosts (it
  matches title, URL and note only; Mönchengladbach is served from the Düsseldorf entry).
  Try the county, the Verbandsgemeinde or the regional data centre, or look through the
  bodies of the shared servers nearby (`select((.bodyCount // 0) > 1)`, then `oparl
  bodies <url>` for a few of them). Say so, and suggest checking the municipality's
  council portal for an OParl link; any System URL found there works with `oparl system`.
- `oparl endpoints --working --oparl-version 1.1` answers "which councils publish OParl?".
  `--oparl-version` takes `1.0`/`1.1` or the whole version URI (`https://schema.oparl.org/1.1/`).

## Step 2 — Verify it live

`working` is a snapshot from `checked` (or `fetched`), and servers switch OParl on and off:
on 2026-09-15 the registry still listed Bonn and Leipzig as working (fetched 2026-01-17), but
neither answered. Check now:

```bash
oparl system "<System URL>" --compact | jq '{name, oparlVersion, vendor, product, license}'
```

- Exit `0` with a `body` URL → live.
- Exit `6` (timeout) → the server may just be slow; retry once with `--timeout 300000`
  before calling it down.
- Exit `6` "closed the connection without sending a response" or "answered with HTTP 101
  (protocol upgrade)" → something answers at that address, but not with an HTTP response
  (a proxy, a WebSocket endpoint). A longer `--timeout` will not help; report the URL as
  not an OParl endpoint.
- Exit `1` "not an OParl System" or an HTML page, or exit `4` → the endpoint moved or is
  gone. Report that, with the `checked` (or `fetched`) date, and any `replacedBy`.
- Exit `1` "is an OParl System, but its `body` is …" → the URL is right and the server's
  System is broken: it doesn't publish the URL of its list of bodies, so `oparl bodies`
  cannot work. Show what it does send (`oparl get "<System URL>"`) and report it as a
  server-side defect, not a wrong URL.
- Exit `6` with "unable to verify the first certificate" → the server doesn't send its
  intermediate TLS certificate (Kaiserslautern). It is up; tell the user it needs
  `NODE_EXTRA_CA_CERTS` with that certificate (README, Troubleshooting). Never suggest
  turning off certificate checks.
- Exit `1` with `HTTP 500` (or another 5xx) → the server is up but failing. Retry once;
  if it fails again, report it as not answering today rather than gone.

## Step 3 — Bodies and what they offer

```bash
oparl bodies "<System URL>" --compact | jq -r '.data[] | [.name, .ags // "", .id] | @tsv'
oparl get "<Body id>" --compact \
  | jq -r 'to_entries[] | select(.key | test("^(organization|person|meeting|paper|agendaItem|consultation|consultations|file|files|membership|locationList|legislativeTermList)$")) | .key'
```

Match the list names, not "any value that looks like a URL": a Body's `id`, `type`,
`system` and `web` are URLs too, but not lists it offers. Some servers use the plural
`consultations`/`files`, which `oparl list consultation`/`file` follows.
Report the Body `id` — the next skill (`oparl-council-activity`) and `oparl list` need it.
OParl **1.0** bodies only link `organization`, `person`, `meeting`, `paper`.

## Step 4 — Report

Give: title, System URL, Body URL(s), OParl version, product/vendor, whether it answered
live, and the declared `license` of System/Body. **If no license is declared, say that
reuse beyond reading needs the operator's permission** — don't imply the data is open.
Treat a `license` that is neither a license URL nor a recognisable license name as not
clearly declared, and quote it: Düsseldorf's System says `"license": "Open"`, and its
Body has only `licenseValidSince` (a date, no license). A `licenseValidSince` without
`license` declares nothing.

## Traps

- **Duplicates and aggregators.** Some municipalities appear twice (old and new URL); "Politik
  bei Uns" and "München Transparent" are aggregators, not the official server — prefer the
  municipality's own endpoint.
- **`bodyCount` in the registry is often 0** even for working servers; count bodies live.
  Curated entries carry the count from their last check.
- **Shared servers.** One System can host many bodies (a data centre, a Verbandsgemeinde with
  its member municipalities); find the right Body by name.
- **A note "stopped after page N"** from `oparl bodies` means the walk gave up because the
  server kept serving pages that added nothing (the same page under new page links, as
  OWL-IT does) or pointed back at a page already fetched; the output still has every
  distinct body (`looped: true`). After repeated pages `next` says where a manual `oparl
  get` could go on; after a link back it is `null`.
- **Vendor URLs carry versions** (`https://www.somacos.de?oparl=v1.6.1`); name the product,
  not the query string.
- **Links stay on one host.** "Refusing to follow … another host" means the server pointed
  elsewhere; report it rather than working around it.
