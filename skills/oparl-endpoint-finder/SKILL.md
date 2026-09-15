---
name: oparl-endpoint-finder
description: >
  Find a German municipality's OParl endpoint (its council information system API) and
  check that it works, using the oparl CLI. Trigger when the user asks "does Köln have an
  OParl API?", "find the Ratsinformationssystem API for Münster", "which councils publish
  OParl?", "is the OParl endpoint of Solingen still working?", "what software does
  Dresden's council system run?", or needs a System or Body URL before looking at meetings
  and papers. Searches the dev.oparl.org registry, verifies the endpoint live, lists its
  bodies and the lists each body offers, and reports the declared data license.
version: 1.0.0
userInvocable: true
---

# OParl Endpoint Finder

OParl is the open standard API of German council information systems
(*Ratsinformationssysteme*). There is no central API: every municipality runs its own
server. This skill finds the right one and proves it answers.

## Tooling

This skill drives the `oparl` command. **Before anything else, validate it is available** — run `command -v oparl` (or `oparl --version`). If it is not on your PATH, STOP and inform the user that the `oparl` CLI (`@maschinenlesbar.org/oparl-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

OParl is read-only and needs **no key/account/config**. Pass `--compact` when piping to `jq`. Data licenses differ per server — see the last step.

## Step 1 — Search the registry

```bash
oparl endpoints --search "<place or part of the URL>" --compact \
  | jq -r '.[] | [.title, .working, .oparlVersion, .systemName, .fetched, .url] | @tsv'
```

- Search by place name (`köln`, `münster`) or product host (`ratsinfomanagement`,
  `gremien.info`). Umlauts matter as written in the title ("Köln", but "Dusseldorf").
- No hit does **not** mean the municipality has no OParl API — the registry is incomplete.
  Say so, and suggest checking the municipality's council portal for an OParl link.
- `oparl endpoints --working --oparl-version 1.1` answers "which councils publish OParl?".

## Step 2 — Verify it live

The registry's `working` is a snapshot from `fetched`. Check now:

```bash
oparl system "<System URL>" --compact | jq '{name, oparlVersion, vendor, product, license}'
```

- Exit `0` with a `body` URL → live.
- Exit `6` (timeout) → the server may just be slow; retry once with `--timeout 300000`
  before calling it down.
- Exit `1` "not an OParl System" or an HTML page, or exit `4` → the endpoint moved or is
  gone. Report that, with the registry's `fetched` date.

## Step 3 — Bodies and what they offer

```bash
oparl bodies "<System URL>" --compact | jq -r '.data[] | [.name, .ags // "", .id] | @tsv'
oparl get "<Body id>" --compact \
  | jq -r 'to_entries[] | select(.value | type == "string" and test("^https?://")) | .key'
```

Report the Body `id` — the next skill (`oparl-council-activity`) and `oparl list` need it.
OParl **1.0** bodies only link `organization`, `person`, `meeting`, `paper`.

## Step 4 — Report

Give: title, System URL, Body URL(s), OParl version, product/vendor, whether it answered
live, and the declared `license` of System/Body. **If no license is declared, say that
reuse beyond reading needs the operator's permission** — don't imply the data is open.

## Traps

- **Duplicates and aggregators.** Some municipalities appear twice (old and new URL); "Politik
  bei Uns" and "München Transparent" are aggregators, not the official server — prefer the
  municipality's own endpoint.
- **`bodyCount` in the registry is often 0** even for working servers; count bodies live.
- **Vendor URLs carry versions** (`https://www.somacos.de?oparl=v1.6.1`); name the product,
  not the query string.
- **Links stay on one host.** "Refusing to follow … another host" means the server pointed
  elsewhere; report it rather than working around it.
