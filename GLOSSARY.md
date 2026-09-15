# Glossary

The OParl objects and terms you meet when using `oparl`. For the option reference see
the **[README](README.md)** and the cookbook in **[Usage.md](Usage.md)**.

## The standard

**OParl.** An open standard for read-only access to council information systems
(*Ratsinformationssysteme*, RIS) in Germany — the systems municipalities use to publish
meetings, agendas, motions and decisions. Maintained by OKF Deutschland and Vitako;
current version **1.1** (2018), backwards-compatible with **1.0** (2016). Spec:
<https://oparl.org/spezifikation/>.

**Ratsinformationssystem (RIS).** The software behind a council's public portal. Common
products with OParl support: SD.NET RIM (Sternberg), Session/SessionNet (Somacos),
more! rubin, ALLRIS (CC e-gov).

**Endpoint registry (`endpoints`).** The public list of OParl servers at
`https://dev.oparl.org/api/endpoints`. It caches each server's System object from its last
fetch: `working` says whether that fetch succeeded, `fetched` when it happened. Some
entries are duplicates or aggregators (Politik bei Uns, München Transparent).

**Object type URI (`type`).** Every OParl object has `type`, e.g.
`https://schema.oparl.org/1.1/Meeting`; the version in the path tells 1.0 from 1.1.

**Object id (`id`).** Every object's own URL. Objects reference each other by these
URLs — follow them with `oparl get <id>`.

## The objects

**System (`system`).** The entry point of a server: `oparlVersion`, `vendor`, `product`,
and `body`, the URL of the list of bodies.

**Body (`bodies`) — *Körperschaft*.** An organisation running council work on the server,
usually one municipality or district (`name`, `ags` — the official municipality key). A
Body links its object lists: `organization`, `person`, `meeting`, `paper` and, in 1.1,
`agendaItem`, `consultation`, `file`, `membership`, `locationList`,
`legislativeTermList`.

**Organization (`list organization`) — *Gremium*.** A council, committee, district
council, parliamentary group (*Fraktion*) or administrative unit. `classification` names
the kind.

**Person (`list person`).** A council member or other person with a role; see Membership.
Personal data — see DATA_LICENSE.md.

**Membership (`list membership`) — *Mitgliedschaft*.** A person's membership in an
organization, with `role`, `startDate`, `endDate` and `votingRight`.

**Meeting (`list meeting`) — *Sitzung*.** A meeting of one or more organizations:
`name`, `start`, `end`, `location`, `cancelled`, the `agendaItem` list and protocol files.

**AgendaItem (`list agenda-item`) — *Tagesordnungspunkt (TOP)*.** One item of a meeting's
agenda: `number`, `name`, `public`, `result`, the `consultation` it belongs to.

**Paper (`list paper`) — *Drucksache / Vorlage*.** A document the council deals with — an
administration proposal (*Beschlussvorlage*), a motion (*Antrag*), an inquiry
(*Anfrage*): `reference` (the document number), `name`, `date`, `paperType`,
`mainFile`, `auxiliaryFile`, and its `consultation`s.

**Consultation (`list consultation`) — *Beratung*.** A paper being dealt with in a
particular meeting and organization, with `role` (e.g. *Entscheidung*, *Vorberatung*)
and `authoritative`.

**File (`list file`) — *Datei*.** A document attached to a paper or meeting:
`fileName`, `mimeType`, `accessUrl`, `downloadUrl`. This CLI prints file metadata only; it
does not download files.

**Location (`list location`) — *Ort*.** An address or room, often embedded in meetings.

**LegislativeTerm (`list legislative-term`) — *Wahlperiode*.** A council term with
`startDate` and `endDate`. OParl 1.0 bodies embed these as an array instead of a list URL;
`list legislative-term` then prints the embedded terms with `pages: 0`.

## Lists and paging

**Object list / page.** A list is served in pages: `data` (the objects), `pagination`
(optional counts) and `links` (`first`, `self`, `last`, and `next` on every page but the
last). `oparl list` follows `next`; its result's `next` is where it stopped.

**Filters.** OParl defines `created_since`, `created_until`, `modified_since`,
`modified_until`, `limit` and `omit_internal` for lists (`--modified-since` …). Servers
are meant to support the date filters, but some ignore them or fail on them.

**Deleted objects (`deleted: true`).** Servers may keep deleted objects in lists, marked
`deleted`, so that syncing clients can remove them.

## This tool

**Same-host rule.** Links (`next`, list URLs) and redirects are only followed on the host
they came from; an `http:` link on an `https:` server is upgraded. Anything else stops with
"Refusing to follow …". The same upgrade applies to what is printed: in a response fetched
over https, `http://` URLs on that host are shown as `https://`, so ids you pass back to
`list` or `get` stay encrypted.

**`pages` / `next` (list output).** How many pages were fetched, and the link to continue.
