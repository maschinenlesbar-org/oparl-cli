// The curated OParl endpoint list, maintained with scripts/check-endpoints.mjs.
//
// CURATED_ENDPOINTS: OParl servers the public registry at dev.oparl.org doesn't list.
// REGISTRY_CHECKS: live checks of the registry's own entries (the registry is rarely
// updated), with the new URL of servers that moved.
//
// `npm run check-endpoints` re-checks every endpoint and rewrites this file. To add an
// endpoint, append { title, url, note } plus the other fields (null/false/"") to
// CURATED_ENDPOINTS and run it. `note` and `replacedBy` are kept as written.

import type { CuratedEndpoint, RegistryCheck } from "./types.js";

export const CURATED_ENDPOINTS: readonly CuratedEndpoint[] = [
  {
    "title": "Regionalrat Köln",
    "url": "https://bezreg-koeln.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Bremische Bürgerschaft",
    "url": "https://sd.bremische-buergerschaft.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": "The Landtag of Bremen, also sitting as the city council (Stadtbürgerschaft). The only state parliament with OParl found so far."
  },
  {
    "title": "BVV Mitte (Berlin)",
    "url": "https://www.sitzungsdienst-mitte.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "BVV Mitte",
    "vendor": "http://cc-egov.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "BVV Charlottenburg-Wilmersdorf (Berlin)",
    "url": "https://www.sitzungsdienst-charlottenburg-wilmersdorf.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "BVV Charlottenburg-Wilmersdorf",
    "vendor": "http://cc-egov.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "BVV Friedrichshain-Kreuzberg (Berlin)",
    "url": "https://www.sitzungsdienst-friedrichshain-kreuzberg.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "BVV Friedrichshain-Kreuzberg",
    "vendor": "http://cc-egov.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "BVV Neukölln (Berlin)",
    "url": "https://www.sitzungsdienst-neukoelln.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "BVV Neukölln",
    "vendor": "http://cc-egov.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "BVV Tempelhof-Schöneberg (Berlin)",
    "url": "https://www.sitzungsdienst-tempelhof-schoeneberg.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "BVV Tempelhof-Schöneberg",
    "vendor": "http://cc-egov.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Biblis",
    "url": "https://rim.ekom21.de/biblis/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Grafschaft",
    "url": "https://grafschaft.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Rats- und Bürgerinfosystem Grafschaft\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Kernen im Remstal",
    "url": "https://kernen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Lahnau",
    "url": "https://rim.ekom21.de/lahnau/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Nordstemmen",
    "url": "https://nordstemmen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Gemeinde Ranstadt",
    "url": "https://rim.ekom21.de/ranstadt/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "kleineAnfragen (Archiv)",
    "url": "https://api.kleineanfragen.de/oparl/v1",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "kleineAnfragen",
    "vendor": null,
    "bodyCount": 17,
    "note": "Archive of Kleine Anfragen to the Bundestag and the Landtage (kleineanfragen.de), not a council information system."
  },
  {
    "title": "Kreis Recklinghausen",
    "url": "https://kvrecklinghausen.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Bürgerinformationssystem\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Kreis Wesel",
    "url": "https://kis.kreis-wesel.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Kreisstadt Mettmann",
    "url": "https://mettmann.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Bürgerinformationssystem Kreisstadt Mettmann\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Landeshauptstadt Magdeburg",
    "url": "https://ratsinfo.magdeburg.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Schnittstelle OParl 1.1",
    "vendor": "https://www.somacos.de?oparl=v1.5.3",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Landeshauptstadt Potsdam",
    "url": "https://www.potsdam.sitzung-online.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Landeshauptstadt Potsdam",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 2,
    "note": null
  },
  {
    "title": "Landeshauptstadt Schwerin",
    "url": "https://oparl.schwerin.de/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Schnittstelle OParl 1.4",
    "vendor": "https://www.somacos.de?oparl=v1.5.4",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Landkreis Esslingen",
    "url": "https://eslra-sitzungsdienst.komm.one/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Schnittstelle OParl 1.6.1",
    "vendor": "https://www.somacos.de?oparl=v1.6.1",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Landkreis Limburg-Weilburg",
    "url": "https://rim.ekom21.de/limburg-weilburg/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "OWL-IT (Rechenzentrum)",
    "url": "https://sessionnet-oparl.owl-it.de/Oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Schnittstelle OParl 1.0",
    "vendor": "https://www.somacos.de?oparl=v1.6.2",
    "bodyCount": 27,
    "note": "Shared server of the data centre OWL-IT. Most of its bodies are named only by a number (e.g. 0529). Its bodies list serves the same page under every ?page=n link; the CLI stops at the repeat."
  },
  {
    "title": "Regionalrat Münster",
    "url": "https://www.regionalrat-muenster.nrw.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Regionalverband Ruhr",
    "url": "https://ruhrparlament.de/oparl",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Bürger-Informationssystem des Ruhrparlaments\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Aachen",
    "url": "https://ratsinfo.aachen.de/public/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Stadt Aachen",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Augsburg",
    "url": "https://www.augsburg.sitzung-online.de/public/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Stadt Augsburg",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Bochum",
    "url": "https://bochum.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Braunschweig",
    "url": "https://www.ratsinfo.braunschweig.sitzung-online.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Stadt Musterstadt",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Essen",
    "url": "https://ris.essen.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Gladenbach",
    "url": "https://rim.ekom21.de/gladenbach/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Hamm",
    "url": "https://ratsinfo.hamm.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Heidelberg",
    "url": "https://oparl.heidelberg.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Stadt Heidelberg - Schnittstelle OParl",
    "vendor": "https://www.somacos.de?oparl=v1.6.1",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Heilbronn",
    "url": "https://heilbronn-sitzungsdienst.komm.one/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Schnittstelle OParl 1.6.1",
    "vendor": "https://www.somacos.de?oparl=v1.6.1",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Ingelheim am Rhein",
    "url": "https://ingelheim.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Rats- und Bürgerinfosystem\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 4,
    "note": null
  },
  {
    "title": "Stadt Kaiserslautern",
    "url": "https://ris.kaiserslautern.de/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "TLS certificate not verifiable",
    "oparlVersion": "1.1",
    "systemName": null,
    "vendor": null,
    "bodyCount": null,
    "note": "The server doesn't send its intermediate TLS certificate, so Node.js can't verify it. Browsers fetch the missing certificate themselves; see Usage.md, Troubleshooting."
  },
  {
    "title": "Stadt Karlsruhe",
    "url": "https://web2.karlsruhe.de/ris/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "Stadt Karlsruhe",
    "vendor": "https://www.somacos.de?oparl=v1.6.1",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Kleve",
    "url": "https://ris.kleve.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Langenhagen",
    "url": "https://www.langenhagen.sitzung-online.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Stadt Langenhagen",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Moers",
    "url": "https://ris.moers.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Oberhausen",
    "url": "https://ratsinfo.oberhausen.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Stadt Oberhausen",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Osnabrück",
    "url": "https://www.osnabrueck.sitzung-online.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "ALLRIS OParl der Stadt Osnabrück",
    "vendor": "https://www.cc-egov.de",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Rüsselsheim am Main",
    "url": "https://rim.ekom21.de/ruesselsheim/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Stadt Zell am Harmersbach",
    "url": "https://zell.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.1",
    "systemName": "SD.NET RIM",
    "vendor": "https://www.sitzungsdienst.net/",
    "bodyCount": 1,
    "note": null
  },
  {
    "title": "Verbandsgemeinde Rhein-Selz",
    "url": "https://rhein-selz.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Rats- und Bürgerinfosystem\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 28,
    "note": null
  },
  {
    "title": "Verbandsgemeinde Wirges",
    "url": "https://wirges.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Bürgerinformationssystem der Verbandsgemeinde Wirges\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 14,
    "note": null
  },
  {
    "title": "Wissenschaftsstadt Darmstadt",
    "url": "https://darmstadt.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "oparlVersion": "1.0",
    "systemName": "OParl-Schnittstelle \"Parlamentsinformationssystem more! rubin\"",
    "vendor": "https://www.more-rubin.de/",
    "bodyCount": 1,
    "note": null
  }
];

