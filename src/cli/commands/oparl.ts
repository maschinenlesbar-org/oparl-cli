// The OParl commands. Navigation mirrors the standard: find an endpoint in the
// registry, open its System, list its Bodies, then walk one of a Body's object
// lists — or fetch any object directly by URL.
//
//   endpoints            known OParl servers (dev.oparl.org registry + curated list)
//   system <url>         an endpoint's System object
//   bodies <systemUrl>   the bodies (municipalities) on a server
//   list <type> <body>   a body's meetings, papers, persons, … (paged)
//   get <url>            any OParl object or list page by URL

import { Argument, InvalidArgumentError, Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  DEFAULT_REGISTRY_URL,
  LIST_TYPES,
  shortOparlVersion,
  type EndpointSource,
  type ListOptions,
  type ListType,
} from "../../client/client.js";
import type { OparlClient } from "../../client/client.js";
import { OparlError, OparlValidationError } from "../../client/errors.js";
import type { JsonObject, ListResult, RegistryEntry } from "../../client/types.js";
import {
  action,
  parseBoundedInt,
  parseIntArg,
  parseNonEmpty,
  parseTimestamp,
  parseUrl,
  renderJson,
  type GlobalOptions,
} from "../shared.js";

const MAX_PAGES_OPTION = "pages to fetch, following links.next (0 = all)";

/**
 * Fold text for the endpoints search: case, Unicode normalisation form and accents
 * compare equal, and `ß` counts as `ss`. So "Köln" typed composed or decomposed, and
 * "koln", match each other.
 */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss");
}

/**
 * The same text with the German umlaut spellings contracted, so `ae`/`oe`/`ue` compare
 * equal to `a`/`o`/`u`: "koeln" and "köln" (folded to "koln") both become "koln".
 *
 * Only used as a second pass, because it also collapses ordinary words — "Aue" becomes
 * "au" and matches half the register. See {@link searchMatches}.
 */
export function contractUmlautSpellings(folded: string): string {
  return folded.replace(/([aou])e/g, "$1");
}

/** A search needs this many characters before the umlaut pass runs. */
const MIN_UMLAUT_PASS_LENGTH = 4;

/**
 * The entries a `--search` term matches: those containing it literally (accents and
 * `ß` folded) and, only when nothing matched literally, those that match with the
 * umlaut spellings contracted — so "koeln" still finds "Köln" and "duesseldorf" finds
 * "Dusseldorf", while "ae" no longer matches every entry with an "a".
 */
export function searchMatches<T>(entries: readonly T[], term: string, text: (entry: T) => string[]): T[] {
  const needle = foldSearchText(term.trim());
  const literal = entries.filter((entry) => text(entry).some((value) => foldSearchText(value).includes(needle)));
  if (literal.length > 0 || needle.length < MIN_UMLAUT_PASS_LENGTH) return literal;
  const contracted = contractUmlautSpellings(needle);
  return entries.filter((entry) =>
    text(entry).some((value) => contractUmlautSpellings(foldSearchText(value)).includes(contracted)),
  );
}

/**
 * commander value-parser for `--oparl-version`: the short form the endpoint list holds
 * ("1.1"), or the version URI a System carries ("https://schema.oparl.org/1.1/") — what
 * `oparl system` prints, and so the natural thing to paste. Every other string used to
 * be accepted and matched nothing, which reads as "no such servers".
 */
export function parseOparlVersion(value: string): string {
  const version = shortOparlVersion(value.trim());
  if (!/^\d+\.\d+$/.test(version)) {
    throw new InvalidArgumentError(
      "Expected an OParl version such as 1.0 or 1.1, or the version URI a System reports (https://schema.oparl.org/1.1/).",
    );
  }
  return version;
}

/**
 * The known endpoints, falling back to the curated list alone when the registry cannot
 * be read. That list ships with the package and needs no network, so one unreachable
 * third-party host should not take down the documented entry point of every workflow —
 * but the user is told on stderr, since the answer is then only as fresh as this
 * release. `--source registry` keeps failing: there would be nothing left to show.
 */
async function endpointsOrCuratedOnly(
  deps: CliDeps,
  client: OparlClient,
  source: EndpointSource,
  registryUrl: string,
): Promise<RegistryEntry[]> {
  try {
    return await client.endpoints({ source });
  } catch (err) {
    if (source !== "all" || !(err instanceof OparlError) || err instanceof OparlValidationError) throw err;
    deps.io.err(
      `Note: the endpoint registry at ${registryUrl} could not be read (${err.message}) — ` +
        "listing only the curated endpoints that ship with this tool, as of their last check (`checked`). " +
        "Use --source curated to skip the registry, or --source registry to see the error.",
    );
    return client.endpoints({ source: "curated" });
  }
}

/**
 * Tell the user on stderr what the walk has to report: why it stopped before the list
 * ended, or which filter it could not apply.
 */
function noteWalk(deps: CliDeps, result: ListResult<JsonObject>): void {
  if (result.note !== undefined) deps.io.err(`Note: ${result.note}`);
}

/**
 * Print a walk's result. When the walk failed after its first page, the pages it did
 * fetch are printed all the same (with `next` at the page that failed and a note), and
 * then the error is rethrown, so the exit code still reports the failure.
 */
async function renderWalk(
  deps: CliDeps,
  global: GlobalOptions,
  walk: () => Promise<ListResult<JsonObject>>,
): Promise<void> {
  let result: ListResult<JsonObject>;
  try {
    result = await walk();
  } catch (err) {
    if (err instanceof OparlError && err.partial !== undefined) {
      noteWalk(deps, err.partial);
      renderJson(deps, global, err.partial);
    }
    throw err;
  }
  noteWalk(deps, result);
  renderJson(deps, global, result);
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("endpoints")
    .description(
      "List known OParl endpoints: the registry at dev.oparl.org plus a curated list of " +
        "servers it lacks, with the date and result of their last live check",
    )
    .option("--search <text>", "only endpoints whose title, URL or note contains this text (ignores case and accents; falls back to ä/ae spellings)", parseNonEmpty)
    .option("--oparl-version <version>", "only endpoints speaking this OParl version: 1.0, 1.1, or the full version URI", parseOparlVersion)
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
          let entries = await endpointsOrCuratedOnly(
            deps,
            client,
            opts["source"] as EndpointSource,
            opts["registryUrl"] as string,
          );
          const search = opts["search"] as string | undefined;
          const version = opts["oparlVersion"] as string | undefined;
          if (search !== undefined) {
            entries = searchMatches(entries, search, (e: RegistryEntry) => [e.title, e.url, e.note ?? ""]);
          }
          if (version !== undefined) entries = entries.filter((e) => e.oparlVersion === version);
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
        await renderWalk(deps, global, () => client.bodies(url as string, { maxPages: opts["maxPages"] as number }));
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
        await renderWalk(deps, global, () => client.list(bodyUrl as string, type as ListType, options));
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
