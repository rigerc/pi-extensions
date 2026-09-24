---
title: "Pi port of jevselector (Jev per-prompt skill/tool filtering)"
status: draft
created: "2026-09-21T19:45:13.180Z"
updated: "2026-09-21T19:56:27.585Z"
type: feature
---

## Context

Port `../jevselector` (an OpenCode v2 plugin) to a Pi package `packages/pi-jevselector` in this monorepo. jevselector uses the Jev (TypeSafe AI "System One") decision model to dynamically select which **skills** and **tools** are exposed per turn, trimming the system prompt to only what is relevant. Measured savings in OpenCode: ~2,600–3,200 tokens/turn (~50%+ of system prompt), Jev cost ~250–950 ms, cached across continuations, fails open on any error.

Source modules to port (`../jevselector/src/`): `config.ts`, `decide.ts`, `cache.ts`, `skills.ts`, `messages.ts` (partially), `index.ts` (hook wiring — must be redesigned for Pi), `types.ts` (OpenCode-specific — replaced by Pi types).

Pi API facts established from `extensions.md` + installed `@earendil-works/pi-coding-agent` sources:
- Per-prompt hook is `pi.on('before_agent_start')` (`{ prompt, systemPrompt, systemPromptOptions }` → return `{ systemPrompt? }`, chained across extensions). It fires **once per user prompt**, not per LLM tool-continuation turn; continuations reuse the same `agent.state.systemPrompt`. This is behaviorally equivalent to jevselector's cache-hit path.
- Skills arrive as `systemPromptOptions.skills: Skill[]` (`{ name, description, filePath, baseDir, ... }`) and are rendered into `systemPrompt` as an `<available_skills>` block with `<name>/<description>/<location>` entries (Pi format — **no `<id>`**, unlike OpenCode's `<id>/<name>/<description>`). Filtering = string-rewrite of that block (same technique as jevselector's `skills.ts`, adapted parser).
- Tools are enforced via `pi.getAllTools()` / `pi.getActiveTools()` / `pi.setActiveTools(names)` (`agent-session.js`: `setActiveToolsByName` rebuilds the base system prompt; "changes take effect on the next agent turn"). There is **no per-request mutable `event.tools`** like OpenCode — `setActiveTools` is session-global, so the extension must save the full set and restore it on `agent_end` (or next `before_agent_start` starts from the full set).
- `systemPrompt` resets to `_baseSystemPrompt` each prompt unless an extension returns a replacement, so returning a filtered prompt is safe and non-destructive.
- Pi has no multi-agent routing; the jevselector cache dimension `agent` maps to Pi's active model (`ctx.model` provider/id) instead.

## Approach

1. New package `packages/pi-jevselector/` mirroring `packages/pi-tick` layout (`package.json` with `pi.extensions: ["./src/index.ts"]`, `tsconfig.json` extending base, `README.md`, `LICENSE`).
2. Port pure logic verbatim: `config.ts` (env/option resolution, both providers, thresholds, always-keep lists), `decide.ts` (single batched Jev `noul` request over shared state, per-item fail-safe keep on missing answer, `AbortController` timeout), `cache.ts` (FNV-1a key, 200-entry bound). Only change: cache key uses `(model, userRequest, candidate-set)` instead of `(agent, ...)`.
3. Adapt `skills.ts` to Pi's XML dialect: find `<available_skills>` in `event.systemPrompt`, parse `<name>/<description>/<location>`, rewrite block to kept subset (empty → `<available_skills></available_skills>`). Keep the same exported helpers (`findSkillsBlock`, `parseSkills`, `rewriteSkillsBlock`) so ported tests stay close to the originals.
4. Hook wiring (`index.ts`): `before_agent_start` handler — gather skill candidates from `systemPromptOptions.skills` (minus `alwaysKeepSkills`) and tool candidates from `pi.getAllTools()`/`pi.getActiveTools()` (minus `alwaysKeepTools`); skip when nothing to filter or empty prompt; cache lookup; `decide()` on miss; then (a) `pi.setActiveTools(keptTools + alwaysKeepTools)` for enforcement, (b) return rewritten `systemPrompt` (skills block filtered; tool list already consistent via the `setActiveTools` rebuild, plus explicit text rewrite if needed for ordering with other extensions). `agent_end` handler restores the pre-prompt full tool set. `tool_call` guard blocks calls to filtered-out tools as a safety net for the prompt→execution race. All errors fail open (restore full tools, return no `systemPrompt` override). `verbose` logs via `console.error`/`ctx.ui.notify` like the original's stderr logging.
5. Config surface: Pi extension factories receive no options object, so resolve from env (`TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`, `TYPESAFE_BASE_URL`, `JEVSELECTOR_PROVIDER`) + `settings.json` extension settings where available, with `/jevselector` status command and `/jevselector-threshold <n>` / `/jevselector-toggle` commands for runtime tuning (persist via `pi.appendEntry`, same pattern as pi-skillshare config).
6. Tests: port `../jevselector/test/{config,cache,skills}.test.ts` to vitest under `src/` (Pi skill-XML fixtures, cache-key-with-model, config resolution), plus a `decide.test.ts` with mocked `fetch` (threshold boundary, missing-answer keeps, timeout abort, non-OK fails open) and an `index.test.ts` for the prompt-rewrite/restore logic with a stubbed `pi` object. No live Jev calls in tests.

