# oparl-mcp

An [MCP](https://modelcontextprotocol.io/) server for the OParl APIs of German council
information systems (*Ratsinformationssysteme*): find a city's or county's OParl server, check
that it answers, and read its council's papers (Vorlagen, Anträge, Anfragen), meetings,
committees and people, as tools for AI agents. Read-only, no API key. Every council runs its own
server, and each sets its own terms; most declare none (see Licence).

It is the MCP side of [oparl-cli](https://github.com/maschinenlesbar-org/oparl-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/oparl-mcp
```

This installs the **`oparl-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/oparl-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add oparl -- oparl-mcp
# or with the image:
claude mcp add oparl -- docker run -i --rm ghcr.io/maschinenlesbar-org/oparl-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "oparl": { "command": "oparl-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "oparl": { "type": "stdio", "command": "oparl-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
oparl-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http oparl http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/oparl-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/oparl-cli/releases) instead of
`latest`: `…/oparl-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/oparl-mcp:<version> --repo maschinenlesbar-org/oparl-cli`.

## Which servers

There is no central OParl API: the tools take the URLs the servers publish (a System, a Body, an
object, a list's next page), starting from `findEndpoints`.

- **Only known servers are reached.** A URL is taken only on the host of a server of the endpoint
  lists that ship with the client (the [dev.oparl.org](https://dev.oparl.org/) registry's entries,
  as last checked, and a curated list of servers it lacks: 124 hosts in all), or on the host of
  `--base-url`. Anything else is refused before any request: a caller can't make the server fetch
  an address of its choosing. From there, links and redirects are followed on the same host only,
  as the CLI does.
- **`--base-url`** names the endpoint registry `findEndpoints` reads (default
  `https://dev.oparl.org/api/endpoints`, the CLI's `endpoints --registry-url`). A registry that
  can't be read leaves the curated list. Its host is reachable too, so a server run for one's own
  OParl server can point there.
- A server missing from the lists can be read with the [oparl CLI](https://github.com/maschinenlesbar-org/oparl-cli), which takes any URL.

## Tools

| Tool | What it answers |
|---|---|
| `findEndpoints` | The known OParl servers that match a place, a product or a version (registry and curated list), working ones first: System URL, last check, problem, new URL, notes, product, version, bodies; with no match, the shared servers whose bodies the search can't see. |
| `checkEndpoint` | Whether a server answers now (and if not, what that means), its System (product, vendor, version, licence) and its bodies, each with its id, the lists it links and its own licence. |
| `findPapers` | A body's papers new or changed since a day (or of the first pages), newest first: reference, title, type, date, new; whether the server honoured the date filter, deleted stubs dropped, papers without a date kept, words and paper types matched over the pages read. |
| `findMeetings` | A body's meetings in a window (upcoming by default), soonest first, with location, cancellation and the committees; the pages read until one holds none of the window. |
| `listObjects` | One of a body's lists: committees and groups (organization), people, legislative terms, memberships, locations, agenda items, consultations, files; embedded objects named, not inlined. |
| `getObject` | Any OParl object by its URL, as the server sends it: a paper with its consultations and files, a meeting with its agenda, a person, a file's download URL. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (the server's URLs; an answer a redirect fetched from another origin, such as
the same host over https, says so there: "… (answered by https://host after a redirect)", and a WARN
record names both) and the data licence. The skills' traps are handled in the tools: servers that
ignore date filters, stamp fake change dates or answer an empty window with HTTP 404; papers only
edited since a day that aren't new; lists in the server's order, not by date, read a few pages at a
time (`next` goes on). No match and a server that doesn't answer are answers in words, with what to
try. A text over 2000 characters is cut and ends in `…[cut, N characters in all]`, and the answer
says `truncated`. A failure is a tool error that says what to change (one over 5000 characters loses
its middle, never its end, where the reason is).

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           the endpoint registry findEndpoints reads (default https://dev.oparl.org/api/endpoints)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the councils' servers.** One server process sends at most 2 requests at a time and
  120 a minute, over all servers together, pauses on HTTP 429 (as long as its Retry-After asks, at
  most 30 s), and stops a tool call after its deadline (a tool that has read part of its answer by
  then may answer with that part, and says so). A request those limits would hold longer than it or
  its call may wait is not sent: the call fails at once, naming the limit and when to ask again (and
  the log says so). A list tool reads one or two pages unless asked for more (at most
  `--max-pages`); some servers take 10 s and more per page, so a call that reads several pages can
  need a longer `--call-timeout`.
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes
  equal to another stays, as `name~2`), but it is still other people's text: a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/oparl-cli/blob/main/LICENSING.md)).
Data: each council's server sets its own terms
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/oparl-cli/blob/main/DATA_LICENSE.md)).
OParl lets a server declare a licence in the `license` field of its System and Body; the results
read it strictly (`licence.declared` with a note, per System and per Body in `checkEndpoint`, per
body in the list tools, per object in `getObject`): a licence URL or a recognisable licence name
declares one, a word like "Open" or a `licenseValidSince` date alone declares nothing. Most
servers declare none; then reuse beyond reading needs the operator's permission. Name the
operator (the Body) as the source. Council papers issued by an authority are largely official
works (§ 5 UrhG: reusable unaltered, with the source); motions of groups and attached files can
carry third-party copyright; person records are personal data under the GDPR and must not be
bulk-copied. Every result carries this note in its `licence` field. Running the server as a
service for others redistributes the councils' data: check the terms of the servers it reaches
first. We provide the tool, not the data.