export const REGISTRY_CHECKS: readonly RegistryCheck[] = [
  {
    "url": "http://rahden.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://soegel.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.bleckede.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "redirects to www.bleckede.sitzung-online.debi",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.boppard.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.hagenbach.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.harsum.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "redirects to www.harsum.sitzung-online.debi",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.parchim.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "http://www.rosbach.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "redirects to www.rosbach.sitzung-online.debi",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://bad-kreuznach-stadt.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://badpyrmont.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://buergerinfo.stadt-koeln.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://buergerinfo.ulm.de/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://castroprauxel.gremien.info/oparl",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://edenkoben.gremien.info/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "error: OParl is not active.",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://emmelshausen.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://emsdetten.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://enger.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://enkenbach-alsenborn.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://gronau.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://herford.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://herxheim.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://hiddenhausen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://kirchlengern.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://kis.kreis-viersen.de/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://kronberg.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ladbergen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://lahr.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://leopoldshoehe.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://lohfelden.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://mirror.oparl.org/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "host not found",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://montabaur.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://oparl.dresden.de/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://oparl.politik-bei-uns.de/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": "Aggregator (Politik bei Uns) holding a copy of many councils frozen in 2018."
  },
  {
    "url": "https://oparl.stadt-muenster.de/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://oparl.stadt-pirmasens.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://oparl.wuppertal.de/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo-online.net/landkreis-mol-bi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.aachen.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": "https://ratsinfo.aachen.de/public/oparl/system",
    "note": null
  },
  {
    "url": "https://ratsinfo.aldenhoven.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.bad-muenstereifel.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.braunschweig.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "redirects to www.ratsinfo.braunschweig.sitzung-online.de",
    "replacedBy": "https://www.ratsinfo.braunschweig.sitzung-online.de/oparl/system",
    "note": null
  },
  {
    "url": "https://ratsinfo.bruehl.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.erkelenz.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.langenberg.de/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.rheda-wiedenbrueck.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.stadt-kerpen.de/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.steinhagen.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinfo.wesseling.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ratsinformation.leipzig.de/allris_leipzig_public/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 500",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/aarbergen/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/coelbe/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/ehringshausen/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/eschwege/webservice/oparl/v1.1/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 400",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/fernwald/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/glashuetten/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/grossalmerode/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/guxhagen/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/hessisch-lichtenau/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/homberg-efze/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/homberg-ohm/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/ortenberg/webservice/oparl/v1.1/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 400",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/schmitten/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/schwarzenborn/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/waldbrunn/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rim.ekom21.de/willingen/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris-oparl.itk-rheinland.de/Oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.freiburg.de/oparl",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.goch.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.krefeld.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.schwalmtal.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.stadt-willich.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://ris.wachtendonk.de/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://roedinghausen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://rvr-online.gremien.info/oparl",
    "working": false,
    "checked": "2026-09-15",
    "problem": "redirects to ruhrparlament.de",
    "replacedBy": "https://ruhrparlament.de/oparl",
    "note": null
  },
  {
    "url": "https://salzatal.gremien.info/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "error: OParl test expired on 31.03.2022",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://schiffdorf.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4160/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4170/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4180/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4220/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4230/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4240/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4250/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4260/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4270/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4280/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4350/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4410/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4420/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4490/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4500/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4510/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4520/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4550/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4580/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4770/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4780/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4800/webservice/oparl/v1.0/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4800/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4883/webservice/oparl/v1.1/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4890/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sdnetrim.kdvz-frechen.de/rim4957/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sessionnet-oparl.krz.de/oparl/bodies/5205",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 401",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://sitzungsdienst.kdz-ws.net/gkz330/webservice/oparl/v1.1/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "host not found",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://spenge.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://stemwede.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://uplengen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://velen.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://vlotho.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://wallenhorst.ratsinfomanagement.net/webservice/oparl/v1.1/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://weida-land.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://westerburg.gremien.info/oparl/system",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.bonn.sitzung-online.de/public/oparl/system",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTML page instead of OParl",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.hagen.de/buergerinfo/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.itzstedt.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.lwl-pch.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "host not found",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.muenchen-transparent.de/oparl/v1.0",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": "Aggregator (München Transparent), not the city's own system; its object lists answer HTTP 404."
  },
  {
    "url": "https://www.sitzungsdienst-lichtenberg.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.sitzungsdienst-marzahn-hellersdorf.de/oi/oparl/1.1/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.sitzungsdienst-pankow.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.sitzungsdienst-reinickendorf.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.sitzungsdienst-steglitz-zehlendorf.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.sitzungsdienst-treptow-koepenick.de/oi/oparl/1.0/system.asp",
    "working": true,
    "checked": "2026-09-15",
    "problem": null,
    "replacedBy": null,
    "note": null
  },
  {
    "url": "https://www.trave.sitzung-online.de/bi/oparl/1.0/system.asp",
    "working": false,
    "checked": "2026-09-15",
    "problem": "HTTP 404",
    "replacedBy": null,
    "note": null
  }
];
