# Data license

> **This tool does not include, host, or redistribute any data.**
> `oparl-cli` is a *client*. It only accesses data served live by the **OParl servers of
> German municipalities, districts and associations**, found through the public registry
> at dev.oparl.org. That data belongs to each operator and is governed by **their**
> terms, summarized below. The license of this CLI's own source code is a separate
> matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data providers** | Each municipality, district or association running an OParl server (about a hundred in the registry) |
| **API / source** | The OParl standard (https://oparl.org/), one server per operator; registry: `https://dev.oparl.org/api/endpoints` |
| **Data license** | **Set per server — no common license.** The OParl `license` field on System/Body objects states it where set; most servers leave it empty. |
| **Attribution** | Name the operator (the Body) as the source. |
| **Personal use** | Reading and analysing is what the servers are published for. |
| **Commercial use & redistribution** | Only where the server's stated license allows it; ask the operator otherwise. |

## What the license field tells you

OParl lets a server declare a license URL on its System and Body objects (`license`,
plus `licenseValidSince` on the Body). In practice the picture is mixed. Examples seen
in the registry (September 2026):

| Server | Declared license |
| --- | --- |
| Stadt Leipzig | CC BY 4.0 |
| Stadt Dresden | Datenlizenz Deutschland – Zero 2.0 (`dl-de/zero-2-0`) |
| Stadt Bonn | a link to its own terms of use |
| Landeshauptstadt Düsseldorf | `"Open"` — no license named |
| Landkreis Märkisch-Oderland | "Nutzung nur nach Genehmigung" (use only with permission) |
| Most SD.NET and more! rubin servers | nothing declared |

Check before you republish:

```bash
oparl system <systemUrl> | jq '{name, license}'
oparl bodies <systemUrl> | jq '.data[] | {name, license, licenseValidSince}'
```

**No declared license does not mean free to reuse.** Without one, treat the content as
the operator's and ask before publishing it beyond quotation.

## Official documents and personal data

- **Council papers** (*Vorlagen*, *Beschlüsse*) issued by a public authority are largely
  *amtliche Werke* under **§ 5 UrhG** — reusable unaltered (§ 62) and with a source
  citation (§ 63). **Motions and inquiries from parliamentary groups** and **attached
  files** (reports, expert opinions, plans) can carry third-party copyright.
- **Person records** (council members, their memberships, sometimes contact details) are
  **personal data** under the GDPR. Publishing them in a new context — e.g. a searchable
  database — needs its own legal basis; don't bulk-republish person data.

## What this tool does

It fetches exactly what a server publishes over OParl and prints it unchanged. It does not
filter out any fields, so the responsibility for what you do with the output — especially
person data and attached files — is yours.