## Files to modify

- `packages/pi-jevselector/package.json` — create (name `@rigerc/pi-jevselector`, `pi.extensions`, peerDeps on `pi-coding-agent`, engines `node>=22`).
- `packages/pi-jevselector/tsconfig.json` — create (extends `../../tsconfig.base.json`, same as pi-tick).
- `packages/pi-jevselector/README.md` — create (install, env keys, options/commands, measured-results table format, limitations).
- `packages/pi-jevselector/LICENSE` — create (MIT, copy from pi-tick).
- `packages/pi-jevselector/src/config.ts` — create (port of jevselector `config.ts`, provider inference, env fallbacks).
- `packages/pi-jevselector/src/decide.ts` — create (port of `decide.ts`, `SKILL_PREFIX`/`TOOL_PREFIX` batching unchanged).
- `packages/pi-jevselector/src/cache.ts` — create (port of `cache.ts`, key on model instead of agent).
- `packages/pi-jevselector/src/skills.ts` — create (Pi-dialect `<available_skills>` parse/rewrite).
- `packages/pi-jevselector/src/index.ts` — create (Pi extension factory: `before_agent_start` filter, `agent_end` restore, `tool_call` guard, `/jevselector*` commands).
- `packages/pi-jevselector/src/*.test.ts` — create (ported + new tests, vitest).
- `package.json` (root) — edit `check` script to include `packages/pi-jevselector` in `tsc -b`.
- `vitest.config.ts` — check include covers `packages/pi-jevselector/src`; edit only if needed.

## Reuse

- `../jevselector/src/config.ts`, `decide.ts`, `cache.ts` — port with minimal changes (no `@opencode-ai/plugin` dependency; `fetch` + `AbortController` are already available in Pi's Node 22 runtime).
- `../jevselector/src/skills.ts` — reuse block-rewrite technique, new regexes for Pi XML.
- `../jevselector/test/` — port fixtures/expectations to vitest style used in this repo (`packages/pi-model-picker/src/state.test.ts`).
- `packages/pi-tick` — template for `package.json`/`tsconfig.json`/README shape; `packages/pi-skillshare/src/index.ts` — template for `appendEntry` config persistence + `/cmd` registration.
- Pi primitives: `pi.on('before_agent_start' | 'agent_end' | 'tool_call')`, `pi.getAllTools()/getActiveTools()/setActiveTools()`, `pi.registerCommand`, `pi.appendEntry`, `ctx.ui.notify/setStatus`.

## Steps

## Status: DONE (full port implemented, check + tests green)

Implemented `packages/pi-jevselector` (`@rigerc/pi-jevselector` 0.1.0): `src/config.ts`, `decide.ts`, `cache.ts` (key on model, not agent), `skills.ts` (Pi `<name>/<description>/<location>` dialect), `src/index.ts` (`before_agent_start` filter → `setActiveTools` + `systemPrompt` rewrite, `agent_end` restore, `tool_call` guard, `/jevselector*` commands), 5 test files (41 tests incl. end-to-end handler wiring with stubbed Pi + mocked Jev), README, LICENSE, root `check` wired in. Verified: `npm run check` clean, `npm run test` 6 files / 61 tests pass. Remaining (needs live key): manual verbose run + token-savings measurement for README.

## Verification

- `npm run check` (tsc -b incl. new package) passes.
- `npm run test` / `vitest run packages/pi-jevselector` passes (ported config/cache/skills tests + new decide/hook tests, no network).
- Manual: `TYPESAFE_API_KEY=... pi -e ./packages/pi-jevselector/src/index.ts` (or project-local install), send a prompt with many skills installed → verbose log shows `skills N→M`, `tools dropped: K`; `agent_end` restores full tool list (`/tools` or `getActiveTools` shows all); unsetting the key leaves everything exposed with a loud warning (fail open).
- Token check: compare `systemPrompt` length before/after on a sample prompt (same ~4-chars/token estimate table as jevselector README) and record in README.