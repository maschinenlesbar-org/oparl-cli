// Live answers of the OParl server of ITK Rheinland (Düsseldorf, Neuss and three more bodies;
// Session by SOMACOS, OParl 1.1) and of the endpoint registry at dev.oparl.org, recorded on
// 2026-11-20 between 01:16 and 01:20 CET, cut to a few objects and the fields the operations read.
// The meeting list's first page (200 meetings, ordered by internal id) is cut into three pages
// here, so that a walk over several pages can be tested; the papers are a page of the list with
// modified_since=2026-11-16. For the client's operation tests and the MCP server's tests.

import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";

export const DUS = "https://ris-oparl.itk-rheinland.de/Oparl";
export const DUS_SYSTEM_URL = `${DUS}/system`;
export const DUS_BODY_URL = `${DUS}/bodies/0015`;
export const REGISTRY = "https://dev.oparl.org/api/endpoints";

export const DUS_SYSTEM = {
  "id": "https://ris-oparl.itk-rheinland.de/Oparl/system",
  "type": "https://schema.oparl.org/1.1/System",
  "oparlVersion": "https://schema.oparl.org/1.1/",
  "otherOParlVersions": [],
  "license": "Open",
  "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies",
  "name": "Schnittstelle OParl 1.6",
  "contactEmail": "ris@itk-rheinland.de",
  "contactName": "Team Ratsinformationssystem der ITK-Rheinland",
  "website": "https://www.itk-rheinland.de",
  "vendor": "https://www.somacos.de?oparl=v1.6.0",
  "product": "Sitzungsmanagementsystem Session  Copyright SOMACOS GmbH & Co. KG",
  "created": "2025-04-22T00:00:00+02:00",
  "modified": "2025-04-22T00:00:00+02:00"
};

export const DUS_BODIES = {
  "data": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009",
      "type": "https://schema.oparl.org/1.1/Body",
      "system": "https://ris-oparl.itk-rheinland.de/Oparl/system",
      "shortName": "NE",
      "name": "Stadt Neuss",
      "website": "https://www.neuss.de",
      "licenseValidSince": "2025-04-30T00:00:00+02:00",
      "oparlSince": "2025-04-30T00:00:00+02:00",
      "equivalent": [
        ""
      ],
      "organization": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/organizations",
      "person": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/people",
      "meeting": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/meetings",
      "paper": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/papers",
      "membership": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/memberships",
      "locationList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/locations",
      "agendaItem": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/agendaitems",
      "legislativeTermList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/legislativeterms",
      "consultations": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/consultations",
      "files": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/files",
      "created": "2025-04-30T00:00:00+02:00",
      "modified": "2025-04-30T00:00:00+02:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "type": "https://schema.oparl.org/1.1/Body",
      "system": "https://ris-oparl.itk-rheinland.de/Oparl/system",
      "shortName": "LHD",
      "name": "Stadt Duesseldorf",
      "website": "https://www.duesseldorf.de",
      "licenseValidSince": "2025-04-30T00:00:00+02:00",
      "oparlSince": "2025-04-30T00:00:00+02:00",
      "equivalent": [
        ""
      ],
      "organization": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations",
      "person": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/people",
      "meeting": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
      "paper": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers",
      "membership": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/memberships",
      "locationList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations",
      "agendaItem": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/agendaitems",
      "legislativeTermList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/legislativeterms",
      "consultations": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/consultations",
      "files": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/files",
      "created": "2025-04-30T00:00:00+02:00",
      "modified": "2025-04-30T00:00:00+02:00"
    }
  ],
  "pagination": {
    "elementsPerPage": 200,
    "currentPage": 1
  },
  "links": {
    "first": "https://ris-oparl.itk-rheinland.de/Oparl/bodies",
    "self": "https://ris-oparl.itk-rheinland.de/Oparl/bodies"
  }
};

