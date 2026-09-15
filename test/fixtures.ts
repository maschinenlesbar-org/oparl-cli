// Fixtures shaped after real OParl servers (a 1.1 Somacos server, a 1.0 more!
// rubin server) and the dev.oparl.org registry, trimmed and moved to example hosts.

export const HOST = "https://ris.example.de";
export const SYSTEM_URL = `${HOST}/oparl/system`;
export const BODIES_URL = `${HOST}/oparl/bodies`;
export const BODY_URL = `${HOST}/oparl/bodies/stadt`;
export const MEETINGS_URL = `${BODY_URL}/meetings`;
export const REGISTRY_URL = "https://registry.example.org/api/endpoints";

export const system = {
  id: SYSTEM_URL,
  type: "https://schema.oparl.org/1.1/System",
  oparlVersion: "https://schema.oparl.org/1.1/",
  otherOParlVersions: [],
  body: BODIES_URL,
  name: "Stadt Beispiel - OParl 1.1",
  vendor: "https://www.somacos.de?oparl=v1.6.1",
};

export const body = {
  id: BODY_URL,
  type: "https://schema.oparl.org/1.1/Body",
  system: SYSTEM_URL,
  shortName: "Beispiel",
  name: "Stadt Beispiel, kreisfreie Stadt",
  ags: "05315000",
  organization: `${BODY_URL}/organizations`,
  person: `${BODY_URL}/people`,
  meeting: MEETINGS_URL,
  paper: `${BODY_URL}/papers`,
  membership: `${BODY_URL}/memberships`,
  locationList: `${BODY_URL}/locations`,
  agendaItem: `${BODY_URL}/agendaitems`,
  legislativeTermList: `${BODY_URL}/legislativeterms`,
  consultation: `${BODY_URL}/consultations`,
  file: `${BODY_URL}/files`,
};

/** An OParl 1.0 body (more! rubin style): only four lists, embedded legislative terms. */
export const body10 = {
  id: `${HOST}/oparl/body/FR`,
  type: "https://schema.oparl.org/1.0/Body",
  system: `${HOST}/oparl/system`,
  name: "Stadtverwaltung Beispiel",
  organization: `${HOST}/oparl/body/FR/organization`,
  person: `${HOST}/oparl/body/FR/person`,
  meeting: `${HOST}/oparl/body/FR/meeting`,
  paper: `${HOST}/oparl/body/FR/paper`,
  legislativeTerm: [{ id: `${HOST}/oparl/LegislativeTerm/1`, type: "https://schema.oparl.org/1.0/LegislativeTerm", name: "2019 - 2024" }],
};

export const bodyList = {
  data: [body],
  pagination: { elementsPerPage: 25, currentPage: 1 },
  links: { first: BODIES_URL, self: BODIES_URL },
};

export function meeting(n: number) {
  return {
    id: `${MEETINGS_URL}/${n}`,
    type: "https://schema.oparl.org/1.1/Meeting",
    name: `Sitzung des Rates ${n}`,
    start: "2026-09-24T15:30:00+02:00",
    organization: [`${BODY_URL}/organizations/gr/1`],
    created: "2026-09-11T11:04:34+02:00",
    modified: "2026-09-11T11:04:34+02:00",
  };
}

/** Page 1 links page 2 with an absolute URL; page 2 links page 3 relatively; page 3 is last. */
export const meetingPages = {
  1: { data: [meeting(1), meeting(2)], pagination: { currentPage: 1 }, links: { next: `${MEETINGS_URL}?page=2` } },
  2: { data: [meeting(3), meeting(4)], pagination: { currentPage: 2 }, links: { next: "meetings?page=3" } },
  3: { data: [meeting(5)], pagination: { currentPage: 3 }, links: {} },
};

export const registryPage1 = {
  data: [
    {
      id: 1,
      title: "Stadt Beispiel",
      url: SYSTEM_URL,
      system: system,
      wikidata: "Q365",
      fetched: "2026-01-17T01:05:03+01:00",
      bodyCount: 1,
    },
    {
      id: 2,
      title: "Amt Irgendwo",
      url: "https://www.irgendwo.sitzung-online.de/bi/oparl/1.0/system.asp",
      system: [],
      wikidata: null,
      fetched: "2026-01-17T01:05:04+01:00",
      bodyCount: 0,
    },
  ],
  meta: { page: 1, total: 3, totalPages: 2, next: `${REGISTRY_URL}?page=2&limit=100`, perPage: 100 },
};

export const registryPage2 = {
  data: [
    {
      id: 3,
      title: "Gemeinde Musterdorf",
      url: "https://rim.example.net/musterdorf/webservice/oparl/v1.0/system",
      system: { ...system, id: "https://rim.example.net/musterdorf/webservice/oparl/v1.0/system", oparlVersion: "https://schema.oparl.org/1.0/", name: "SD.NET RIM" },
      wikidata: "Q1",
      fetched: "2026-01-17T01:05:05+01:00",
      bodyCount: 0,
    },
  ],
  meta: { page: 2, total: 3, totalPages: 2, perPage: 100 },
};
