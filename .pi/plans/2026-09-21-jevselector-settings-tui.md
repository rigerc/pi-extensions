---
title: "TUI Settings for pi-jevselector"
status: draft
created: "2026-09-21T20:17:19.393Z"
type: feature
---

# TUI Settings for pi-jevselector

## Goal
Add an interactive overlay TUI (`/jevselector-settings`) to view and edit all runtime-tunable pi-jevselector settings in one place, replacing the need to remember `/jevselector-threshold`, `/jevselector-toggle`, `/jevselector-verbose`. Existing commands stay as-is (backward compat).

## Context
- `packages/pi-jevselector/src/index.ts` — extension entry, current commands use `ctx.ui.notify` only; `overrides: JevSelectorOverrides` + `cfg` + `save()` via `pi.appendEntry(CONFIG_ENTRY_TYPE, ...)` pattern to keep.
- `packages/pi-jevselector/src/config.ts` — `JevSelectorConfig`, `JevSelectorOverrides` (enabled, keepThreshold, filterSkills, filterTools, alwaysKeepTools/Skills, verbose), `applyOverrides()`. Note: provider/model/baseUrl/apiKey are env-resolved, NOT in overrides — display read-only.
- `packages/pi-model-picker/src/index.ts` — reference TUI pattern: `ctx.ui.custom<T>(factory, { overlay: true })` with `Container`, `DynamicBorder`, `Input`, `Text`, `Key`/`matchesKey` from `@earendil-works/pi-tui`. Copy this overlay shell (header/body/footer), not a new framework.
- Tests: `packages/pi-jevselector/src/config.test.ts`, vitest; typecheck via `npm run check` (tsc -b, includes this package).

## Approach
1. **New file `packages/pi-jevselector/src/settings-ui.ts`** (one responsibility: settings editing). Keep pure draft logic separate from the pi-tui component so it's unit-testable without a TUI:
   - `SettingsDraft` type = editable copy of `JevSelectorOverrides` + read-only snapshot (provider, model, active tool count) for display.
   - Pure helpers: `draftFromConfig(cfg)`, `toggleBool(draft, key)`, `adjustThreshold(draft, delta)` (clamp 0–1, step 0.05), `parseKeepList(str) → string[]`, `formatKeepList(arr)`, `toOverrides(draft) → JevSelectorOverrides`.
   - `SettingsComponent` class modeled on `ModelPickerComponent`: `handleInput(data)`, `render(width, theme)`. Rows:
     - `enabled` (toggle), `keepThreshold` (←/→ or +/- adjust, show bar + value), `filterSkills`, `filterTools`, `verbose` (toggles), `alwaysKeepSkills`, `alwaysKeepTools` (inline edit mode using `Input`; `e`/`Enter` to edit, `Esc` to leave edit mode, comma-separated).
     - Header shows read-only `provider/model`; footer shows key hints.
   - Keys: `↑↓` navigate · `Space/Enter` toggle or edit · `←→` threshold ±0.05 (when row focused) · `e` edit keep-list · `Ctrl+S` or `s` save · `Esc` cancel. `?` optional — keep minimal, single hint line instead.
2. **Wire into `src/index.ts`**: add `pi.registerCommand("jevselector-settings", ...)` that snapshots `cfg` (+ `pi.getActiveTools().length` for display), opens `ctx.ui.custom` overlay with `SettingsComponent`, and on `done(draft | null)` applies via existing `applyOverrides` + `save()` + `ctx.ui.notify` summary. No changes to `before_agent_start`/`agent_end`/`tool_call` logic.
3. **Docs + tests**: README command table gains `/jevselector-settings` row; new `src/settings-ui.test.ts` covering threshold clamp, toggles, keep-list parse/format round-trip, `toOverrides`. Existing `config.test.ts` untouched.

## Alternatives considered
- Simple select-list menu dispatching existing commands: less code but still requires one action per setting, poor for threshold/lists — rejected.
- Replacing `/jevselector` status command with the TUI: breaks muscle memory — rejected; keep status, add new command.
- Editing provider/model in TUI: they're env-resolved and not in overrides; making them editable would require extending the overrides schema and persistence — out of scope, display only.

## Open questions (defaults assumed)
- Answers to scope/entry/style questions were recorded; proceeding with: all tunable settings, new `/jevselector-settings` command, form-style editor. Confirm in review if a `Ctrl+Alt+J` shortcut is also wanted (cheap to add, like model-picker).

## Verification
- `npm run check` (tsc -b) passes.
- `npx vitest run packages/pi-jevselector` passes, including new `settings-ui.test.ts`.
- Manual: `pi -e ./packages/pi-jevselector/src/index.ts`, run `/jevselector-settings`, toggle threshold/filters, save, re-run `/jevselector` to confirm persistence; `Esc` cancels without changes.

## Risks
- pi-tui API drift (`Input`, `Container`, `Key` signatures) — mitigated by copying model-picker usage verbatim and typechecking.
- Keep-list inline editing complexity — mitigated by comma-separated single-line `Input`, no multi-select widget.