/** Düsseldorf, with three of its embedded legislative terms. */
export const DUS_BODY = {
  "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
  "type": "https://schema.oparl.org/1.1/Body",
  "system": "https://ris-oparl.itk-rheinland.de/Oparl/system",
  "shortName": "LHD",
  "name": "Stadt Duesseldorf",
  "website": "https://www.duesseldorf.de",
  "licenseValidSince": "2025-04-30T00:00:00+02:00",
  "oparlSince": "2025-04-30T00:00:00+02:00",
  "equivalent": [
    ""
  ],
  "organization": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations",
  "person": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/people",
  "meeting": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
  "paper": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers",
  "membership": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/memberships",
  "locationList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations",
  "agendaItem": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/agendaitems",
  "legislativeTermList": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/legislativeterms",
  "consultations": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/consultations",
  "files": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/files",
  "legislativeTerm": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/legislativeterms/8",
      "type": "https://schema.oparl.org/1.1/LegislativeTerm",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Alle",
      "startDate": "1990-01-01",
      "created": "2025-11-05T13:25:25+01:00",
      "modified": "2025-11-05T13:25:25+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/legislativeterms/7",
      "type": "https://schema.oparl.org/1.1/LegislativeTerm",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Wahlperiode 2025 - 2030",
      "startDate": "2025-11-01",
      "endDate": "2030-10-31",
      "created": "2025-09-02T08:45:46+02:00",
      "modified": "2025-09-02T09:07:56+02:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/legislativeterms/6",
      "type": "https://schema.oparl.org/1.1/LegislativeTerm",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Wahlperiode 2020 - 2025",
      "startDate": "2020-11-01",
      "endDate": "2025-10-31",
      "created": "2020-08-06T13:35:17+02:00",
      "modified": "2022-04-12T11:20:04+02:00"
    }
  ],
  "created": "2025-04-30T00:00:00+02:00",
  "modified": "2025-04-30T00:00:00+02:00"
};

