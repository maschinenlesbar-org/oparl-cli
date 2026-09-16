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

**Endpoint registry.** The public list of OParl servers at
`https://dev.oparl.org/api/endpoints`. It caches each server's System object from its last
fetch (`fetched`), and it is rarely updated. Some entries are duplicates or aggregators
(Politik bei Uns, München Transparent).

**Curated endpoint list (`endpoints`, `--source`).** Shipped with this tool: OParl servers
the registry lacks, and a live check of every registry entry. `oparl endpoints` lists both
(`source`: `registry` or `curated`). `checked` is the day of the last check, `working` its
result, `problem` the reason it failed, and `replacedBy` the new URL of a server that moved.
The maintainers refresh it with `npm run check-endpoints`, which checks a failing endpoint
twice before recording it as down. When the registry cannot be reached, `endpoints` lists the
curated entries alone and says so on stderr. `--search` matches title, URL and note, ignoring
case and accents, and falls back to the umlaut spellings (`koeln` → `Köln`) only when nothing
matches literally.

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
`list legislative-term` then prints the embedded terms with `pages: 0` and applies the date
filters locally. A term without `created`/`modified` cannot be filtered on, so it is printed
and the result's `note` says so.

## Lists and paging

**Object list / page.** A list is served in pages: `data` (the objects), `pagination`
(optional counts) and `links` (`first`, `self`, `last`, and `next` on every page but the
last). `oparl list` follows `next`; its result's `next` is where it stopped. A page whose
`data` holds anything but objects is rejected; a server that answers a list URL with a
bare JSON array instead of a page (an SD.NET build in Essen) is read as a single page.

**Filters.** OParl defines `created_since`, `created_until`, `modified_since`,
`modified_until`, `limit` and `omit_internal` for lists (`--modified-since` …). Servers
are meant to support the date filters, but some ignore them or fail on them. SD.NET RIM
servers answer a date window with no objects in it with HTTP 404 — the CLI then exits `4`
"not found" although the list exists; repeat the call without the filter to tell the two
apart. Each filter goes out once with the value you gave: it replaces the server's own
copy in a list URL or a `next` link, and it is set again on the target of a redirect, so
every page is filtered alike.

**Deleted objects (`deleted: true`).** Servers may keep deleted objects in lists, marked
`deleted`, so that syncing clients can remove them. A list only shows them with
`modified_since` on some servers, and since `oparl list` keeps the *last* copy of a
repeated `id`, a tombstone on a later page wins over the live copy on an earlier one.

**Paging loop (`looped`).** A server whose `next` link leads back to a page already fetched,
or that keeps serving pages which add nothing — the same page, or an empty one, under
ever-new `?page=n` links. The walk gives up after three such pages in a row, lists each
object once, sets `looped: true`, and keeps the server's `next` so the list can be
continued by hand. Why three: a page that repeats objects is also what an insertion into
the list during the walk looks like.

**Walk note (`note`).** One sentence in a `list`/`bodies` result, also printed on stderr,
saying why the walk stopped before the end of the list (a paging loop, or a `next` link
the CLI refuses to follow) or which filter it could not apply.

## This tool

**Same-host rule.** Links (`next`, list URLs) and redirects are only followed on the host
they came from; an `http:` link on an `https:` server is upgraded. Anything else stops with
"Refusing to follow …". The same upgrade applies to what is printed: in a response fetched
over https, `http://` URLs on that host are shown as `https://`, so ids you pass back to
`list` or `get` stay encrypted. A relative link (`"body": "bodies"`) is resolved against
the URL the answer actually came from — after a redirect, that is the redirect's target,
not the URL the request started at.

**Server text in messages.** Anything a server sends that ends up in an error message —
an object's `type`, an error `message`, a link, a content type — is first stripped of
control characters, folded onto one line and cut to 200 characters. A hostile or
man-in-the-middled endpoint could otherwise write terminal escape sequences (window
title, colours, screen clearing) or fake an `Error:` line of the CLI's own. In JSON
output the same characters are escaped instead, so nothing is lost.

**`pages` / `next` (list output).** How many pages were fetched, and the link to continue —
present whenever the last page fetched offered one, `null` at the end of the list and when
the link leads back into a loop.
