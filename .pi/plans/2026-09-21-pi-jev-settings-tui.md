---
title: "pi-jev Settings TUI (full scope) with layered persistent config"
status: draft
created: "2026-09-21T20:52:39.090Z"
type: feature
---

# pi-jev Settings TUI (full scope)

## Goal

Add `/jev-settings`, a single interactive surface for **every** runtime-tunable pi-jev
setting: mode toggles, thresholds, request limits, provider/model, live status, and
actions. Settings become persistent through a layered config model instead of the
current in-memory-only session state.

Built on pi-tui's built-in `SettingsList` (flat list + fuzzy search), per the chosen
entry-point option — not a custom form component.

## Status — implemented (scope reduced)

Branch `feature/openrouter-provider` @ `bc66220`.

**Scope change during review: the Thresholds and Limits groups are OUT** ("Scope: No
thresholds/limits groups"). Those settings stay code constants, which removed the riskiest
part of the original plan — the refactor of the seven modules that read them. What shipped
is **Modes + Provider + Status/Actions**.

| Phase | Result |
| --- | --- |
| 1 — Config core | ✅ `src/config.ts` (registry, coercion, layered merge + provenance), `src/config-store.ts` (atomic versioned file IO, session entries), `src/settings.ts` (init / set / persistToFile / resetToDefaults / apply) |
| 2 — UI | ✅ `src/settings-ui.ts`: real `SettingsList` + `getSettingsListTheme()`, `enableSearch: true`, and submenu components for text input, info, choices, and a live connectivity test. Action rows call submenu `done()` with **no** value, so they are never treated as a setting change. |
| 3 — Tests | ✅ 40 new cases in `test/config.test.ts`, `test/settings.test.ts`, `test/settings-ui.test.ts`, `test/settings-ui-integration.test.ts`. **107 passing** (was 67). |
| 4 — Docs | ✅ README "Settings & persistence" (layers, precedence table, persist workflow, no-secrets policy); CHANGELOG 0.7.0 |

**Verification evidence**

- `npm run typecheck` clean; `npm test` 107/107; `npm ci` succeeds from a clean install.
- Extension loads under real pi v0.86.1 and registers all five `--jev-*` flags.
- Headless end-to-end against the real `SettingsList`: overlay renders the search hint and
  Modes/Provider/Status/Actions rows; `space` on the Tool guard row set the value, applied it
  to the live controller, and appended `{"toolGuard":true}`; the Provider row cycled
  auto → typesafe → openrouter; the Base URL submenu opened the real `Input`, typed a URL,
  saved it, and pushed provider overrides; `Esc` inside a submenu closed only the submenu.

**Deviations from the written plan**

- Thresholds/Limits cut per review, so no threshold refactor was needed at all.
- Flat layout (`src/config.ts`, `src/config-store.ts`, `src/settings.ts`, `src/settings-ui.ts`)
  instead of a `src/config/` directory — the reduced surface did not justify the extra files.
- `SettingsService` accepts path overrides so tests never read `$HOME` or the real cwd.
- Found that `getSettingsListTheme()` throws unless `initTheme()` has run; the integration test
  initializes it, matching what a real session does before any command executes.
- Not pushed to `origin`.
- **Follow-up (`5340038`)**: auto routing was split into two independent settings —
  `autoToolRouting` and `autoSkillRouting` — so the Modes group now has seven rows, not
  six, and `/jev auto` became a master switch over both paths. The registry gained a
  `MASTER_SWITCHES` concept (a master expands to several keys, applied before individual
  specs within the same layer, so a specific setting still wins). This also corrected the
  auto-mode cost claim: the two paths issue separate Jev requests.

## Context

**pi-jev persists nothing today.** All six modes live in in-memory booleans that reset
every session, and four thresholds plus four limits are module constants. Knobs are
reachable only through `--jev-*` flags, `PI_JEV_*` env vars, and `/jev <mode> on|off`.

### Complete knob inventory (the "full scope" surface)

| Group | Setting | Today | Location |
| --- | --- | --- | --- |
| Modes | auto routing | `enabled` (session) | `src/auto.ts` |
| Modes | auto-model | `enabled` (session) | `src/model-router.ts` |
| Modes | agent orchestration | `enabled` (session) | `src/orchestrator.ts` |
| Modes | tool guard | `enabled` (session) | `src/tool-guard.ts` |
| Modes | Jev compaction | `enabled` (session) | `src/compact.ts` |
| Modes | `jev_*` tools granted | active-tool set | `src/commands.ts` `enable`/`disable` |
| Thresholds | activation (`JEV_THRESHOLD`) | `0.65` const | `src/skills.ts` |
| Thresholds | compaction keep | `0.55` const | `src/compact.ts` |
| Thresholds | hallucination cutoff | `0.85` inline | `src/tool-guard.ts` |
| Thresholds | model-router confidence floor | `0.6` inline | `src/model-router.ts` |
| Limits | compaction max entries | `24` const | `src/compact.ts` |
| Limits | tool candidate cap | `10` inline | `src/router.ts` |
| Limits | skill candidate cap | `12` inline | `src/skills.ts` |
| Limits | max designed questions | `6` const | `src/designer.ts` |
| Provider | provider / base URL / model | env only | `src/jev.ts` |
| Provider | API key + secret dir | env / secret file | `src/jev.ts` |
| Status | requests, tokens, cost, fallback | `/jev status` text | `src/commands.ts` |

### Verified pi APIs this plan depends on

- `SettingsList` / `SettingItem` from `@earendil-works/pi-tui`:
  - `values?: string[]` → Enter/Space cycles values (booleans, enums, stepped numbers)
  - `submenu?: (currentValue, done) => Component` → Enter opens **any** component, so
    free-text input, status readout, and confirm-actions all fit the built-in list
  - `updateValue(id, newValue)` and `selectItem(id)` → refresh rows after external change
  - `options.enableSearch` → fuzzy filter by label
  - constructor: `(items, maxVisible, theme, onChange, onCancel, options)`
- `getSettingsListTheme()` is exported from `@earendil-works/pi-coding-agent`.
- `pi.appendEntry(customType, data)` + `ctx.sessionManager.getBranch()` is the
  established session-persistence pattern in this repo (`packages/pi-jevselector/src/index.ts`).
- `registerFlag(name, { type: "boolean", default })` — flags are effectively on-only,
  so they stay a *forcing* layer rather than an editable value.

## Decisions (from review)

1. **Persistence: layered.** `~/.pi/agent/pi-jev.json` (user) → `<project>/.pi/pi-jev.json`
   (project) → session overrides (`pi.appendEntry`).
2. **Credentials: provider editable, keys never persisted.** The TUI shows key presence,
   masked, with its source and a pointer to the secret store. No secret is ever written
   to a config file or a session entry.
3. **Entry point: `/jev-settings`**, built-in `SettingsList` with `enableSearch: true`.
4. **Scope: all four groups**, with enable/disable of features treated as a first-class
   concern (the mode rows are the primary affordance).
   **Amended: Thresholds and Limits were cut during review — see Status above.** The
   remaining groups are Modes, Provider, and Status/Actions.

**Interpretation to confirm:** the scope answer was given as free text ("Also allow to
enable/disable features") rather than a selection, so this plan includes **all four**
groups — modes, thresholds, limits, and status/actions — and treats mode enable/disable
as the headline feature. Drop any group during review if that reads too broad.

## Architecture

### One declarative registry, three consumers

`src/config/schema.ts` is the single source of truth. Each setting declares its id,
group, type, default, constraints, help text, and serialization. The TUI rows, file
validation, and `/jev status` provenance are all generated from it — adding a setting is
one entry, not four edits.

```ts
export type SettingType = "boolean" | "number" | "enum" | "string" | "readonly";

export interface SettingSpec {
  id: string;                       // "activationThreshold"
  label: string;                    // "Thresholds · Activation"
  group: "Modes" | "Thresholds" | "Limits" | "Provider" | "Status";
  type: SettingType;
  description: string;              // shown as the row description / help
  default: string | number | boolean;
  values?: string[];                // type: enum  → SettingsList cycles these
  step?: number; min?: number; max?: number;  // type: number
  /** Values accepted from files/env; rejects anything else rather than coercing. */
  parse?: (raw: unknown) => string | number | boolean | undefined;
  /** Never written to disk or session entries (credentials). */
  secret?: boolean;
}

export const SETTINGS: SettingSpec[] = [ /* ~21 entries */ ];
```

### Layering and provenance

`src/config/effective.ts` merges layers lowest → highest and records **which layer won
each key**, so `/jev status` and the TUI descriptions can show `0.65 (default)`,
`openrouter (env)`, `auto: on (session)`.

```
built-in defaults
  → ~/.pi/agent/pi-jev.json        (user file)
  → <project>/.pi/pi-jev.json      (project file)
  → PI_JEV_* environment           (runtime override)
  → --jev-* CLI flag               (on-only, for booleans)
  → session overrides              (appendEntry; written by the TUI and /jev … on|off)
```

This preserves today's behavior exactly: env still wins over files, and `--jev-auto`
still forces auto routing on. The only change is that flags stop *reading* env
(`registerFlag(..., default: false)`); env moves into the config layer where it can be
observed and displayed.

```ts
export interface EffectiveConfig {
  values: Record<string, string | number | boolean>;
  provenance: Record<string, "default" | "user" | "project" | "env" | "flag" | "session">;
}
export function resolveEffectiveConfig(opts: {
  user?: RawSettings; project?: RawSettings; env?: NodeJS.ProcessEnv;
  flag?: (name: string) => boolean; session?: RawSettings;
}): EffectiveConfig;
```

`src/config/store.ts` owns IO only: reading/writing the two JSON files and
reading/appending session entries. Writes are atomic (temp file + `rename`), the user
file is created `0600`, directories are `mkdir -p`'d, and a `version` field is written
for forward compatibility.

### Provider wiring

`src/jev.ts` keeps `JEV_PROVIDERS` as the single source of truth for per-provider base
URLs. The new `baseURL` setting defaults to `""`, meaning "provider default"; `buildConfig`
falls back to `JEV_PROVIDERS[provider].baseURL` when the effective value is empty. This
avoids moving provider tables or duplicating URLs.

Dependency direction is one-way: `src/config/*` is pure and imports nothing from
`jev.ts`; `jev.ts` and the mode classes import `config`.

### Live application

After any change, `applyConfig(services)` pushes the effective values into the live
objects — `auto.setEnabled`, `autoModel.setEnabled`, `agents.setEnabled`,
`toolGuard.setEnabled`, `compactor.setEnabled`, `pi.setActiveTools` for the `jev_*` grant.
Thresholds take effect immediately because consumers read the effective config at call
time instead of importing a constant:

```ts
// src/skills.ts — keep the constant as the default for back-compat (tests import it)
export const JEV_THRESHOLD = SETTING_DEFAULTS.activationThreshold;
// ...but consumers now read the live value:
const threshold = getConfig().activationThreshold;
```

`ToolRouter` / `SkillRouter` / `AutoJev` gain an optional config-provider parameter
defaulting to the global effective config, so existing tests that construct them with
`(pi, jevClient)` keep working.

### Interaction model

`SettingsList` calls `onChange` per edit, so:

- **Edits apply live and persist to the session layer immediately.** No lost work if the
  list is closed abruptly; the trade-off is that Esc closes rather than reverts (this
  differs from the sibling `pi-jevselector` draft+save form — the built-in list has no
  confirm exit).
- **"Persist to file" is an explicit action row** with a submenu choosing
  user / project / both. Session edits do not silently rewrite files.
- **"Reset to defaults"** is an action row with a `yes`/`no` submenu; it clears session
  overrides and, when asked, the matching file entries.

### Row inventory (~21 rows, flat list with `group · label` prefixes)

| Row | Type | Presentation |
| --- | --- | --- |
| Modes · Auto routing | boolean | `["on","off"]` cycle |
| Modes · Auto-model | boolean | cycle |
| Modes · Agent orchestration | boolean | cycle |
| Modes · Auto-agents (dispatch) | boolean | cycle |
| Modes · Tool guard | boolean | cycle |
| Modes · Jev compaction | boolean | cycle |
| Modes · Jev tools granted | boolean | cycle → `pi.setActiveTools` |
| Thresholds · Activation | number | `values: 0.50…0.95 step 0.05` (cycling avoids free-text) |
| Thresholds · Compaction keep | number | same ladder |
| Thresholds · Hallucination cutoff | number | same ladder |
| Thresholds · Model-router confidence | number | same ladder |
| Limits · Compaction max entries | enum | `["8","12","24","48"]` |
| Limits · Tool candidates | enum | `["4","8","10","16"]` |
| Limits · Skill candidates | enum | `["4","8","12","16"]` |
| Limits · Max designed questions | enum | `["2","4","6","8"]` |
| Provider · Provider | enum | `["auto","typesafe","openrouter"]` |
| Provider · Base URL | string | **submenu** with `Input`; empty = provider default |
| Provider · Model | string | **submenu** with `Input` (default `jev-latest`) |
| Provider · API key | readonly | masked + source + secret-store path (`secret: true`) |
| Status · Session | readonly | **submenu** readout: requests, tokens, cost, fallback, model |
| Actions · Test connectivity | action | **submenu**: runs `evaluate()` on a fixed prompt, shows result |
| Actions · Persist to file | action | **submenu**: user / project / both |
| Actions · Reset to defaults | action | **submenu**: confirm yes/no |

Numeric settings with a bounded ladder use `values[]` cycling because `SettingsList` has
no numeric editor; the `step/min/max` fields in the registry still drive validation and
the `←`/`→` affordance documented in each row description.

Every `secret: true` spec is asserted (by test) to never appear in a written file or a
session entry.

## Files

| File | Change |
| --- | --- |
| `src/config/schema.ts` | **new** — `SETTINGS` registry, defaults, parse/validate |
| `src/config/effective.ts` | **new** — layered merge + provenance |
| `src/config/store.ts` | **new** — atomic file IO, session entry read/append, paths |
| `src/config/index.ts` | **new** — `getConfig()`, `setSetting()`, `applyConfig(services)` |
| `src/settings-ui.ts` | **new** — `SettingsList` rows, submenu components (text, status, actions) |
| `src/index.ts` | register `/jev-settings`; build services; apply config on `session_start`; flags no longer read env |
| `src/commands.ts` | `/jev-settings` aliases; `/jev <mode> on\|off` writes through to session overrides; `/jev status` shows provenance |
| `src/skills.ts`, `src/router.ts`, `src/auto.ts`, `src/compact.ts`, `src/tool-guard.ts`, `src/model-router.ts`, `src/designer.ts` | read live config instead of module constants |
| `src/jev.ts` | honour effective provider/model/base URL; empty `baseURL` = provider default |
| `src/index.ts` (`registerFlag`) | `--jev-*` flags become on-only forcing layer |
| `test/config.test.ts` | **new** — precedence, provenance, validation, secret redaction |
| `test/settings-ui.test.ts` | **new** — row generation from registry, submenu value round-trip |
| `README.md`, `CHANGELOG.md` | document `/jev-settings`, config files, precedence table |

## Phases

### Phase 1 — Config core (no UI)

1. `src/config/schema.ts`: registry with all ~21 specs, defaults, parsers.
2. `src/config/effective.ts`: merge + provenance.
3. `src/config/store.ts`: paths, atomic read/write, session entries.
4. Refactor the seven modules to read live config; keep `JEV_THRESHOLD` and
   `MAX_DESIGNED_QUESTIONS` exported as defaults so existing tests still compile.
5. Flags: `registerFlag(..., default: false)`; config layer reads `PI_JEV_*`.

**Verify:** `npm run typecheck && npm test` — all 67 existing tests still green.

⏸️ **Pause** — confirm the precedence table and that env still wins over files before building UI.

### Phase 2 — UI

6. `src/settings-ui.ts`: build `SettingItem[]` from `SETTINGS`, `getSettingsListTheme()`,
   `enableSearch: true`, `maxVisible` sized to the terminal.
7. Submenu components: `TextSettingInput` (uses `Input`, returns on Enter), `StatusReadout`,
   `ConfirmAction`, `TestConnectivity`, `PersistToFile`.
8. `registerCommand("jev-settings")` in `src/index.ts` via `ctx.ui.custom(..., { overlay: true })`;
   `onChange` → `setSetting()` + `applyConfig()`; `updateValue`/`selectItem` to refresh.

**Verify:** manual — open `/jev-settings`, toggle each mode, adjust a threshold, edit Base URL
and Model, run Test connectivity, Persist to file, Reset; confirm `/jev status` reflects
every change with correct provenance.

### Phase 3 — Tests

9. `test/config.test.ts`:
   - `test_effective_config_precedence_defaults_user_project_env_flag_session`
   - `test_provenance_reports_the_winning_layer_per_key`
   - `test_invalid_file_values_are_ignored_not_coerced`
   - `test_secrets_never_appear_in_written_files_or_session_entries`
   - `test_atomic_write_survives_a_partial_write` (temp file left behind, target intact)
   - `test_empty_base_url_resolves_to_the_provider_default`
10. `test/settings-ui.test.ts`:
    - `test_rows_are_generated_from_the_registry_for_every_group`
    - `test_every_boolean_and_enum_spec_has_cycling_values`
    - `test_text_submenu_round_trips_and_rejects_empty`
11. Extend `test/commands.test.ts`: `/jev auto on` writes a session override that
    `/jev status` reports as `(session)`.

**Verify:** `npm test` — expect ~85+ passing.

⏸️ **Pause** — review the secret-redaction test result before writing docs.

### Phase 4 — Docs

12. `README.md`: `/jev-settings` in the command table; a "Settings & persistence" section
    with the three layers, the precedence table, file paths, and the explicit
    "edits are session-scoped; use Persist to file" note.
13. `CHANGELOG.md`: `0.7.0` entry (Added: settings TUI, layered config, per-setting
    provenance; Changed: thresholds/limits are now configurable; Fixed: modes no longer
    reset silently on every session).

## Verification

```bash
cd /mnt/extra-ssd/dev/projects2/pi-extensions/packages/pi-jev
npm run typecheck && npm test
```

Manual, in the installed extension:

```text
/jev-settings          → open, search "thresh", cycle 0.65 → 0.55, Esc
/jev status            → Activation: 0.55 (session)
cat ~/.pi/agent/pi-jev.json      → must contain NO api key material
```

Layer checks (each should change the reported value and provenance):

```bash
PI_JEV_ACTIVATION_THRESHOLD=0.9 pi    # env beats project file
# project file beats user file; session edit beats everything
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Threshold refactor touches 7 modules — regression risk | Phase 1 lands with the full existing suite green before any UI exists; `JEV_THRESHOLD` stays exported as the default. |
| Silent behavior change if env precedence is wrong | Precedence table is explicit, covered by a precedence test, and paused for review before UI work. |
| Secrets leaking into files or session entries | `secret: true` specs excluded at the serializer boundary, asserted by test; keys remain env/secret-store only. |
| `SettingsList` has no confirm exit (Esc closes, changes already applied) | Documented explicitly; "Reset to defaults" is the revert path; "Persist to file" is opt-in. |
| Flat list with ~21 rows is hard to scan | `group · label` prefixes + `enableSearch`; `maxVisible` sized to terminal height. |
| Numeric thresholds as `values[]` ladders lose precision | Ladders are 0.05 wide and match the sibling's `THRESHOLD_STEP`; file values are validated against `min`/`max`/`step`. |
| `submenu` `done(selectedValue, { navigateTo })` semantics drift between pi versions | Submenus return plain values and rely only on documented behaviour; `selectItem`/`updateValue` used for refresh. |

## Definition of done

- `/jev-settings` opens as an overlay, is searchable, and lists every setting in the
  inventory table with its current value and provenance.
- All four groups are editable; every mode can be enabled/disabled from the TUI and the
  change takes effect on the next agent turn without a restart.
- Settings resolve through the three layers with the documented precedence, verified by test.
- No API key material is ever written to `~/.pi/agent/pi-jev.json`, `.pi/pi-jev.json`, or
  a session entry.
- `npm run typecheck` and `npm test` pass; README and CHANGELOG updated.