/** Papers modified since 2026-11-16: new ones, two deleted stubs, and older papers only edited since. */
export const DUS_PAPERS = {
  "data": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114779",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Haushaltsantrag der Ratsfraktion DIE LINKE: Einrichtung eines kommunalen Klimabüros mit zwei Planstellen",
      "reference": "AUS/041/2026",
      "date": "2026-11-19",
      "paperType": "Haushaltsantrag Die Linke",
      "created": "2026-11-19T12:44:40+01:00",
      "modified": "2026-11-19T14:09:33+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114775",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "",
      "reference": "",
      "paperType": "",
      "deleted": true,
      "created": "2026-11-19T10:19:00+01:00",
      "modified": "2026-11-19T10:19:00+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114769",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Haushaltsantrag der Ratsfraktion SPD/Volt: Klimaneutralität 2035 - Klimaschutzprogramm strukturell absichern",
      "reference": "AUS/040/2026",
      "date": "2026-11-18",
      "paperType": "Haushaltsantrag SPD/Volt",
      "created": "2026-11-18T15:56:02+01:00",
      "modified": "2026-11-18T17:19:21+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114766",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Benötigte Mittel für die Sicherstellung des Sicherheitsdienstes im Rahmen des Stadtverträglichen Hilfenetzes",
      "reference": "AGS/104/2026",
      "date": "2026-11-18",
      "paperType": "Beschlussvorlage",
      "created": "2026-11-18T14:39:47+01:00",
      "modified": "2026-11-19T09:19:08+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114736",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "",
      "reference": "",
      "paperType": "",
      "deleted": true,
      "created": "2026-11-18T09:21:49+01:00",
      "modified": "2026-11-18T09:21:49+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114722",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Projektbeschluss Vogelsanger Weg 6 - Neubau von zwei Wohngebäuden mit einer Tiefgarage, einer Kindertagesstätte sowie von Gewerbeflächen im Erdgeschoss",
      "reference": "APS/115/2026",
      "date": "2026-11-18",
      "paperType": "Beschlussvorlage",
      "created": "2026-11-18T06:42:36+01:00",
      "modified": "2026-11-19T14:05:14+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114686",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Einrichtung eines verkehrsberuhigten Bereichs auf der Heidelberger Straße im Bereich des Skateparks Eller (Antrag Fraktion Liste Zukunft 08)",
      "reference": "BV8/249/2026",
      "date": "2026-11-16",
      "paperType": "Antrag",
      "created": "2026-11-16T12:41:36+01:00",
      "modified": "2026-11-16T12:45:08+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114685",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Mitnutzung der Traglufthalle auf dem Schützenplatz Eller durch weitere Schulen im Stadtbezirk (Anfrage Fraktion Liste Zukunft 08)",
      "reference": "BV8/248/2026",
      "date": "2026-11-16",
      "paperType": "Anfrage",
      "created": "2026-11-16T12:36:57+01:00",
      "modified": "2026-11-16T12:39:35+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114615",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Erweiterungsbeschluss zum Grundsatzbeschluss zur Umsetzung von feuerwehrorganisatorischen Maßnahmen ab 2024 – Feuerwehrorganisatorische Maßnahmen I (FOM I) (BAU/009/2024)",
      "reference": "AÖE/081/2026",
      "date": "2026-11-13",
      "paperType": "Beschlussvorlage",
      "created": "2026-11-13T09:12:45+01:00",
      "modified": "2026-11-17T13:43:24+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114430",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Baumbilanz 2026",
      "reference": "AÖE/076/2026",
      "date": "2026-11-09",
      "paperType": "Informationsvorlage",
      "created": "2026-11-06T10:00:56+01:00",
      "modified": "2026-11-16T12:35:13+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114246",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Haushaltsberatung 2027/2028: Entwurf des Doppischen Produkthaushaltes 2027/2028, bezirksbezogene Ansätze 2027/2028",
      "reference": "KUA/146/2026",
      "date": "2026-10-23",
      "paperType": "Beschlussvorlage",
      "created": "2026-10-22T14:02:19+02:00",
      "modified": "2026-11-18T13:07:28+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/114043",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Sitzungstermine 2027",
      "reference": "SENR/009/2026",
      "date": "2026-10-14",
      "paperType": "Informationsvorlage",
      "created": "2026-10-01T14:23:07+02:00",
      "modified": "2026-11-19T10:28:39+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/113642",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Tempo 30 Corneliusstraße",
      "reference": "ABA/039/2026",
      "date": "2026-09-07",
      "paperType": "Eingabe nach 24 GO",
      "created": "2026-09-07T13:08:45+02:00",
      "modified": "2026-11-18T10:42:37+01:00"
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers/vo/112925",
      "type": "https://schema.oparl.org/1.1/Paper",
      "body": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015",
      "name": "Umsetzung Beschluss BV9/133/2022 – Ampelschaltung Kölner Landstraße                                - Anfrage von Frau Hümmerich, Frau Labohm-Romeiß und Herrn Gencer; CDU",
      "reference": "BV9/143/2026",
      "date": "2026-06-22",
      "paperType": "Anfrage",
      "created": "2026-06-22T10:06:47+02:00",
      "modified": "2026-11-16T08:02:22+01:00"
    }
  ],
  "pagination": {
    "elementsPerPage": 200,
    "currentPage": 1
  },
  "links": {
    "first": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers?modified_since=2026-11-16T00:00:00+01:00",
    "self": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers?modified_since=2026-11-16T00:00:00+01:00"
  }
};

export const DUS_MEETINGS_1 = {
  "data": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/31309",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Bezirksvertretung 1",
      "start": "2027-12-03T14:00:00+01:00",
      "end": "2027-12-03T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/32"
      ],
      "created": "2026-11-02T12:12:16+01:00",
      "modified": "2026-11-02T12:12:24+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200004",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Sitzungssaal 1. OG",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/31198",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Bezirksvertretung 4",
      "start": "2027-12-15T15:00:00+01:00",
      "end": "2027-12-15T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/35"
      ],
      "created": "2026-10-15T08:32:19+02:00",
      "modified": "2026-10-15T08:32:19+02:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/si/31198",
        "type": "https://schema.oparl.org/1.1/Location"
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/30062",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Ausschuss für Chancengerechtigkeit und Integration",
      "start": "2026-11-23T15:00:00+01:00",
      "end": "2026-11-23T17:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/400237"
      ],
      "created": "2026-02-10T16:40:59+01:00",
      "modified": "2026-11-17T10:22:58+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200004",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Sitzungssaal 1. OG",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29818",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Rat",
      "start": "2026-11-12T14:00:00+01:00",
      "end": "2026-11-12T18:29:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/6"
      ],
      "created": "2025-12-17T14:19:17+01:00",
      "modified": "2026-11-17T16:23:26+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29799",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Jugendhilfeausschuss",
      "start": "2026-11-18T14:00:00+01:00",
      "end": "2026-11-18T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/22"
      ],
      "created": "2025-12-16T13:09:21+01:00",
      "modified": "2026-11-17T11:57:40+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200004",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Sitzungssaal 1. OG",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29758",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Bauausschuss",
      "start": "2026-11-24T15:00:00+01:00",
      "end": "2026-11-24T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/17"
      ],
      "created": "2025-12-15T12:49:42+01:00",
      "modified": "2026-11-17T14:59:17+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200004",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Sitzungssaal 1. OG",
        "streetAddress": "",
        "locality": ""
      }
    }
  ],
  "pagination": {
    "elementsPerPage": 200,
    "currentPage": 1
  },
  "links": {
    "first": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
    "self": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
    "next": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=2"
  }
};

