---
title: "Pi cleanup: disabled/unresolved extensions + workspace skills/infra"
status: draft
created: "2026-09-24T18:20:50.605Z"
type: chore
---

# Pi Install + Workspace Cleanup Plan (PLAN ONLY — no execution)

## Goal
Clean up (1) global Pi install `~/.pi/agent` — remove disabled + unresolved extensions, and (2) this workspace (`/mnt/extra-ssd/dev/projects2/pi-extensions`) — remove unreferenced skills, td/todo/backlog/trekker, projscan, agentsmesh infra/tools. Safety-first: inventory → verify unreferenced → backup → remove → verify startup/tests.

## Facts gathered (2026-09-24, read-only)

### A. Global Pi install (`~/.pi/agent/settings.json`, `extension-manager.json`, `npm/package.json`)
- `extension-manager.json disabled` (3): `../../../../mnt/extra-ssd/dev/projects/pi-extensions/packages/pi-trekker-tasks`, `.../packages/pi-tick`, `npm:pi-skill-gate`.
- `settings.json packages[]` with `-` disabled entries (extension disabled but package row retained):
  - `npm:pi-subagents` — ext `-index.js`, 2 skills + 6 prompts disabled
  - old-path local `../../../../mnt/extra-ssd/dev/projects/pi-extensions/packages/pi-model-picker` — ext `-src/index.ts` (STALE PATH: `projects/` vs current `projects2/`)
  - old-path local `.../packages/pi-apm` — ext `-src/index.ts` (STALE PATH, package no longer in workspace; workspace now only has `packages/pi-system-one`)
  - `npm:pi-shazam -dist/index.js`, `npm:@jmfederico/pi-web -extensions/pi-web.ts`, `npm:pi-intercom -index.ts` (+skill), `npm:pi-prompt-template-model -index.ts` (+skill), `npm:@dietrichgebert/ponytail -pi-extension/index.js` (+6 skills), `npm:pi-model-cycler -index.ts`, `npm:@czottmann/pi-automode -extensions/auto-mode.ts` (+skill), `npm:@xynogen/pix-models -src/extension.ts`, `npm:@mobrienv/pi-tidy-tools -index.ts`
  - local `../../../../mnt/.../projects2/pi-extensions/packages/pi-jev` (no +/- modifiers — likely SUPERSEDED by rename to `pi-system-one` per `.pi/plans/2026-09-24-rename-pi-jev-to-pi-system-one.md`)
- `settings.json extensions[]` disabled (3): `-extensions/orca-agent-status.ts`, `-extensions/orca-prefill.ts`, `-extensions/orca-titlebar-spinner.ts`
- `settings.json skills[]`: `+skills/vercel-cli-with-tokens/SKILL.md` enabled; 9 `-skills/...` disabled (agents-sdk, cloudflare, cloudflare-email-service, durable-objects, sandbox-sdk, turnstile-spin, web-perf, workers-best-practices, wrangler)
- `~/.pi/agent/npm/package.json` still lists as deps: `pi-skill-gate`, `pi-subagents`, `pi-shazam`, `@jmfederico/pi-web`, `pi-intercom`, `pi-prompt-template-model`, `@dietrichgebert/ponytail`, `pi-model-cycler`, `@czottmann/pi-automode`, `@xynogen/pix-models`, `@mobrienv/pi-tidy-tools` (+ others fully enabled)
- Loose files in `~/.pi/agent/extensions/`: `herdr-agent-status.ts`(?) `herdr-agent-state.ts`, `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`, `guardrails.json`, `skillful-install.json`, dirs `pi-automode/`, `pi-permission-system/`, `pi-rtk-optimizer/` — overlap with disabled orca entries; needs resolution check
- `~/.pi/agent/skills/` is EMPTY (global skills come only via packages)
- Unresolved-extension candidates (to confirm at execution via startup log): the two `projects/` (not `projects2/`) local paths, `pi-apm`, `pi-tick`, `pi-trekker-tasks`, `pi-jev` (renamed), and any npm package whose dist file is missing

