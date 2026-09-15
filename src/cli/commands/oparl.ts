// The OParl commands. Navigation mirrors the standard: find an endpoint in the
// registry, open its System, list its Bodies, then walk one of a Body's object
// lists — or fetch any object directly by URL.
//
//   endpoints            known OParl servers (dev.oparl.org registry + curated list)
//   system <url>         an endpoint's System object
//   bodies <systemUrl>   the bodies (municipalities) on a server
//   list <type> <body>   a body's meetings, papers, persons, … (paged)
//   get <url>            any OParl object or list page by URL

import { Argument, Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  DEFAULT_REGISTRY_URL,
  LIST_TYPES,
  type EndpointSource,
  type ListOptions,
  type ListType,
} from "../../client/client.js";
import type { JsonObject, ListResult, RegistryEntry } from "../../client/types.js";
import {
  action,
  parseBoundedInt,
  parseIntArg,
  parseNonEmpty,
  parseTimestamp,
  parseUrl,
  renderJson,
} from "../shared.js";

const MAX_PAGES_OPTION = "pages to fetch, following links.next (0 = all)";

/**
 * Fold text for the endpoints search: case, Unicode normalisation form, accents and the
 * German umlaut spellings all compare equal, so "Köln" (typed composed or decomposed),
 * "koln" and "koeln" match each other, and "düsseldorf" matches "Dusseldorf".
 */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replace(/([aou])e/g, "$1");
}

/**
 * Tell the user on stderr what the walk has to report: why it stopped before the list
 * ended, or which filter it could not apply.
 */
function noteWalk(deps: CliDeps, result: ListResult<JsonObject>): void {
  if (result.note !== undefined) deps.io.err(`Note: ${result.note}`);
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("endpoints")
    .description(
      "List known OParl endpoints: the registry at dev.oparl.org plus a curated list of " +
        "servers it lacks, with the date and result of their last live check",
    )
    .option("--search <text>", "only endpoints whose title or URL contains this text (ignores case, accents and ä/ae spellings)", parseNonEmpty)
    .option("--oparl-version <version>", "only endpoints speaking this OParl version, e.g. 1.1", parseNonEmpty)
    .option("--working", "only endpoints that worked on their last check")
    .addOption(
      new Option("--source <source>", "registry entries, curated entries, or both")
        .choices(["all", "registry", "curated"])
        .default("all"),
    )
    .option("--registry-url <url>", "registry URL", parseUrl, DEFAULT_REGISTRY_URL)
    .action(
      action(
        deps,
        async ({ client, global, opts }) => {
          let entries = await client.endpoints({ source: opts["source"] as EndpointSource });
          const search = opts["search"] as string | undefined;
          const version = opts["oparlVersion"] as string | undefined;
          if (search !== undefined) {
            const needle = foldSearchText(search.trim());
            entries = entries.filter(
              (e: RegistryEntry) => foldSearchText(e.title).includes(needle) || foldSearchText(e.url).includes(needle),
            );
          }
          if (version !== undefined) {
            const wanted = version.trim();
            entries = entries.filter((e) => e.oparlVersion === wanted);
          }
          if (opts["working"]) entries = entries.filter((e) => e.working);
          renderJson(deps, global, entries);
        },
        (opts) => ({ registryUrl: opts["registryUrl"] as string }),
      ),
    );

  program
    .command("system")
    .description("Fetch an endpoint's System object (the entry point of an OParl server)")
    .argument("<url>", "System URL, e.g. from `oparl endpoints`", parseUrl)
    .action(
      action(deps, async ({ client, global }, [url]) => {
        renderJson(deps, global, await client.system(url as string));
      }),
    );

  program
    .command("bodies")
    .description("List the bodies (Körperschaften, usually municipalities) on an OParl server")
    .argument("<systemUrl>", "System URL", parseUrl)
    .option("--max-pages <n>", MAX_PAGES_OPTION, parseIntArg, 0)
    .action(
      action(deps, async ({ client, global, opts }, [url]) => {
        const result = await client.bodies(url as string, { maxPages: opts["maxPages"] as number });
        noteWalk(deps, result);
        renderJson(deps, global, result);
      }),
    );

  program
    .command("list")
    .description(
      "Walk one of a body's object lists. Returns { data, pages, next }: pass `next` to " +
        "`oparl get` or raise --max-pages to continue. Servers may ignore the filters.",
    )
    .addArgument(new Argument("<type>", "object list to fetch").choices(Object.keys(LIST_TYPES)))
    .argument("<bodyUrl>", "Body URL, e.g. from `oparl bodies`", parseUrl)
    .option("--max-pages <n>", MAX_PAGES_OPTION, parseIntArg, 1)
    .option("--modified-since <time>", "only objects modified since (YYYY-MM-DD or ISO 8601)", parseTimestamp)
    .option("--modified-until <time>", "only objects modified until (YYYY-MM-DD or ISO 8601)", parseTimestamp)
    .option("--created-since <time>", "only objects created since (YYYY-MM-DD or ISO 8601)", parseTimestamp)
    .option("--created-until <time>", "only objects created until (YYYY-MM-DD or ISO 8601)", parseTimestamp)
    .option("--limit <n>", "page size hint (1..1000); some servers ignore or reject it", parseBoundedInt(1, 1000))
    .option("--omit-internal", "ask the server to leave out embedded objects")
    .action(
      action(deps, async ({ client, global, opts }, [type, bodyUrl]) => {
        const options: ListOptions = { maxPages: opts["maxPages"] as number };
        if (opts["modifiedSince"] !== undefined) options.modifiedSince = opts["modifiedSince"] as string;
        if (opts["modifiedUntil"] !== undefined) options.modifiedUntil = opts["modifiedUntil"] as string;
        if (opts["createdSince"] !== undefined) options.createdSince = opts["createdSince"] as string;
        if (opts["createdUntil"] !== undefined) options.createdUntil = opts["createdUntil"] as string;
        if (opts["limit"] !== undefined) options.limit = opts["limit"] as number;
        if (opts["omitInternal"]) options.omitInternal = true;
        const result = await client.list(bodyUrl as string, type as ListType, options);
        noteWalk(deps, result);
        renderJson(deps, global, result);
      }),
    );

  program
    .command("get")
    .description("Fetch any OParl object or list page by URL")
    .argument("<url>", "object or list URL", parseUrl)
    .action(
      action(deps, async ({ client, global }, [url]) => {
        renderJson(deps, global, await client.get(url as string));
      }),
    );
}