export const DUS_MEETINGS_2 = {
  "data": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29737",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Bezirksvertretung 10",
      "start": "2026-11-24T17:00:00+01:00",
      "end": "2026-11-24T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/41"
      ],
      "created": "2025-12-15T09:57:33+01:00",
      "modified": "2026-11-12T15:29:59+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/si/29737",
        "type": "https://schema.oparl.org/1.1/Location"
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29729",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Schulausschuss",
      "start": "2026-11-17T15:00:00+01:00",
      "end": "2026-11-17T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/28"
      ],
      "created": "2025-12-12T12:58:05+01:00",
      "modified": "2026-11-18T07:43:24+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29675",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Kulturausschuss",
      "start": "2026-11-26T15:00:00+01:00",
      "end": "2026-11-26T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/24"
      ],
      "created": "2025-12-08T08:01:15+01:00",
      "modified": "2026-11-18T15:14:02+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29646",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Ausschuss für Gesundheit und Soziales",
      "start": "2026-11-24T14:00:00+01:00",
      "end": "2026-11-24T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/9"
      ],
      "created": "2025-12-04T14:57:01+01:00",
      "modified": "2026-11-16T13:12:39+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/29584",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Ausschuss für Umwelt-, Klima- und Verbraucherschutz",
      "start": "2026-11-19T15:00:00+01:00",
      "end": "2026-11-19T17:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/400214"
      ],
      "created": "2025-12-01T14:37:30+01:00",
      "modified": "2026-11-17T13:56:17+01:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    }
  ],
  "pagination": {
    "elementsPerPage": 200,
    "currentPage": 2
  },
  "links": {
    "first": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
    "self": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=2",
    "next": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3"
  }
};

/** Only past meetings: a walk for upcoming ones stops after it (page 4 is never asked for). */
export const DUS_MEETINGS_3 = {
  "data": [
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/31199",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "öffentliche/nicht öffentliche Sitzung des Ausschusses für Chancengerechtigkeit und Integration",
      "start": "2026-10-19T00:00:00+02:00",
      "end": "2026-10-19T00:00:00+02:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/400237"
      ],
      "created": "2026-10-19T11:14:41+02:00",
      "modified": "2026-10-19T11:14:41+02:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200004",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Sitzungssaal 1. OG",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/30897",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "gemeinsame Sitzung Ausschuss für Planung und Stadtentwicklung und Bezirksvertretung 1",
      "start": "2026-09-09T17:03:00+02:00",
      "end": "2026-09-09T17:39:00+02:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/11",
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/32"
      ],
      "created": "2026-08-03T11:30:28+02:00",
      "modified": "2026-09-28T12:42:50+02:00",
      "location": {
        "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/locations/rm/200003",
        "type": "https://schema.oparl.org/1.1/Location",
        "room": "Rathaus - Plenarsaal",
        "streetAddress": "",
        "locality": ""
      }
    },
    {
      "id": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings/30103",
      "type": "https://schema.oparl.org/1.1/Meeting",
      "name": "Eingereichte Haushaltsanträge zu den Etatberatungen 2026\r\n(Hier sind die eingereichten Haushaltsanträge zur Ratssitzung am 19.03.2026 aufgeführt. Es handelt sich um keine eigene Sitzung.)",
      "start": "2026-03-19T00:00:00+01:00",
      "end": "2026-03-19T00:00:00+01:00",
      "organization": [
        "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/organizations/gr/400224"
      ],
      "created": "2026-02-18T11:28:43+01:00",
      "modified": "2026-11-09T12:04:49+01:00"
    }
  ],
  "pagination": {
    "elementsPerPage": 200,
    "currentPage": 3
  },
  "links": {
    "first": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings",
    "self": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=3",
    "next": "https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/meetings?page=4"
  }
};

