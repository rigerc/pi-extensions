---
title: "Rebuild pi-system-one settings TUI on pi-tui guidelines"
status: draft
created: "2026-09-29T23:24:53.591Z"
type: refactor
---

# Rebuild pi-system-one settings TUI on pi-tui guidelines

Rewrite `packages/pi-system-one/src/settings-ui.ts` (786 lines) as a small, guideline-compliant
component tree built from `@earendil-works/pi-tui` primitives, keeping the `/system-one-settings`
command and the documented tab structure.

## Decisions (agreed)

| Question | Decision |
|---|---|
| Apply model | **Immediate apply** — every change saves to the user file and applies live. No draft, no Ctrl+S, no discard confirmation. README updated. |
| Structure | **Keep tabs** (Modes / Classifier / Status / Actions), rebuilt as one component with correct focus, mouse, and keybinding handling. |
| Diagnostics | **Scrollable panels** — Auth / Session / pi-herdsman open `Text` + `ScrollView` panels with full wrapping and keyboard/wheel scrolling. |
| Provider picker | **Two-step SelectList** — step 1 provider (searchable, remedies for unavailable), step 2 model from that provider. |

## Why (audit of the current file)

Guideline violations in `src/settings-ui.ts`:

1. `render()` calls `refresh()`, which mutates `SettingItem.description` and every list's values — state mutation inside render. (pi-tui: render is a pure projection; caches clear in `invalidate()`.)
2. No `handleMouse` at all, so `SettingsList`'s built-in click/wheel support is unreachable; mouse is dead in fullscreen mode.
3. The injected `KeybindingsManager` from `ctx.ui.custom` is ignored (`_keybindings`); Tab/Ctrl+S are hardcoded.
4. Hand-rolled `InfoSubmenu` truncates every line (`truncateToWidth`) instead of wrapping; long effective-value lines are lost. No scrolling for long diagnostics.
5. Four `SettingsList` instances plus a hand-built tab bar and footer; submenu-open state shimmed by wrapping `item.submenu`.
6. `TextInputSubmenu` / `ProviderSubmenu` reinvent `SelectList`, focus, and IME handling; the connectivity test is uncancellable and has no spinner (`CancellableLoader` exists in pi-tui).
7. `settingsUiTheme` and list theme are constructed but never invalidated on theme change.

## Target architecture

Keep `src/settings-ui.ts` as the public entry (command registration + re-exports) and split the UI
into focused modules (flat files, matching package style):

```text
src/settings-ui.ts          # registerSystemOneSettingsCommand, ctx.ui.custom wiring, re-exports
src/settings-theme.ts       # SettingsUiTheme, settingsUiTheme(theme)
src/settings-rows.ts        # SETTING_SPECS → SettingItem rows, tab mapping, derived status rows
src/settings-submenus.ts    # SelectSubmenu, ProviderPickerSubmenu, TextInputSubmenu,
                            # ScrollPanelSubmenu, ConnectivitySubmenu
src/settings-app.ts         # SettingsApp: tabs, per-tab SettingsList, input/mouse routing, feedback
```

Component tree per render:

```text
SettingsApp (extends Container, implements Focusable)
├── DynamicBorder
├── Text("  pi-system-one settings")
├── Text(tab bar)                       # active tab highlighted
├── SettingsList (active tab only)      # enableSearch: true, per-tab search state
│   └── submenu (when open): SelectSubmenu | ProviderPickerSubmenu |
│                            TextInputSubmenu | ScrollPanelSubmenu | ConnectivitySubmenu
├── Text(feedback line)
├── Text(hint line: Tab switch · Enter change · Esc close, via rawKeyHint)
└── DynamicBorder
```

### State flow (immediate apply)

