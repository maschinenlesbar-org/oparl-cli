# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `oparl`, eines pro Skill: eine
Anfrage, die `oparl`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `oparl` 0.0.1 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [oparl-council-activity](#oparl-council-activity) · [oparl-endpoint-finder](#oparl-endpoint-finder)

## oparl-council-activity

> Was hat der Düsseldorfer Stadtrat seit dem 1. September veröffentlicht, und welche Sitzungen stehen diesen Monat noch an?

```bash
BODY=https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015          # Body-URL aus oparl-endpoint-finder
oparl list paper "$BODY" --modified-since 2026-09-01 --compact      # eine Seite, 158 Objekte, ca. 55 s
oparl list meeting "$BODY" --max-pages 2 --compact                  # 400 Sitzungen, next → Seite 3
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3" --compact   # nichts nach 2026-03-03
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/113688" --compact
```

Der Server hat den Datumsfilter beachtet (kein Objekt älter als der Stichtag). Die 158 Objekte
mischen aber 86 Vorlagen mit Datum im September, 66 ältere, nur bearbeitete Vorlagen und 6 gelöschte
Einträge ohne Titel. Neue Vorlagen hat der Skill deshalb nach `date` gezählt. Die Sitzungsliste ist
nach interner ID sortiert, nicht nach Datum: Der Skill hat nach `start` sortiert und Seite 3 gelesen,
um sicherzugehen, dass keine späteren Sitzungen fehlen.

```
Stadt Düsseldorf – Ratsgeschehen 2026-09-01 bis 2026-09-15   (Body …/Oparl/bodies/0015)

Vorlagen mit Datum ab 1. September: 86   (dazu 66 ältere bearbeitet, 6 gelöscht)
  28 Anfrage · 25 Antrag · 10 Bezirksvertretung Beschlussvorlage · 9 Bezirksvertretung
  Informationsvorlage · 6 Eingabe nach 24 GO · 5 Anfrage SPD/Volt · 3 Informationsvorlage
  Am aktivsten: Bezirksvertretung 2 (38), Bezirksvertretung 1 (17), Bezirksvertretung 5 (10)

Stadtweit und bemerkenswert
  2026-09-11  HFA/031/2026  Informationsvorlage  Kreditaufnahmen III. Quartal 2026
              → zur Kenntnisnahme, Haupt- und Finanzausschuss 2026-09-14
  2026-09-04  HFA/030/2026  Anfrage SPD/Volt     Auswirkungen der Arbeitskreisrechnung zum
              kommunalen Finanzausgleich 2027 auf den Düsseldorfer Haushalt
  2026-09-14  ABA/041/2026  Eingabe nach 24 GO   Erschütterungen durch den Straßenbahnverkehr
              auf der Zeppelinstraße
  2026-09-07  BV3/201/2026, BV3/202/2026  Antrag (Fraktion Die Linke): Prüfung einer nahezu
              autofreien Brunnenstraße und einer am Wochenende autofreien Friedrichstraße, April–Oktober 2027
  … 81 weitere, davon 70 aus den Bezirksvertretungen

Anstehende Sitzungen (nach Beginn sortiert; Seiten 1–3 der Sitzungsliste)
  2026-09-15 15:00  Rechnungsprüfungsausschuss   2026-09-15 16:00  Bezirksvertretung 2
  2026-09-15 16:00  Ausschuss für Gleichstellung und Antidiskriminierung
  2026-09-15 17:00  Bezirksvertretung 5          2026-09-17 16:00  Anregungs- und Beschwerdeausschuss
  2026-09-18 14:00  Bezirksvertretung 1          2026-09-24 14:00  Rat (Stadtrat)
  2026-09-25 10:00  Seniorenrat
  2026-09-29 16:00  Ausschuss für Wirtschaftsförderung, internationale und regionale Zusammenarbeit
Keine Lizenz im Body angegeben (System nennt nur „Open"): mit Vorlagennummer zitieren, nicht massenhaft kopieren.
```

Als Nächstes angeboten: die Tagesordnung der Ratssitzung am 24.09.2026 oder eine Titelsuche über mehr Seiten.

## oparl-endpoint-finder

> Haben Bonn und Düsseldorf eine funktionierende OParl-Schnittstelle für ihr Ratsinformationssystem?

```bash
oparl endpoints --search "bonn" --compact
oparl system "https://www.bonn.sitzung-online.de/public/oparl/system" --compact   # Exit 1, auch beim zweiten Versuch: HTML-Seite
oparl endpoints --search "düsseldorf" --compact
oparl system "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl bodies "https://ris-oparl.itk-rheinland.de/Oparl/system" --compact
oparl get "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015" --compact
```

Das Verzeichnis führt Bonn noch als funktionierend, dieser Stand stammt aber vom Abruf am 17.01.2026;
live liefert die URL eine HTML-Seite. Den Düsseldorfer Eintrag schreibt das Verzeichnis „Dusseldorf",
die Suche mit Umlaut fand ihn trotzdem. Dieser Server bedient fünf Körperschaften, der Skill hat die
Düsseldorfer anhand des Namens ausgewählt.

```
Bonn – eingetragen, derzeit nicht erreichbar
  Verzeichnis: „Stadt Bonn", OParl 1.1, ALLRIS, beim letzten Abruf funktionierend (2026-01-17)
  System:      https://www.bonn.sitzung-online.de/public/oparl/system
  Live:        nein – liefert eine HTML-Seite statt OParl-JSON (Exit 1). Die Schnittstelle ist
               umgezogen oder abgeschaltet; im Ratsportal der Stadt nach einem neuen OParl-Link suchen.

Düsseldorf – funktioniert
  Verzeichnis: „Landeshauptstadt Dusseldorf", OParl 1.1, beim letzten Abruf funktionierend (2026-01-17)
  System:      https://ris-oparl.itk-rheinland.de/Oparl/system   (live geantwortet)
  Produkt:     Session von SOMACOS, OParl-Schnittstelle 1.6.0, betrieben von ITK Rheinland
  Body:        Stadt Duesseldorf (LHD)   https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015
               bei OParl seit 2025-04-30
  Listen:      organization, person, meeting, paper, membership, locationList, agendaItem,
               legislativeTermList, consultations, files
  Gleicher Server: Stadt Neuss (…/bodies/0009), Stadt Mönchengladbach (…/0011),
               Stadt Grevenbroich (…/0013), Rheinkreis Neuss (…/0019)
  Lizenz:      Das System gibt nur „Open" an (kein Lizenzname, keine URL), der Body gar keine.
               Eine Nutzung über das Lesen hinaus braucht die Erlaubnis des Betreibers.
```

Als Nächstes angeboten: aktuelle Vorlagen und Sitzungen der Düsseldorfer Körperschaft mit `oparl-council-activity`.
