# AGENTS.md

This is a directory containing developer projects sorted by folders, in the following format: ./<framework/language>/<project>/

## This workspace (pi-extensions)

npm monorepo.

- `packages/pi-system-one` (`@rigerc/pi-system-one`) — semantic routing and System One classifier decisions.
- `packages/pi-mcp-dot-json` (`@rigerc/pi-mcp-dot-json`) — registers a project's `.mcp.json` servers with pi's MCP support.

- `npm run check` — typecheck all packages
- `npm test` — tests all packages (`node --test` per package)
- Skills in use: `.agents/skills/jev`, `.agents/skills/typesafe-ai` (pinned in `skills-lock.json`) — do not remove.
- Plans live in `.pi/plans/`.