/** The registry's first page, cut to five entries (Düsseldorf, Bad Münstereifel twice, Bonn, Köln). */
export const REGISTRY_PAGE = {
  "data": [
    {
      "id": 73,
      "title": "Landeshauptstadt Dusseldorf",
      "url": "https://ris-oparl.itk-rheinland.de/Oparl/system",
      "system": {
        "id": "http://ris-oparl.itk-rheinland.de/Oparl/system",
        "type": "https://schema.oparl.org/1.1/System",
        "oparlVersion": "https://schema.oparl.org/1.1/",
        "otherOParlVersions": [],
        "license": "Open",
        "body": "http://ris-oparl.itk-rheinland.de/Oparl/bodies",
        "name": "Schnittstelle OParl 1.6",
        "contactEmail": "ris@itk-rheinland.de",
        "contactName": "Team Ratsinformationssystem der ITK-Rheinland",
        "website": "https://www.itk-rheinland.de",
        "vendor": "https://www.somacos.de?oparl=v1.6.0",
        "product": "Sitzungsmanagementsystem Session  Copyright SOMACOS GmbH & Co. KG",
        "created": "2025-04-22T00:00:00+02:00",
        "modified": "2025-04-22T00:00:00+02:00"
      },
      "bodyCount": 0,
      "wikidata": "Q1718",
      "fetched": "2026-01-17T01:05:04+01:00"
    },
    {
      "id": 222,
      "title": "Stadt Bad Munstereifel",
      "url": "https://sdnetrim.kdvz-frechen.de/rim4500/webservice/oparl/v1.1/system",
      "system": {
        "id": "https://sdnetrim.kdvz-frechen.de/rim4500/webservice/oparl/v1.1/system",
        "type": "https://schema.oparl.org/1.1/System",
        "oparlVersion": "https://schema.oparl.org/1.1/",
        "body": "https://sdnetrim.kdvz-frechen.de/rim4500/webservice/oparl/v1.1/body",
        "name": "SD.NET RIM",
        "contactEmail": "info@sternberg24.de",
        "contactName": "STERNBERG Software GmbH & Co. KG",
        "website": "https://www.ratsinfomanagement.net/",
        "vendor": "https://www.sitzungsdienst.net/",
        "product": "https://www.sitzungsdienst.net/gremieninformationssystem/#oparl",
        "STERNBERG:RIMVersion": "25.4.1"
      },
      "bodyCount": 0,
      "wikidata": "Q241450",
      "fetched": "2026-01-17T01:04:21+01:00"
    },
    {
      "id": 223,
      "title": "Stadt Bad Münstereifel",
      "url": "https://ratsinfo.bad-muenstereifel.de/webservice/oparl/v1.1/system",
      "system": {
        "id": "https://ratsinfo.bad-muenstereifel.de/webservice/oparl/v1.1/system",
        "type": "https://schema.oparl.org/1.1/System",
        "oparlVersion": "https://schema.oparl.org/1.1/",
        "body": "https://ratsinfo.bad-muenstereifel.de/webservice/oparl/v1.1/body",
        "name": "SD.NET RIM",
        "contactEmail": "info@sternberg24.de",
        "contactName": "STERNBERG Software GmbH & Co. KG",
        "website": "https://www.ratsinfomanagement.net/",
        "vendor": "https://www.sitzungsdienst.net/",
        "product": "https://www.sitzungsdienst.net/gremieninformationssystem/#oparl",
        "STERNBERG:RIMVersion": "25.4.1"
      },
      "bodyCount": 0,
      "wikidata": "Q241450",
      "fetched": "2026-01-17T01:04:21+01:00"
    },
    {
      "id": 69,
      "title": "Stadt Bonn",
      "url": "https://www.bonn.sitzung-online.de/public/oparl/system",
      "system": {
        "id": "https://www.bonn.sitzung-online.de/public/oparl/system",
        "type": "https://schema.oparl.org/1.1/System",
        "oparlVersion": "https://schema.oparl.org/1.1/",
        "license": "https://opendata.bonn.de/seiten/nutzungsbedingungen",
        "body": "https://www.bonn.sitzung-online.de/public/oparl/bodies",
        "name": "ALLRIS OParl der Stadt Bonn",
        "contactEmail": "info@cc-egov.de",
        "contactName": "CC e-gov GmbH",
        "website": "https://www.bonn.sitzung-online.de/public/",
        "vendor": "https://www.cc-egov.de",
        "product": "https://cc-egov.de/de-de/produkte/allris",
        "created": "2026-01-17T01:05:03+01:00",
        "modified": "2026-01-17T01:05:03+01:00",
        "web": "https://www.bonn.sitzung-online.de/public/",
        "deleted": false
      },
      "bodyCount": 1,
      "wikidata": "Q586",
      "fetched": "2026-01-17T01:05:03+01:00"
    },
    {
      "id": 78,
      "title": "Stadt Köln",
      "url": "https://buergerinfo.stadt-koeln.de/oparl/system",
      "system": {
        "id": "https://buergerinfo.stadt-koeln.de/oparl/system",
        "type": "https://schema.oparl.org/1.1/System",
        "oparlVersion": "https://schema.oparl.org/1.1/",
        "otherOParlVersions": [],
        "body": "https://buergerinfo.stadt-koeln.de/oparl/bodies",
        "name": "Stadt Köln - OParl 1.1",
        "contactEmail": "12-session@stadt-koeln.de",
        "contactName": "Stadt Köln | Amt für Digitalisierung und Informationstechnik",
        "website": "https://buergerinfo.stadt-koeln.de/",
        "vendor": "https://www.somacos.de?oparl=v1.6.1",
        "product": "Sitzungsmanagementsystem Session  Copyright SOMACOS GmbH & Co. KG",
        "created": "2025-10-08T00:00:00+02:00",
        "modified": "2025-10-08T11:00:00+02:00"
      },
      "bodyCount": 0,
      "wikidata": "Q365",
      "fetched": "2026-01-17T01:05:03+01:00"
    }
  ],
  "meta": {
    "page": 1,
    "total": 5,
    "totalPages": 1,
    "perPage": 100
  }
};

