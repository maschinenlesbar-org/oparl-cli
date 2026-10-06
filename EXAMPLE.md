# Examples

Real examples for the Claude Code skills of the `oparl` plugin, one per skill: a request,
the `oparl` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `oparl` 0.2.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [oparl-council-activity](#oparl-council-activity) · [oparl-endpoint-finder](#oparl-endpoint-finder)

## oparl-council-activity

> What has the Düsseldorf city council put out since 1 October, and which meetings are coming up this month?

```bash
BODY=https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015          # Body URL from oparl-endpoint-finder
oparl list paper "$BODY" --modified-since 2026-10-01 --compact      # one page, 54 objects, about 10 s
oparl list meeting "$BODY" --max-pages 2 --compact                  # 400 meetings, next → page 3
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3" --compact   # nothing after 2026-03-03
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114026" --compact
```

The server honoured the date filter (no object modified before the cut-off), but the 54 objects
mix 25 papers dated in October, 26 older papers (dated 2026-05-26 to 2026-09-23) that were only
edited, and 3 deleted stubs without a title. So the skill counted new papers by `date`. The meeting
list is ordered by internal id, not by date: page 2 still held 8 upcoming meetings, so the skill
read page 3 as well, which had none, and sorted by `start`.

```
Stadt Düsseldorf – council activity 2026-10-01 to 2026-10-06   (Body …/Oparl/bodies/0015)

Papers dated since 1 October: 25   (plus 26 older papers edited, 3 deleted)
  5 Anfrage · 4 Anfrage AfD · 3 Antrag · 3 Anfrage SPD/Volt · 2 Informationsvorlage
  2 Bezirksvertretung Informationsvorlage · 2 Bezirksvertretung Beschlussvorlage
  2 Anfrage Die Linke · 1 Antrag Die Linke · 1 Antrag AfD
  Busiest: Ausschuss für Wohnungswesen und Modernisierung (AWM, 7), Bezirksvertretung 6 (6),
  Bauausschuss (BAU, 4), Bezirksvertretung 2 (3)

City-wide and notable
  2026-10-02  AWM/046/2026  Antrag Die Linke  Kontrolle von Mietpreisüberhöhung und Mietwucher
              → for decision, Ausschuss für Wohnungswesen und Modernisierung 2026-10-12
  2026-10-05  AWM/049–051/2026  three AfD questions on social housing and housing benefit
  2026-10-05  BAU/026/2026  Antrag AfD  stop planning a photovoltaic system on the town hall
  2026-10-01  AÖE/063/2026  Informationsvorlage  Sitzungstermine 2027 (meeting dates for 2027)
  2026-10-05  BV2/289–291/2026  three budget motions (Grüne) for Bezirk 2: step-free access along
              the Wehrhahn line, unsealing surfaces, funding planned green and leisure areas
  … 16 more: 6 from Bezirksvertretung 6, 3 more each for the housing and building committees

Upcoming meetings this month (sorted by start; pages 1–3 of the meeting list, 21 in October)
  10-06 15:00 Schulausschuss              10-06 16:00 Bezirksvertretung 2
  10-06 17:00 Bezirksvertretung 7 and 10  10-07 15:00 Jugendhilfeausschuss, Bezirksvertretung 4
  10-07 16:00 Ordnungs- und Verkehrsausschuss
  10-08 15:00 Ausschuss für Umwelt-, Klima- und Verbraucherschutz
  10-08 16:00 Ausschuss für Digitalisierung, Personal und Organisation
  10-09 14:00 Bezirksvertretung 1
  10-12 15:00 Ausschuss für Chancengerechtigkeit und Integration
  10-12 15:00 Ausschuss für Wohnungswesen und Modernisierung   (decides AWM/046/2026)
  10-13 15:00 Bauausschuss, Ausschuss für Gesundheit und Soziales
  10-13 17:00 Bezirksvertretung 3 and 5   10-14 14:00 Sportausschuss
  10-14 17:00 Bezirksvertretung 6, Ausschuss für Planung und Stadtentwicklung
  10-15 15:00 Kulturausschuss             10-15 18:00 Bezirksvertretung 8
  No Rat (full council) meeting in October; the next is on 2026-11-12 at 14:00.
No license declared by the Body (System says only "Open"): quote with paper references, don't bulk-copy.
```

Next steps offered: the agenda of the housing committee on 2026-10-12, or a title search over more pages.

## oparl-endpoint-finder

> Do Neuss and Düsseldorf have a working OParl API for their council information systems?

```bash
oparl endpoints --search "neuss" --compact
oparl system "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl bodies "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015" --compact
```

Neuss has no entry of its own. The search found it in the note of the Düsseldorf entry, which says
that ITK Rheinland's shared server also hosts Neuss — so one search answered both places, and the
skill checked that one server live and picked the two bodies by name.

```
Neuss and Düsseldorf – both working, on one shared server
  Registry:  "Landeshauptstadt Dusseldorf", working at its last check (2026-09-16); its note
             lists Stadt Neuss among the bodies of ITK Rheinland's shared server
  System:    https://ris-oparl.itk-rheinland.de/Oparl/system   (answered live)
  Product:   Session by SOMACOS, OParl 1.1 interface 1.6.0, run by ITK Rheinland
             (ris@itk-rheinland.de)
  Bodies:    Stadt Neuss (NE)          https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009
             Stadt Duesseldorf (LHD)   https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015
             both on OParl since 2025-04-30
  Lists:     both link organization, person, meeting, paper, membership, locationList,
             agendaItem, legislativeTermList, consultations, files
  Same server: Stadt Mönchengladbach (…/0011), Stadt Grevenbroich (…/0013),
             Rheinkreis Neuss (…/0019)
  License:   the System declares only "Open" (no license name or URL); the Bodies have only
             licenseValidSince, no license. Reuse beyond reading needs the operator's permission.
```

Next steps offered: recent papers and meetings of either body with `oparl-council-activity`.
