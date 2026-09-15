// The OParl commands. Navigation mirrors the standard: find an endpoint in the
// registry, open its System, list its Bodies, then walk one of a Body's object
// lists — or fetch any object directly by URL.
//
//   endpoints            the public registry of OParl servers (dev.oparl.org)
//   system <url>         an endpoint's System object
//   bodies <systemUrl>   the bodies (municipalities) on a server
//   list <type> <body>   a body's meetings, papers, persons, … (paged)
//   get <url>            any OParl object or list page by URL

import { Argument, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { DEFAULT_REGISTRY_URL, LIST_TYPES, type ListOptions, type ListType } from "../../client/client.js";
import type { RegistryEntry } from "../../client/types.js";
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

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("endpoints")
    .description("List public OParl endpoints from the registry at dev.oparl.org")
    .option("--search <text>", "only endpoints whose title or URL contains this text (ignores case, accents and ä/ae spellings)", parseNonEmpty)
    .option("--oparl-version <version>", "only endpoints speaking this OParl version, e.g. 1.1", parseNonEmpty)
    .option("--working", "only endpoints the registry could reach on its last fetch")
    .option("--registry-url <url>", "registry URL", parseUrl, DEFAULT_REGISTRY_URL)
    .action(
      action(
        deps,
        async ({ client, global, opts }) => {
          let entries = await client.endpoints();
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
        renderJson(deps, global, await client.bodies(url as string, { maxPages: opts["maxPages"] as number }));
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
        renderJson(deps, global, await client.list(bodyUrl as string, type as ListType, options));
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