### B. Workspace
- `packages/` contains ONLY `pi-system-one` (v0.7.0). All other package refs (`pi-model-picker`, `pi-apm`, `pi-tick`, `pi-trekker-tasks`, `pi-jev`) are stale/external.
- `.agents/skills/`: 3 real dirs (`am-command-init-rules`, `am-command-plan-task`, `am-command-skillshare-recommend`), 2 real (`jev`, `typesafe-ai` — ACTIVE, used by pi-system-one), 6 BROKEN symlinks → `/home/bond/.agent-skills/skills/*` (dir is EMPTY): `issue-tracking`, `pi-package-creator`, `planning`, `search`, `task-sync`, `trekker`
- `.claude/skills/`: ~15 real dirs likely unreferenced (`grill-me`, `grill-with-docs`, `improve-codebase-architecture`, `pi-skillshare`, `publish-npm-package`, `release-please-development`, `setup-matt-pocock-skills`, `skill`, `td-task-management`, `to-issues`, `to-prd`, `triage`, `verify`, `write-a-skill`, `zoom-out`) + same 6 broken symlinks + `jev -> ../../.agents/skills/jev`, `typesafe-ai -> ../../.agents/skills/typesafe-ai`
- `skills/` (root): stale repomix snapshot (`SKILL.md` name `repomix-reference-pi-extensions`, `references/files.md` 95KB) — almost certainly unreferenced
- td/todo/backlog/trekker infra: `.todos/` (`issues.db` 405KB + `config.json`), `.claude/skills/{td-task-management,to-issues,to-prd,triage}`, `.agents/skills/{am-command-plan-task}` + broken `task-sync/trekker`, `.pi/settings.json` `[trekker]` block (enforcing), `.pi/pi-tasks/tasks.sqlite` (57KB), `.pi/trekker-tasks-config.json`, `.pi/agents/supervisor.md`, `.pi/extensions/pi-permissions-system/config.json`, `Taskfile.yml` (`skillshare update -p && skillshare sync -p` pre-hook), `skills-lock.json` (jev+typesafe-ai — KEEP)
- projscan infra: `.projscanrc.json`, `.projscan-workspace.json` (refs stale `pi-model-picker` path), `.projscan-cache/` (`graph.json` 118KB), `.projscan-memory/`, `.project.json`, `extensions.md` (113KB, dated 10 aug), `AGENTS.md` projscan block
- agentsmesh infra: `agentsmesh.yaml`, `.agentsmeshcache` → `/home/bond/.agentsmesh/cache`, `.mcp.json` + `opencode.json` (agentsmesh + projscan MCP entries), `.opencode/`, `.claude/commands|rules|agents`
- junk/verification targets: `tmp/file*.txt`, `test.db` (0B), `test2.db`, `repomix-output.xml` (356KB), `.jobs.db` (114KB), `docs/context/` (apm snapshot?), `docs/old/`, `docs/test/`, `plans/` vs `.pi/plans/` vs `docs/plans/` triplication, `.firecrawl/`, `.pi/pi-tasks/`

## Phase 1 — Inventory & reference check (read-only, ~15 min)
1.1 Pi install: `cp ~/.pi/agent/settings.json /tmp/settings.backup.$(date +%F).json && cp ~/.pi/agent/extension-manager.json /tmp/extension-manager.backup.json && cp ~/.pi/agent/npm/package.json /tmp/pi-npm.backup.json`
1.2 Capture baseline: `pi --help 2>&1 | head -50` + full startup log with `quietStartup:false` once (`pi -p --no-session "list loaded tools"`); save output; grep for `unresolved|failed to load|could not resolve|disabled` to finalize the unresolved list (do NOT guess — confirm each candidate in §A).
1.3 Extension resolution audit: for each `packages[]` entry run `ls ~/.pi/agent/npm/node_modules/<pkg>` + check the referenced dist file exists (e.g. `pi-shazam/dist/index.js`); for each local `../../../../...` path run `realpath` and confirm stale `projects/` vs live `projects2/`.
1.4 Skill reference audit (workspace): `rg -l "am-command-|skillshare-recommend|grill-me|improve-codebase|publish-npm|release-please|setup-matt|td-task|to-issues|to-prd|triage\b|write-a-skill|zoom-out|repomix-reference" --glob '!node_modules' --glob '!.git' -g '!repomix-output.xml'` + check `.pi/settings.json`, `Taskfile.yml`, `extensions.md`, `AGENTS.md`, `packages/pi-system-one/**` for references. Anything with zero hits = unreferenced candidate. KEEP: `jev`, `typesafe-ai` (referenced by pi-system-one + skills-lock.json).
1.5 Infra reference audit: `rg -l "trekker|task-sync|tasksync|projscan|agentsmesh|\.todos|issues\.db|tasks\.sqlite" --glob '!node_modules' --glob '!.git'`; confirm no active workflow depends on `.todos/issues.db` vs `.pi/pi-tasks/tasks.sqlite` (check timestamps + `sqlite3 .todos/issues.db "select count(*) from issues"` if schema allows, read-only).

