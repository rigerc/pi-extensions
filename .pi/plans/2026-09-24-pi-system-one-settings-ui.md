# Improve pi-system-one settings UI

Status: superseded in part by the later user-file Save/Discard request

The tab layout and visual feedback were implemented. The later request replaced
immediate edits and the Persist/Reset actions with a draft, Save to user file, and
Discard flow. Project files remain readable at their existing precedence.

## Goal

Make `/system-one-settings` easier to scan and operate in a terminal while keeping its
existing live setting changes, session persistence, provider diagnostics, and actions.

## Current state

- `src/settings-ui.ts` renders one 16-row `SettingsList`; every row repeats a group name.
  Search helps find a known setting, but browsing requires scrolling through unrelated rows.
- The header explains persistence once, but setting changes, successful file writes, empty
  writes, and resets do not give clear in-overlay feedback. A file error can escape the
  action callback.
- `SettingsList` mutates a row's displayed value before calling `onChange`. Most rows are
  built only when the overlay opens, so reset and rejected changes can leave stale values.
- Both reset choices are immediately executable. The option that deletes settings files
  needs a separate confirmation step.
- The theme uses accent and dim text, but success, warning, and error states look similar.
- The working tree already has unrelated edits in `README.md`, `extensions/index.ts`,
  `src/system-one.ts`, and `test/laya-health.test.ts`; implementation must preserve them.

## Proposed interaction

Four tabs: **Modes**, **Provider**, **Status**, **Actions**. Open on Modes. Each tab uses
the existing searchable `SettingsList` so Up/Down, Enter/Space, typing to search, and Esc
remain familiar. Tab and Shift+Tab switch tabs while the list is active; a submenu owns
all keys until it closes. Keep each tab's selection and search text when switching. Show
the active tab with accent plus brackets/underline so it remains legible without color.
At narrow widths, use compact tab labels and truncate help text safely.

```text
╭─ System One settings ──────────────────────────────────────╮
│ [Modes]  Provider  Status  Actions                         │
│ Changes apply now · Session changes need Persist to file  │
│ Search modes…                                              │
│ → Auto tool routing                 on                     │
│   Auto skill routing                off                    │
│   Auto-model                        off                    │
│                                                            │
│ Activate tools before a turn · Source: session             │
│ ✓ Auto tool routing enabled for this session               │
│ Tab switch · ↑↓ move · Enter/Space change · Esc close       │
╰────────────────────────────────────────────────────────────╯
```

The Provider tab holds Provider, Base URL, Model, and the read-only API key source. The
Status tab holds the live session summary and provenance detail. The Actions tab holds
Laya health, connectivity test, Persist to file, and Reset to defaults. Avoid repeating
the tab name in row labels; keep descriptive submenu titles.

Use theme semantic colors: accent for focus, success for enabled/healthy/saved, muted for
off/read-only, warning for session-only changes or missing configuration, and error for
failed probes or writes. Pair each color with words or symbols. Keep the API key masked.

## Implementation steps

1. Extract a small tab definition and a tabbed overlay controller in `src/settings-ui.ts`.
   Partition existing `SettingItem`s by their spec group or stable status/action IDs.
   Create one `SettingsList` per tab, keep its instance while switching, and route keys to
   the active list. Track submenu open/close through the submenu callbacks rather than
   reading `SettingsList` private fields; Tab must never switch tabs while editing text,
   viewing a result, or choosing an action.
2. Render a compact header, tab bar, context line, active list, feedback line, and footer.
   Truncate each part to the terminal width. The footer must distinguish Esc in the list
   (close overlay) from Esc in a submenu (return to tab). Search applies to the active tab.
3. Add a single refresh path that syncs all editable values, API key source, and session
   counters from `SettingsService` and `SystemOneClient` after every change or action.
   Recompute source text from `resolvedSettings.provenance`. On rejected input, restore the
   actual value in the row and show a warning. Do not alter setting precedence.
4. Add in-overlay feedback for setting changes, successful and empty persists, reset
   scope, and failures. Catch file I/O errors at the action boundary and keep the overlay
   usable. For connectivity and Laya health, show distinct running/success/error states
   using semantic colors and actionable text. Avoid network requests during ordinary
   rendering or tab switches.
5. Make the file-deleting reset choice require a second explicit confirmation that names
   both affected paths. Esc cancels. Keep session-only reset one step. Refresh all tabs
   after either reset so the displayed values and sources match the effective settings.
6. Update the settings section of `README.md` with the tab map, keyboard shortcuts,
   immediate/session-only behavior, file action feedback, and destructive reset prompt.
   Add a brief `CHANGELOG.md` entry if this is a user-visible release change.

## Verification

- Extend `test/settings-ui-integration.test.ts` to exercise tab cycling in both directions,
  per-tab selection/search retention, Tab inside a submenu, Esc behavior, and narrow-width
  rendering. Assert the settings and live controllers still change immediately.
- Cover reset refresh, rejected values, persist with no overrides, a successful write,
  caught file errors, and cancellation/confirmation of file deletion. Use temp paths; no
  real user settings files or provider request is needed for these tests.
- Extend `test/settings-ui.test.ts` only for new behavior that has a meaningful isolated
  contract, such as semantic feedback and the confirmation submenu.
- Run `npm run check` and `npm run test` from the repository root. Inspect the final diff
  to ensure unrelated working-tree edits and key masking are preserved.

## Done when

- All 16 existing rows remain reachable under the four tabs and search still works.
- A user can tell what changed, whether it is session-only, where a setting came from,
  and whether an action succeeded or failed without leaving the overlay.
- Reset and rejected edits cannot leave stale values on screen; file deletion requires an
  explicit confirmation; terminal width and keyboard navigation remain usable.
- Existing settings semantics and API key handling are unchanged, and typecheck/tests pass.
