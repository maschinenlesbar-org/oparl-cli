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

**Endpoint-Verzeichnis.** Die öffentliche Liste der OParl-Server unter
`https://dev.oparl.org/api/endpoints`. Sie speichert das System-Objekt jedes Servers aus
dem letzten Abruf (`fetched`) und wird selten aktualisiert. Einige Einträge sind Duplikate
oder Aggregatoren (Politik bei Uns, München Transparent).

**Gepflegte Endpoint-Liste (`endpoints`, `--source`).** Wird mit diesem Tool ausgeliefert:
OParl-Server, die im Verzeichnis fehlen, und eine Live-Prüfung jedes Verzeichniseintrags.
`oparl endpoints` listet beides (`source`: `registry` oder `curated`). `checked` ist der Tag
der letzten Prüfung, `working` ihr Ergebnis, `problem` der Grund für einen Fehlschlag und
`replacedBy` die neue URL eines umgezogenen Servers. Die Maintainer aktualisieren die Liste
mit `npm run check-endpoints`; ein fehlschlagender Endpunkt wird zweimal geprüft, bevor er als
nicht erreichbar gilt. `--search` durchsucht Titel, URL und Notiz, ohne Rücksicht auf Groß- und
Kleinschreibung oder Akzente, und greift nur dann auf die Umlautschreibweisen zurück
(`koeln` → `Köln`), wenn buchstäblich nichts passt. Ist das Verzeichnis nicht erreichbar, listet `endpoints` nur
die gepflegten Einträge und weist auf stderr darauf hin.

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
Listen-URL; `list legislative-term` gibt dann die eingebetteten Wahlperioden mit `pages: 0` aus
und wendet die Datumsfilter lokal an. Eine Wahlperiode ohne `created`/`modified` lässt sich
nicht filtern, wird also ausgegeben, und das `note` im Ergebnis weist darauf hin.

## Listen und Paginierung

**Objektliste / Seite.** Eine Liste wird seitenweise ausgeliefert: `data` (die Objekte),
`pagination` (optionale Zählwerte) und `links` (`first`, `self`, `last` sowie `next` auf
jeder Seite außer der letzten). `oparl list` folgt `next`; das `next` im Ergebnis zeigt, wo
es aufgehört hat. Eine Seite, deren `data` etwas anderes als Objekte enthält, wird
abgelehnt; ein Server, der auf eine Listen-URL ein bloßes JSON-Array statt einer Seite
antwortet (ein SD.NET-Build in Essen), wird als einzelne Seite gelesen.

**Filter.** OParl definiert für Listen `created_since`, `created_until`, `modified_since`,
`modified_until`, `limit` und `omit_internal` (`--modified-since` …). Server sollen die
Datumsfilter unterstützen, manche ignorieren sie jedoch oder scheitern daran. SD.NET-RIM-Server
antworten auf ein Datumsfenster ohne Objekte mit HTTP 404 – die CLI endet dann mit `4`
(„nicht gefunden"), obwohl die Liste existiert; wiederholen Sie den Aufruf ohne Filter, um
beides zu unterscheiden. Jeder Filter geht genau einmal mit dem von Ihnen angegebenen Wert
hinaus: Er ersetzt die Kopie des Servers in einer Listen-URL oder einem `next`-Link und
wird auch auf dem Ziel einer Weiterleitung erneut gesetzt, sodass jede Seite gleich
gefiltert ist.

**Gelöschte Objekte (`deleted: true`).** Server dürfen gelöschte Objekte, markiert als
`deleted`, in Listen behalten, damit synchronisierende Clients sie entfernen können. Manche
Server zeigen sie nur mit `modified_since`, und da `oparl list` bei einer wiederholten `id`
die *letzte* Kopie behält, gewinnt ein Grabstein-Eintrag auf einer späteren Seite gegenüber
der lebenden Kopie auf einer früheren.

**Seitenschleife (`looped`).** Ein Server, dessen `next`-Link auf eine bereits abgerufene
Seite zurückführt oder der immer weitere Seiten liefert, die nichts hinzufügen – dieselbe
Seite oder eine leere unter immer neuen `?page=n`-Links. Das Durchlaufen endet nach drei
solchen Seiten in Folge (bei einem Link zurück sofort), listet jedes Objekt einmal und setzt
`looped: true`. Nach Seiten, die nichts hinzufügten, behält es das `next` des Servers, damit
die Liste von Hand weitergeführt werden kann; nach einem Link zurück auf eine abgerufene Seite
ist `next` `null`, denn dieser Link führt nur erneut im Kreis. Warum drei: Eine
Seite, die Objekte wiederholt, sieht genauso aus wie ein Eintrag, der während des
Durchlaufens in die Liste eingefügt wurde.

**Durchlauf-Hinweis (`note`).** Ein Satz im Ergebnis von `list`/`bodies`, ebenfalls auf
stderr ausgegeben: Er nennt den Grund, aus dem das Durchlaufen vor dem Ende der Liste endete
(eine Seitenschleife, ein `next`-Link oder eine Weiterleitung, der die CLI nicht folgt, oder
eine spätere Seite, deren Abruf scheiterte), oder welcher Filter nicht angewendet werden
konnte. Scheitert eine Seite nach der ersten, werden die zuvor abgerufenen Seiten mit einem
solchen Hinweis und `next` auf der gescheiterten Seite ausgegeben, danach endet der Befehl
mit dem Fehler.

## Dieses Tool

**Same-Host-Regel.** Links (`next`, Listen-URLs) und Weiterleitungen werden nur auf dem Host
verfolgt, von dem sie stammen; ein `http:`-Link auf einem `https:`-Server wird hochgestuft.
Alles andere bricht mit „Refusing to follow …“ ab. Dieselbe Hochstufung gilt für die Ausgabe:
In einer über https abgerufenen Antwort werden `http://`-URLs auf diesem Host als `https://`
angezeigt, sodass IDs, die Sie an `list` oder `get` zurückgeben, verschlüsselt bleiben. Ein
relativer Link (`"body": "bodies"`) wird gegen die URL aufgelöst, von der die Antwort
tatsächlich kam – nach einer Weiterleitung also gegen ihr Ziel und nicht gegen die URL, mit
der die Anfrage begann.

**Servertext in Meldungen.** Alles, was ein Server sendet und in einer Fehlermeldung landet –
der `type` eines Objekts, eine Fehlermeldung, ein Link, ein Content-Type –, wird zuvor von
Steuerzeichen befreit, auf eine Zeile gefaltet und auf 200 Zeichen gekürzt. Ein bösartiger
oder manipulierter Endpoint könnte sonst Terminal-Escape-Sequenzen (Fenstertitel, Farben,
Bildschirm löschen) ausführen lassen oder eine `Error:`-Zeile der CLI vortäuschen. In der
JSON-Ausgabe werden dieselben Zeichen stattdessen escaped, sodass nichts verloren geht.

**`pages` / `next` (Ausgabe von `list`).** Wie viele Seiten abgerufen wurden, und der Link zum
Weitermachen – vorhanden, wann immer die letzte abgerufene Seite einen anbot, `null` am Ende
der Liste und dann, wenn der Link in eine Schleife zurückführt.