- `SettingsApp` holds: `activeTab`, one `SettingsList` per tab, `feedback`, `openSubmenu`.
- Row changes arrive through `SettingsList.onChange(id, newValue)`:
  - `isSettingKey(id)` → `coerceSetting`; call `settings.set(key, value)`.
  - Success → success feedback; `refreshDerivedRows()`.
  - Throw/false → restore the row via `list.updateValue(id, formatSettingValue(settings.values[key]))`,
    error feedback, live state unchanged (`saveUserSettings` writes the file before mutating state).
- Provider pick calls `settings.saveUserSettings({ provider, model })` once (atomic), then refreshes.
- `refreshDerivedRows()` is called from event handlers only; `render()` never mutates.
- Status rows share the row-building code but are read-only; panel submenus take a snapshot when opened.

### Submenus (all in `src/settings-submenus.ts`)

- `SelectSubmenu` (generic base, mirrors pi's own `settings-submenu.js` pattern):
  `Container [ Text(title), Text(description), Input(search)?, Spacer, SelectList, Spacer, Text(hint) ]`.
  Nav keys route to `SelectList`; other keys go to the search `Input` + `fuzzyFilter` (exported by
  pi-tui) rebuild of the list; `onSelect` / `onCancel` callbacks; implements `Focusable` and
  propagates `focused` to the search `Input` so IME `CURSOR_MARKER` is emitted.
- `ProviderPickerSubmenu`: two steps over `SelectSubmenu`. Step 1: `auto`, then each catalog
  provider (label + `api`), then providers with no credentials marked unavailable with the remedy
  (`run /login <provider>`, `load a model with /llama`); Enter on an unavailable entry shows the
  remedy instead of advancing. Step 2: that provider's models, preselecting the current one.
  Esc at step 2 → step 1; Esc at step 1 → close. Final pick → `onPick(provider, model)`.
- `TextInputSubmenu`: `Input` focused on open, Enter applies (trimmed, `done(value)`), Esc cancels,
  empty allowed only where the spec allows it, inline error for required-empty.
- `ScrollPanelSubmenu`: `Container [ Text(title), Spacer, ScrollView(Text(body), { scrollbar: "auto", overscroll: "contain" }), Spacer, Text(hint) ]`.
  Body lines are wrapped by `Text` (no truncation). Keys: up/down `scrollBy(±1)`,
  pageUp/pageDown `scrollBy(±viewportHeight−1)`, home/end `scrollToStart/End`, Enter/Esc close.
  Wheel is forwarded to the `ScrollView`; other mouse events pass through/undefined.
- `ConnectivitySubmenu`: `CancellableLoader(tui, warning, dim, "Running one System One request…")`
  + `client.evaluate(request, loader.signal)`. Esc aborts (loader's own handler) and shows
  `Cancelled.`; success shows model / answer / tokens / cost / elapsed; failure shows the error
  plus the existing hint. `onFinished` refreshes the Auth and Session rows. `loader.stop()` on close.

### App behavior details

- **Tabs**: Tab / Shift+Tab switch, hints rendered with `rawKeyHint("Tab", …)` / `rawKeyHint("Shift+Tab", …)`.
  Tab is intercepted only while no submenu is open; each tab keeps its own search and selection.
- **Keybindings**: use the injected `KeybindingsManager` for confirm/cancel matches in wrapper code;
  rely on `SettingsList`/`SelectList` for their own `tui.select.*` handling.
- **Mouse**: `render()` records chrome line counts; `handleMouse` maps tab-bar clicks to tab switches
  and forwards list-area events with `y - listTop` to the active list's `handleMouse`; panel submenus
  get wheel forwarded as above. Works in fullscreen (`TuiAltScreen`); harmless in main screen.
- **Focus/IME**: `SettingsApp implements Focusable`; the setter propagates to the active submenu and to
  the active list's search `Input`. Because `SettingsList` keeps its search input private, use a narrow
  documented accessor (`settingsListSearch(list)` structural cast) with a comment and a test; this
  mirrors what pi's own settings UI relies on and isolates the one private touch-point.
- **Overlay**: `ctx.ui.custom(factory, { overlay: true, overlayOptions: { width: "85%", minWidth: 56, maxHeight: "85%", margin: 1 } })`;
  verify down to ~40 columns; no `visible` callback (it would capture input while invisible).
- **Catalog**: `loadProviderCatalog` stays, called once per open; herdsman status snapshot unchanged.

## Behavioral contract to preserve

- `/system-one-settings` name and description; tabs and their contents.
- Rows for every `SETTING_SPECS` entry, grouped by `spec.group`; boolean on/off, enums, text submenus,
  `(provider default)` for empty temperature.
- Provider list includes unauthenticated providers with remedies; never silently changes the pin.
- Auth row never reads or displays secrets; `/login` / `/llama` guidance.
- Status rows: session counters, effective values + provenance, save target, pi-herdsman detection.
- `systemOneTools` grant and `system_one_orchestrate` gating through `SettingsService.apply()`.
- Failed writes leave live settings unchanged and surface an inline error.

## Phases

### Phase 1 — Rows and theme as pure modules
1. Create `src/settings-theme.ts` (move `SettingsUiTheme`, `settingsUiTheme`).
2. Create `src/settings-rows.ts`: `ProviderCatalog`, `loadProviderCatalog`, provider/model grouping
   (provider-level groups + models), `buildSettingItems` returning `SettingItem[]` + tab key, plus a
   `buildDerivedRows(settings, client, catalog, herdsman)` helper. No callbacks in row builders except
   submenu factories.
3. `src/settings-ui.ts` re-exports the public names (`buildSettingItems`, `loadProviderCatalog`,
   `settingsUiTheme`, types) so external imports and tests keep compiling.

**Verification**: `npm run check`; adapt existing row tests in `test/settings-ui.test.ts`; provider
group/unit tests still pass; grep that `settings-rows.ts` has no render/requestRender calls.

### Phase 2 — Submenu components
1. Implement `SelectSubmenu`, `ProviderPickerSubmenu`, `TextInputSubmenu`, `ScrollPanelSubmenu`,
   `ConnectivitySubmenu` in `src/settings-submenus.ts`.
2. Each: constructor-time themed strings, `render(width)` ≤ width (`visibleWidth` test), `invalidate()`,
   `Focusable` where it owns an `Input`.

**Verification**: new unit tests drive `handleInput` / `render` directly: provider two-step incl. back
nav and unavailable remedy, text validation/empty temperature, panel wrapping + `scrollBy` bounds,
connectivity success/failure/abort with a fake client. `npm run check`.

⏸️ Pause: review component APIs before wiring the app.

### Phase 3 — SettingsApp
1. Implement `SettingsApp` with per-tab lists, immediate-apply `onChange`, `refreshDerivedRows`,
   feedback line, tab switching (blocked while a submenu is open), mouse mapping, focus propagation,
   `invalidate()`.
2. Remove `confirmDiscard`, `save()`, `refresh()`-in-render, and the submenu-open shim.

**Verification**: component tests for: tab switch + per-tab search persistence, toggle applies
immediately (file written, live value changed, row updated), failed write reverts row, Esc closes
overlay, Esc inside submenu only closes submenu, width fuzz 32–120 across tabs and submenus,
`CURSOR_MARKER` present when focused, mouse click/wheel mapping.

### Phase 4 — Command wiring and integration tests
1. Rewrite `registerSystemOneSettingsCommand` to build `SettingsApp` in the `ctx.ui.custom` factory
   with `tui`, `theme`, `keybindings`, catalog, and herdsman snapshot; add overlay options.
2. Replace draft-era tests in `test/settings-ui-integration.test.ts` (delete Ctrl+S, discard, unsaved
   counters, tab-search-draft cases; keep/extend provider, temperature, tools, escape semantics).
3. Keep `test/settings-harness.ts`; add a catalog snapshot fake to it if it reduces duplication.

**Verification**: `npm --prefix packages/pi-system-one test` (full suite), `npm run check`.

⏸️ Pause: manual smoke test before docs.

### Phase 5 — Docs, changelog, manual verification
1. README “Settings & persistence” and command list: immediate apply, tab behavior, two-step provider
   picker, scrollable diagnostics, failure behavior. Remove Ctrl+S / draft wording.
2. `CHANGELOG.md` entry under Unreleased.
3. Manual: `pi` with the extension → `/system-one-settings` at 120/80/40 columns; toggle a mode and
   confirm the file + live effect; provider two-step; temperature edit; diagnostics panels scroll;
   fullscreen mode: mouse click and wheel; `Esc` closes everywhere it should.

**Verification**: `npm run check` and `npm --prefix packages/pi-system-one test` green; manual checklist done.

## Test migration map

| Current test (file) | Action |
|---|---|
| Rows generated for every group; boolean/provider/text row shape (`settings-ui.test.ts`) | Keep, adjust imports/API |
| `InfoSubmenu`, `ProviderSubmenu` units | Replace with `ScrollPanelSubmenu` / `ProviderPickerSubmenu` units |
| `TextInputSubmenu` units | Keep, adapt to `done(value)` immediate semantics |
| Tab rendering, search per tab, narrow width (`settings-ui-integration.test.ts`) | Keep, rewrite against new app |
| Ctrl+S save, discard confirm, unsaved counter, failed-save-keeps-draft | Delete; replace with immediate-apply + failed-write-reverts |
| Provider select in real editor; unauth refusal; temperature edit; escape submenu | Keep, adapt key sequences (no Ctrl+S) |
| — | New: mouse mapping, tab blocked while submenu open, panel scrolling, focus marker, provider step-2 back |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `SettingsList` search input is private (no `focused` propagation upstream; pi's own settings has the same gap) | One documented structural accessor + `CURSOR_MARKER` test; fall back to a custom search row if pi-tui changes |
| Immediate apply multiplies file writes | Single tiny JSON merge write per change; same semantics as `/system-one <mode> on|off` |
| Two-step provider hides the “all classifiers at a glance” view | Keep provider descriptions + `auto` first; Esc returns one step; model row still pins arbitrary names |
| Tab handling collides with search input | Intercept Tab/Shift+Tab in `SettingsApp` before delegating; skip while a submenu is open |
| Overlay chrome squeezes narrow terminals | Width fuzz test at 32–120; `minWidth: 56` plus clamping; verify at 40 columns manually |
| pi-tui/pi-coding-agent API drift (peer `>=0.99 <1.0`) | Depend only on exported names (`SettingsList`, `SelectList`, `ScrollView`, `Text`, `DynamicBorder`, `getSettingsListTheme`, `getSelectListTheme`, `rawKeyHint`, `fuzzyFilter`); no other private access |

## Acceptance criteria

- `render()` performs no state mutation anywhere in `src/settings-ui*.ts` / `src/settings-*.ts`.
- All rendered lines stay within width for widths 32–120 across every tab and submenu.
- Toggling/selecting applies immediately: file write, live mode update, row refresh, feedback.
- Failed write: row reverts, error shown, live settings and file unchanged.
- Mouse: click toggles/selects rows and switches tabs; wheel scrolls list and panels (fullscreen).
- Focus: active `Input` (search or text submenu) emits `CURSOR_MARKER`; IME positioning intact.
- Diagnostics render full, wrapped content and scroll; no secrets anywhere.
- Esc: closes submenu first, then overlay; no discard confirmation (nothing to discard).
- `npm run check` and `npm --prefix packages/pi-system-one test` pass; README and CHANGELOG updated.

## Out of scope

- `SettingsService`, config layering, and persistence semantics (unchanged).
- Thresholds/limits remain code constants.
- Other commands’ `ctx.ui.notify` flows.
