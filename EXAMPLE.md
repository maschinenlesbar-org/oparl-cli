# Examples

Real examples for the Claude Code skills of the `oparl` plugin, one per skill: a request,
the `oparl` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `oparl` 0.0.1.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [oparl-council-activity](#oparl-council-activity) · [oparl-endpoint-finder](#oparl-endpoint-finder)

## oparl-council-activity

> What has the Düsseldorf city council put out since 1 September, and which meetings are coming up this month?

```bash
BODY=https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015          # Body URL from oparl-endpoint-finder
oparl list paper "$BODY" --modified-since 2026-09-01 --compact      # one page, 158 objects, about 55 s
oparl list meeting "$BODY" --max-pages 2 --compact                  # 400 meetings, next → page 3
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3" --compact   # nothing after 2026-03-03
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/113688" --compact
```

The server honoured the date filter (no object older than the cut-off), but the 158 objects mix
86 papers dated in September, 66 older papers that were only edited, and 6 deleted stubs without
a title. So the skill counted new papers by `date`. The meeting list is ordered by internal id,
not by date: the skill sorted by `start` and read page 3 to check that no later meetings were hidden.

```
Stadt Düsseldorf – council activity 2026-09-01 to 2026-09-15   (Body …/Oparl/bodies/0015)

Papers dated since 1 September: 86   (plus 66 older papers edited, 6 deleted)
  28 Anfrage · 25 Antrag · 10 Bezirksvertretung Beschlussvorlage · 9 Bezirksvertretung
  Informationsvorlage · 6 Eingabe nach 24 GO · 5 Anfrage SPD/Volt · 3 Informationsvorlage
  Busiest: Bezirksvertretung 2 (38), Bezirksvertretung 1 (17), Bezirksvertretung 5 (10)

City-wide and notable
  2026-09-11  HFA/031/2026  Informationsvorlage  Kreditaufnahmen III. Quartal 2026
              → for information (Kenntnisnahme), Haupt- und Finanzausschuss 2026-09-14
  2026-09-04  HFA/030/2026  Anfrage SPD/Volt     Auswirkungen der Arbeitskreisrechnung zum
              kommunalen Finanzausgleich 2027 auf den Düsseldorfer Haushalt
  2026-09-14  ABA/041/2026  Eingabe nach 24 GO   Erschütterungen durch den Straßenbahnverkehr
              auf der Zeppelinstraße
  2026-09-07  BV3/201/2026, BV3/202/2026  Antrag (Fraktion Die Linke): review a nearly car-free
              Brunnenstraße and a weekend car-free Friedrichstraße, April–October 2027
  … 81 more, 70 of them from the Bezirksvertretungen

Upcoming meetings (sorted by start; pages 1–3 of the meeting list)
  2026-09-15 15:00  Rechnungsprüfungsausschuss   2026-09-15 16:00  Bezirksvertretung 2
  2026-09-15 16:00  Ausschuss für Gleichstellung und Antidiskriminierung
  2026-09-15 17:00  Bezirksvertretung 5          2026-09-17 16:00  Anregungs- und Beschwerdeausschuss
  2026-09-18 14:00  Bezirksvertretung 1          2026-09-24 14:00  Rat (full council)
  2026-09-25 10:00  Seniorenrat
  2026-09-29 16:00  Ausschuss für Wirtschaftsförderung, internationale und regionale Zusammenarbeit
No license declared by the Body (System says only "Open"): quote with paper references, don't bulk-copy.
```

Next steps offered: the agenda of the Rat meeting on 2026-09-24, or a title search over more pages.

## oparl-endpoint-finder

> Do Bonn and Düsseldorf have a working OParl API for their council information systems?

```bash
oparl endpoints --search "bonn" --compact
oparl system "https://www.bonn.sitzung-online.de/public/oparl/system" --compact   # exit 1, same on retry: HTML page
oparl endpoints --search "düsseldorf" --compact
oparl system "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl bodies "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015" --compact
```

The registry still marks Bonn as working, but that flag is from its fetch on 2026-01-17; live, the
URL serves an HTML page. The registry spells the other entry "Dusseldorf", and the umlaut search
found it anyway. That server hosts five bodies, so the skill picked Düsseldorf's by name.

```
Bonn – registered, not working today
  Registry:  "Stadt Bonn", OParl 1.1, ALLRIS, working at its last fetch (2026-01-17)
  System:    https://www.bonn.sitzung-online.de/public/oparl/system
  Live:      no – returns an HTML page instead of OParl JSON (exit 1). The endpoint has moved
             or been switched off; look for a new OParl link on the city's council portal.

Düsseldorf – working
  Registry:  "Landeshauptstadt Dusseldorf", OParl 1.1, working at its last fetch (2026-01-17)
  System:    https://ris-oparl.itk-rheinland.de/Oparl/system   (answered live)
  Product:   Session by SOMACOS, OParl interface 1.6.0, run by ITK Rheinland
  Body:      Stadt Duesseldorf (LHD)   https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015
             on OParl since 2025-04-30
  Lists:     organization, person, meeting, paper, membership, locationList, agendaItem,
             legislativeTermList, consultations, files
  Same server: Stadt Neuss (…/bodies/0009), Stadt Mönchengladbach (…/0011),
             Stadt Grevenbroich (…/0013), Rheinkreis Neuss (…/0019)
  License:   the System declares only "Open" (no license name or URL), the Body none.
             Reuse beyond reading needs the operator's permission.
```

Next steps offered: recent papers and meetings of the Düsseldorf body with `oparl-council-activity`.
