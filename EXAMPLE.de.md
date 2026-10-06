# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `oparl`, eines pro Skill: eine
Anfrage, die `oparl`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `oparl` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [oparl-council-activity](#oparl-council-activity) · [oparl-endpoint-finder](#oparl-endpoint-finder)

## oparl-council-activity

> Was hat der Düsseldorfer Stadtrat seit dem 1. Oktober veröffentlicht, und welche Sitzungen stehen diesen Monat noch an?

```bash
BODY=https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015          # Body-URL aus oparl-endpoint-finder
oparl list paper "$BODY" --modified-since 2026-10-01 --compact      # eine Seite, 54 Objekte, ca. 10 s
oparl list meeting "$BODY" --max-pages 2 --compact                  # 400 Sitzungen, next → Seite 3
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3" --compact   # nichts nach 2026-03-03
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114026" --compact
```

Der Server hat den Datumsfilter beachtet (kein Objekt vor dem Stichtag geändert). Die 54 Objekte
mischen aber 25 Vorlagen mit Datum im Oktober, 26 ältere, nur bearbeitete Vorlagen (Datum 2026-05-26
bis 2026-09-23) und 3 gelöschte Einträge ohne Titel. Neue Vorlagen hat der Skill deshalb nach `date`
gezählt. Die Sitzungsliste ist nach interner ID sortiert, nicht nach Datum: Seite 2 enthielt noch
8 anstehende Sitzungen, also hat der Skill auch Seite 3 gelesen, die keine mehr hatte, und nach
`start` sortiert.

```
Stadt Düsseldorf – Ratsgeschehen 2026-10-01 bis 2026-10-06   (Body …/Oparl/bodies/0015)

Vorlagen mit Datum ab 1. Oktober: 25   (dazu 26 ältere bearbeitet, 3 gelöscht)
  5 Anfrage · 4 Anfrage AfD · 3 Antrag · 3 Anfrage SPD/Volt · 2 Informationsvorlage
  2 Bezirksvertretung Informationsvorlage · 2 Bezirksvertretung Beschlussvorlage
  2 Anfrage Die Linke · 1 Antrag Die Linke · 1 Antrag AfD
  Am aktivsten: Ausschuss für Wohnungswesen und Modernisierung (AWM, 7), Bezirksvertretung 6 (6),
  Bauausschuss (BAU, 4), Bezirksvertretung 2 (3)

Stadtweit und bemerkenswert
  2026-10-02  AWM/046/2026  Antrag Die Linke  Kontrolle von Mietpreisüberhöhung und Mietwucher
              → zur Entscheidung, Ausschuss für Wohnungswesen und Modernisierung 2026-10-12
  2026-10-05  AWM/049–051/2026  drei Anfragen der AfD zu Sozialwohnungen und Wohngeld
  2026-10-05  BAU/026/2026  Antrag AfD  Stopp der Planung einer Photovoltaikanlage auf dem Rathaus
  2026-10-01  AÖE/063/2026  Informationsvorlage  Sitzungstermine 2027
  2026-10-05  BV2/289–291/2026  drei Haushaltsbegleitanträge (Grüne) für den Stadtbezirk 2:
              barrierefreier Ausbau entlang der Wehrhahn-Linie, Entsiegelung, geplante Grünflächen
  … 16 weitere: 6 aus der Bezirksvertretung 6, je 3 weitere für Wohnungs- und Bauausschuss

Anstehende Sitzungen in diesem Monat (nach Beginn sortiert; Seiten 1–3 der Sitzungsliste, 21 im Oktober)
  10-06 15:00 Schulausschuss              10-06 16:00 Bezirksvertretung 2
  10-06 17:00 Bezirksvertretung 7 und 10  10-07 15:00 Jugendhilfeausschuss, Bezirksvertretung 4
  10-07 16:00 Ordnungs- und Verkehrsausschuss
  10-08 15:00 Ausschuss für Umwelt-, Klima- und Verbraucherschutz
  10-08 16:00 Ausschuss für Digitalisierung, Personal und Organisation
  10-09 14:00 Bezirksvertretung 1
  10-12 15:00 Ausschuss für Chancengerechtigkeit und Integration
  10-12 15:00 Ausschuss für Wohnungswesen und Modernisierung   (entscheidet AWM/046/2026)
  10-13 15:00 Bauausschuss, Ausschuss für Gesundheit und Soziales
  10-13 17:00 Bezirksvertretung 3 und 5   10-14 14:00 Sportausschuss
  10-14 17:00 Bezirksvertretung 6, Ausschuss für Planung und Stadtentwicklung
  10-15 15:00 Kulturausschuss             10-15 18:00 Bezirksvertretung 8
  Im Oktober tagt der Rat nicht; die nächste Ratssitzung ist am 2026-11-12 um 14:00.
Keine Lizenz im Body angegeben (System nennt nur „Open"): mit Vorlagennummer zitieren, nicht massenhaft kopieren.
```

Als Nächstes angeboten: die Tagesordnung des Wohnungsausschusses am 12.10.2026 oder eine Titelsuche über mehr Seiten.

## oparl-endpoint-finder

> Haben Neuss und Düsseldorf eine funktionierende OParl-Schnittstelle für ihr Ratsinformationssystem?

```bash
oparl endpoints --search "neuss" --compact
oparl system "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl bodies "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015" --compact
```

Neuss hat keinen eigenen Eintrag. Die Suche fand die Stadt im Hinweis zum Düsseldorfer Eintrag, der
sagt, dass der gemeinsame Server von ITK Rheinland auch Neuss bedient – eine Suche beantwortete also
beide Orte; der Skill hat diesen einen Server live geprüft und die beiden Körperschaften anhand des
Namens ausgewählt.

```
Neuss und Düsseldorf – beide funktionieren, auf einem gemeinsamen Server
  Verzeichnis: „Landeshauptstadt Dusseldorf", bei der letzten Prüfung funktionierend (2026-09-16);
               der Hinweis nennt Stadt Neuss unter den Körperschaften des Servers von ITK Rheinland
  System:      https://ris-oparl.itk-rheinland.de/Oparl/system   (live geantwortet)
  Produkt:     Session von SOMACOS, OParl 1.1, Schnittstelle 1.6.0, betrieben von ITK Rheinland
               (ris@itk-rheinland.de)
  Bodies:      Stadt Neuss (NE)          https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009
               Stadt Duesseldorf (LHD)   https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015
               beide bei OParl seit 2025-04-30
  Listen:      beide verlinken organization, person, meeting, paper, membership, locationList,
               agendaItem, legislativeTermList, consultations, files
  Gleicher Server: Stadt Mönchengladbach (…/0011), Stadt Grevenbroich (…/0013),
               Rheinkreis Neuss (…/0019)
  Lizenz:      Das System gibt nur „Open" an (kein Lizenzname, keine URL); die Bodies haben nur
               licenseValidSince, keine Lizenz. Eine Nutzung über das Lesen hinaus braucht die
               Erlaubnis des Betreibers.
```

Als Nächstes angeboten: aktuelle Vorlagen und Sitzungen einer der beiden Körperschaften mit `oparl-council-activity`.
