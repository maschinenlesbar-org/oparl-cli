# Glossar

Die OParl-Objekte und -Begriffe, denen Sie bei der Arbeit mit `oparl` begegnen. Die Referenz
der Optionen finden Sie in der **[README](README.md)**, Rezepte in **[Usage.md](Usage.md)**.

## Der Standard

**OParl.** Ein offener Standard für den lesenden Zugriff auf Ratsinformationssysteme (RIS)
in Deutschland – die Systeme, mit denen Kommunen Sitzungen, Tagesordnungen, Anträge und
Beschlüsse veröffentlichen. Gepflegt von der OKF Deutschland und Vitako; aktuelle Version
**1.1** (2018), abwärtskompatibel zu **1.0** (2016). Spezifikation:
<https://oparl.org/spezifikation/>.

**Ratsinformationssystem (RIS).** Die Software hinter dem öffentlichen Portal eines Rats.
Verbreitete Produkte mit OParl-Unterstützung: SD.NET RIM (Sternberg), Session/SessionNet
(Somacos), more! rubin, ALLRIS (CC e-gov).

**Endpoint-Verzeichnis (`endpoints`).** Die öffentliche Liste der OParl-Server unter
`https://dev.oparl.org/api/endpoints`. Sie speichert das System-Objekt jedes Servers aus
dem letzten Abruf: `working` gibt an, ob dieser Abruf erfolgreich war, `fetched`, wann er
stattfand. Einige Einträge sind Duplikate oder Aggregatoren (Politik bei Uns, München Transparent).

**Objekttyp-URI (`type`).** Jedes OParl-Objekt hat einen `type`, z. B.
`https://schema.oparl.org/1.1/Meeting`; an der Version im Pfad erkennen Sie 1.0 oder 1.1.

**Objekt-ID (`id`).** Die eigene URL jedes Objekts. Objekte verweisen über diese URLs
aufeinander – folgen Sie ihnen mit `oparl get <id>`.

## Die Objekte

**System (`system`).** Der Einstiegspunkt eines Servers: `oparlVersion`, `vendor`, `product`
und `body`, die URL der Liste der Körperschaften.

**Body (`bodies`) – *Körperschaft*.** Eine Organisation, die auf dem Server Ratsarbeit
führt, meist eine Gemeinde oder ein Kreis (`name`, `ags` – der Amtliche Gemeindeschlüssel).
Eine Körperschaft verlinkt ihre Objektlisten: `organization`, `person`, `meeting`, `paper`
und, in 1.1, `agendaItem`, `consultation`, `file`, `membership`, `locationList`,
`legislativeTermList`.

**Organization (`list organization`) – *Gremium*.** Ein Rat, ein Ausschuss, eine
Bezirksvertretung, eine *Fraktion* oder eine Verwaltungseinheit. `classification` benennt
die Art.

**Person (`list person`).** Ein Ratsmitglied oder eine andere Person mit einer Rolle; siehe
Membership. Personenbezogene Daten – siehe DATA_LICENSE.md.

**Membership (`list membership`) – *Mitgliedschaft*.** Die Mitgliedschaft einer Person in
einer Organisation, mit `role`, `startDate`, `endDate` und `votingRight`.

**Meeting (`list meeting`) – *Sitzung*.** Eine Sitzung einer oder mehrerer Organisationen:
`name`, `start`, `end`, `location`, `cancelled`, die `agendaItem`-Liste und Protokolldateien.

**AgendaItem (`list agenda-item`) – *Tagesordnungspunkt (TOP)*.** Ein Punkt der
Tagesordnung einer Sitzung: `number`, `name`, `public`, `result`, die `consultation`, zu der
er gehört.

**Paper (`list paper`) – *Drucksache / Vorlage*.** Ein Dokument, mit dem sich der Rat
befasst – eine *Beschlussvorlage* der Verwaltung, ein *Antrag*, eine *Anfrage*:
`reference` (die Drucksachennummer), `name`, `date`, `paperType`,
`mainFile`, `auxiliaryFile` und die zugehörigen `consultation`s.

**Consultation (`list consultation`) – *Beratung*.** Die Behandlung einer Drucksache in
einer bestimmten Sitzung und Organisation, mit `role` (z. B. *Entscheidung*, *Vorberatung*)
und `authoritative`.

**File (`list file`) – *Datei*.** Ein Dokument, das an einer Drucksache oder Sitzung hängt:
`fileName`, `mimeType`, `accessUrl`, `downloadUrl`. Diese CLI gibt nur Dateimetadaten aus;
sie lädt keine Dateien herunter.

**Location (`list location`) – *Ort*.** Eine Adresse oder ein Raum, oft in Sitzungen eingebettet.

**LegislativeTerm (`list legislative-term`) – *Wahlperiode*.** Eine Wahlperiode des Rats mit
`startDate` und `endDate`. Körperschaften in OParl 1.0 betten diese als Array ein statt als
Listen-URL; `list legislative-term` gibt dann die eingebetteten Wahlperioden mit `pages: 0` aus.

## Listen und Paginierung

**Objektliste / Seite.** Eine Liste wird seitenweise ausgeliefert: `data` (die Objekte),
`pagination` (optionale Zählwerte) und `links` (`first`, `self`, `last` sowie `next` auf
jeder Seite außer der letzten). `oparl list` folgt `next`; das `next` im Ergebnis zeigt, wo
es aufgehört hat.

**Filter.** OParl definiert für Listen `created_since`, `created_until`, `modified_since`,
`modified_until`, `limit` und `omit_internal` (`--modified-since` …). Server sollen die
Datumsfilter unterstützen, manche ignorieren sie jedoch oder scheitern daran.

**Gelöschte Objekte (`deleted: true`).** Server dürfen gelöschte Objekte, markiert als
`deleted`, in Listen behalten, damit synchronisierende Clients sie entfernen können.

## Dieses Tool

**Same-Host-Regel.** Links (`next`, Listen-URLs) und Weiterleitungen werden nur auf dem Host
verfolgt, von dem sie stammen; ein `http:`-Link auf einem `https:`-Server wird hochgestuft.
Alles andere bricht mit „Refusing to follow …“ ab. Dieselbe Hochstufung gilt für die Ausgabe:
In einer über https abgerufenen Antwort werden `http://`-URLs auf diesem Host als `https://`
angezeigt, sodass IDs, die Sie an `list` oder `get` zurückgeben, verschlüsselt bleiben.

**`pages` / `next` (Ausgabe von `list`).** Wie viele Seiten abgerufen wurden, und der Link zum Weitermachen.
