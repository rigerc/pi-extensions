# pi-mcp-dot-json

Use a project's `.mcp.json` as an MCP source in [pi](https://github.com/earendil-works/pi).

Pi reads MCP servers from `~/.pi/agent/mcp.json` and, in a trusted project, `.pi/mcp.json`.
Repositories written for other MCP clients keep their servers in `.mcp.json` instead, where pi
does not look. This extension reads that file from the session directory and registers every entry
with `pi.registerMcpServer()`, so the servers behave exactly like the configured ones: the built-in
MCP support connects them, `/mcp` lists and manages them, and their tools are registered as
`mcp__<server>__<tool>`.

Nothing else changes. `/mcp`, codemode, `tool_search`, and both `mcp.json` files keep working, and
an entry whose name `mcp.json` also defines is still won by `mcp.json`.

## Install

```bash
npm install --global @rigerc/pi-mcp-dot-json
```

Pi loads packages listed in settings; add it if your setup does not do that automatically:

```json
{
  "packages": ["@rigerc/pi-mcp-dot-json"]
}
```

Or load it for one run:

```bash
pi --extension @rigerc/pi-mcp-dot-json
```

## Use

Put the servers in `.mcp.json` at the project root, in the `mcpServers` shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Start pi in that directory. The servers connect in the background, exactly like servers from
`mcp.json`, and appear in `/mcp` with this extension as their source. Run `/mcp-json` to see what
was taken from the file, including why an entry was skipped.

Entries support everything pi's own `mcp.json` supports: `command`, `args`, `env`, `cwd`, `url`,
`headers`, `oauth`, `timeout`, `enabled`, `exposure`, `toolExposure`, and `description`, with
`${ENV_VAR}` and `!command` values resolved as usual.

## Agents are told

While this extension is loaded, it adds a `dot_mcp_json` section to the system prompt on every
prompt, so a model asked to add, change, or remove an MCP server edits `.mcp.json` instead of
running `pi mcp add` or writing `.pi/mcp.json`, which take precedence over it:

> MCP servers for this project are configured in /repo/.mcp.json, in the `mcpServers` shape, and
> registered by the pi-mcp-dot-json extension. To add, change, or remove a server, edit that file.
> Do not run `pi mcp add` and do not write `.pi/mcp.json`: both take precedence over it, so the
> server would end up in the wrong scope. Give a new entry a one-line `description` so other agents
> know when to reach for it. Defined now: docs, files. Changes apply after `/reload` or in the next
> session.

The section is also written when the project has no `.mcp.json` yet, in which case it asks for the
file to be created, and it adds a sentence about project trust when the file is being ignored. Pi
diffs prompt sections per prompt, so an unchanged section is not re-sent. Delete the section from a
prompt by overriding it in your own `before_agent_start` handler.

## Precedence

For one server name, the winner is:

1. `.pi/mcp.json` (and then `~/.pi/agent/mcp.json`)
2. `.mcp.json`

`/mcp` shows an overridden `.mcp.json` entry as overridden.

## Trust and credentials

`.mcp.json` is a project file, so it is only read in a **trusted** project. Grant trust when pi asks
and restart; until then `/mcp-json` says the file was skipped. This is the same gate pi applies to
`.pi/mcp.json`.

Note how pi decides that a project needs trust: a directory that holds no pi project resources (no
`.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions`, `.pi/skills`, `.agents/skills`, …) is trusted
without a prompt, and `"defaultProjectTrust": "always"` trusts everything. In those cases a
`.mcp.json` is read as well, so review a repository before running pi in it, or start pi with
`--no-approve` to refuse project trust for that session.

Because the file comes from a repository:

- `"auth": { "provider": "..." }` is rejected. It sends a stored pi credential to a server URL, so
  only `~/.pi/agent/mcp.json` may use it. Use `${ENV_VAR}` headers, or move the server there.
- Entries with invalid names, namespaces that would collide, or shapes pi rejects are reported and
  skipped; the other entries still load.
- Servers themselves can run any command, with your permissions. Review a repository before
  trusting it, exactly as you would before trusting its scripts.

## Changes are session-only

Registrations last for the session. `pi.registerMcpServer()` does not write anything, so enabling,
disabling, or changing exposure of a `.mcp.json` server from `/mcp` applies to the current session
and is not saved back to the file. Edit `.mcp.json` and run `/reload` to pick up changes.

## Development

```bash
npm --prefix packages/pi-mcp-dot-json run typecheck
npm --prefix packages/pi-mcp-dot-json test
```

## License

MIT