/**
 * A mock of the recorded servers by path (the query aside, but for the meeting pages), on any
 * host: the MCP tests point at a loopback mock. Anything else is a 404 with an OParl error object.
 */
export function oparlAnswer(request: HttpRequest): HttpResponse {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/endpoints") return jsonResponse(REGISTRY_PAGE);
  if (path === "/Oparl/system") return jsonResponse(DUS_SYSTEM);
  if (path === "/Oparl/bodies") return jsonResponse(DUS_BODIES);
  if (path === "/Oparl/bodies/0015") return jsonResponse(DUS_BODY);
  if (path === "/Oparl/bodies/0015/papers") return jsonResponse(DUS_PAPERS);
  if (path === "/Oparl/bodies/0015/meetings") {
    const pages: Record<string, unknown> = { "1": DUS_MEETINGS_1, "2": DUS_MEETINGS_2, "3": DUS_MEETINGS_3 };
    const answer = pages[url.searchParams.get("page") ?? "1"];
    if (answer !== undefined) return jsonResponse(answer);
  }
  const paper = DUS_PAPERS.data.find((p) => new URL(p.id).pathname === path);
  if (paper !== undefined) return jsonResponse(paper);
  return jsonResponse({ type: "https://schema.oparl.org/1.1/Error", message: "Not found" }, 404);
}

/** A mock transport answering as the recorded servers do (oparlAnswer). */
export function oparlApi(): MockTransport {
  return makeMockTransport(oparlAnswer);
}
