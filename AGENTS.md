# AGENTS.md

This is a directory containing developer projects sorted by folders, in the following format: ./<framework/language>/<project>/

## This workspace (pi-extensions)

npm monorepo — single package: `packages/pi-system-one` (`@rigerc/pi-system-one`).

- `npm run check` — typecheck (`tsc -b packages/pi-system-one`)
- `npm run test` — vitest
- Skills in use: `.agents/skills/jev`, `.agents/skills/typesafe-ai` (pinned in `skills-lock.json`) — do not remove.
- Plans live in `.pi/plans/`.