## Phase 2 — Pi install cleanup (global `~/.pi/agent`)
2.1 Remove disabled-extension package ROWS the user confirms unwanted (default: all `-` rows in §A except anything re-enabled in 2.2). Preferred mechanism: `pi extension-manager remove <source>` or edit `settings.json packages[]` to delete the row (row delete also drops its `-skills/-prompts` pins). Then `npm rm <pkg>` in `~/.pi/agent/npm/` so `package.json` deps match (covers `pi-skill-gate`, `pi-subagents`, `pi-shazam`, `pi-web`, `pi-intercom`, `pi-prompt-template-model`, `ponytail`, `pi-model-cycler`, `pi-automode`, `pix-models`, `pi-tidy-tools` — only those confirmed).
2.2 Re-enable (instead of remove) anything still wanted: flip `-path` → `+path` or drop the `-` row to load defaults (candidate: only if startup log shows it loads cleanly).
2.3 Purge `extension-manager.json disabled[]`: delete the 3 entries (2 stale local paths + `npm:pi-skill-gate`); if pi-tick/trekker-tasks are still wanted, re-point to `projects2/` paths — else delete.
2.4 Fix superseded/renamed: remove `.../projects2/pi-extensions/packages/pi-jev` row (superseded by `.../packages/pi-system-one`); fix stale `projects/` → `projects2/` for `pi-model-picker` OR delete row (package not in workspace — default: delete); delete stale `pi-apm` row (package gone).
2.5 Loose `~/.pi/agent/extensions/`: delete `orca-*` files iff matching `-extensions/orca-*` rows are deleted in 2.1/2.2 and startup log shows nothing loads them; keep `guardrails.json` + `pi-permission-system/` (project `.pi/extensions` also has guardrails — reconcile, don't duplicate); disposition `herdr-agent-state.ts`, `pi-automode/`, `pi-rtk-optimizer/` per startup-log evidence.
2.6 Disabled skills pins: delete the 9 `-skills/...` rows if the parent packages are removed; keep `+skills/vercel-cli-with-tokens/SKILL.md` (only explicit enable).
2.7 Verify: `pi -p --no-session "list loaded tools"` starts with zero `unresolved|failed` lines; `npm ls` in `~/.pi/agent/npm/` clean; diff `settings.json` vs `/tmp` backup recorded in plan notes.

## Phase 3 — Workspace skills cleanup
3.1 Delete 6 broken symlinks in `.agents/skills/` + `.claude/skills/` (`issue-tracking`, `pi-package-creator`, `planning`, `search`, `task-sync`, `trekker`) — target dir `/home/bond/.agent-skills/skills/` is empty, safe.
3.2 Delete unreferenced real skills ONLY after Phase 1.4 shows zero refs: default list `.agents/skills/am-command-*` (3) and `.claude/skills/{grill-me,grill-with-docs,improve-codebase-architecture,pi-skillshare,publish-npm-package,release-please-development,setup-matt-pocock-skills,skill,td-task-management,to-issues,to-prd,triage,verify,write-a-skill,zoom-out}`. KEEP `jev`, `typesafe-ai` (+ their `.claude` symlinks) and anything with ≥1 ref.
3.3 Delete stale root `skills/` repomix snapshot iff zero refs (default: delete; it's a generated 44-file snapshot superseded by live code).
3.4 Verify: `ls -la .agents/skills .claude/skills skills`; `npm run check` + `npm run test` still pass; no dangling symlinks (`find .agents .claude -xtype l` returns empty).

## Phase 4 — td/todo/backlog/trekker removal
4.1 Decide task backend FIRST (one question for user at execution): pi-tasks (`.pi/pi-tasks/tasks.sqlite`) OR fresh — then delete the loser: either `rm -rf .todos/` OR `rm -rf .pi/pi-tasks/`. Default recommendation: keep `.pi/pi-tasks` (active config in `.pi/settings.json`), archive `.todos/issues.db` to `/tmp` before delete.
4.2 Remove trekker/task-sync: delete `.pi/trekker-tasks-config.json`, strip `[trekker]` block from `.pi/settings.json`, delete `.pi/agents/supervisor.md` iff unreferenced, remove `task-sync/trekker` symlinks (covered in 3.1), delete `.claude/skills/{td-task-management,to-issues,to-prd,triage}` (covered in 3.2).
4.3 Remove skillshare pre-hook: edit `Taskfile.yml` `_global:pre` to drop `skillshare update -p && skillshare sync -p` (or delete file if `task` runner unused — confirm via 1.4 refs).
4.4 Consolidate plans: keep `.pi/plans/` (9 dated plans, including rename + laya work), archive `plans/*.md` + `docs/plans/*` into `.pi/plans/` or delete duplicates after diff.
4.5 Verify: `rg -ri "trekker|task-sync|skillshare (update|sync)" --glob '!node_modules' --glob '!.git' -g '!*.lock' -g '!repomix*'` returns only historical hits (CHANGELOG/docs/context); `pi` starts without trekker footer/widget errors.

## Phase 5 — projscan + agentsmesh removal
5.1 projscan: `rm -rf .projscan-cache .projscan-memory` + delete `.projscanrc.json .projscan-workspace.json .project.json` + delete root `extensions.md` (113KB stale) iff 1.4 shows zero refs; regenerate `AGENTS.md` projscan block (remove block, keep manual notes line). Note: `.github/` may reference projscan — check first.
5.2 agentsmesh: delete `agentsmesh.yaml`, remove `.agentsmeshcache` symlink (leaves `/home/bond/.agentsmesh/cache` untouched), strip `agentsmesh` + `projscan` MCP stanzas from `.mcp.json` + `opencode.json`, disposition `.opencode/` + `.claude/{commands,rules,agents}` per 1.4 refs (keep only what pi-system-one work needs).
5.3 Verify: `ls -la | grep -i "projscan\|agentsmesh"` empty; `cat .mcp.json opencode.json` valid JSON; `npm run check` passes.

## Phase 6 — Final verification & commit
6.1 Global: clean `pi` cold start (no unresolved/disabled warnings except intentional), `~/.pi/agent/npm/package.json` matches `settings.json packages[]`, backups in `/tmp` listed.
6.2 Workspace: `find . -xtype l` (no broken links), `git status --short` reviewed, `npm run check && npm run test` green, `ls` shows single `packages/pi-system-one`, single plans dir, no `.todos/.projscan*/.agentsmesh*`.
6.3 Commit in two atomic commits: (1) `chore(pi): remove disabled and unresolved extensions` (2) `chore(workspace): drop unreferenced skills and legacy task/projscan/agentsmesh infra`. PLAN ONLY — do not commit without explicit go-ahead.

## Decisions needed at execution (not now)
- D1: Any `-` disabled package the user wants RE-ENABLED instead of removed? (default: remove all listed in §A)
- D2: Task backend keeper: `.pi/pi-tasks` vs `.todos`? (default: keep `.pi/pi-tasks`)
- D3: `pi-jev` row — confirm superseded by `pi-system-one` and safe to delete? (default: yes)
- D4: `Taskfile.yml`, `.opencode/`, `.firecrawl/`, `docs/context/`, `repomix-output.xml`, `.jobs.db`, `test*.db`, `tmp/` — archive vs delete? (default: archive big binaries to /tmp, delete trivial junk)

## Risks / notes
- NEVER delete `~/.pi/agent/auth.json`, `models.json`, `sessions/`, `mcp.json` (context7 key), `settings.json` wholesale — surgical row edits only, with `/tmp` backups.
- Stale `projects/` → `projects2/` paths are the top unresolved-extension suspects; realpath-check before deleting in case user still has old checkout mounted.
- Broken `/home/bond/.agent-skills/skills/` symlinks are safe deletes (target empty), but verify no other tool recreates them (skillshare hook in Taskfile — hence Phase 4.3 ordering).
