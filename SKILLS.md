# oparl-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for German
**municipal council information**, all powered by the **[oparl](README.md)** CLI over
**OParl**, the open standard API of council information systems (*Ratsinformationssysteme*).

Each skill teaches Claude how to drive the `oparl` CLI to answer a specific, real-world
question — "does Köln publish OParl?", "which motions did the council file this week?" —
and to report the answer with references rather than guesswork. They encode the parts that
are easy to get wrong: there is no central API, the public registry is a stale snapshot (the
CLI adds a curated list and live checks), servers may
silently ignore date filters, list order is the server's, and data licenses differ per
municipality.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **oparl-endpoint-finder** | Finds a municipality's OParl endpoint in the registry and the curated list, verifies it live, lists its bodies and their lists, and reports the declared license. | "does Münster have an OParl API?", "is Solingen's endpoint still working?" |
| **oparl-council-activity** | Walks a body's papers, meetings and committees with date filters, checks whether the server honoured them, and cites paper references. | "what did the Cologne council publish since September?", "list the committees" |

They compose: **endpoint-finder → council-activity**.

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `oparl` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/oparl-cli   # installs the `oparl` bin
  ```
  Verify with `command -v oparl` or `oparl --version` before running any skill. No API key
  is required — OParl access is anonymous and read-only.

## Installation

### Plugin marketplace (recommended)

The skills are published as the `oparl` plugin in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins),
which lists the plugins for all maschinenlesbar.org CLIs. Installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install oparl@maschinenlesbar
```

The first command registers the marketplace (once, for all maschinenlesbar.org plugins); the
second installs the `oparl` plugin, which bundles both skills. Update later with
`/plugin marketplace update maschinenlesbar`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/oparl-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/`. Start a new Claude Code session and the skills
are picked up automatically.

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for the
dual-licensing / commercial option. The data belongs to each council's operator — see
[DATA_LICENSE.md](DATA_LICENSE.md).
