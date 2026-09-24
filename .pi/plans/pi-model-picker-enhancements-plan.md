# Plan: Enhance `packages/pi-model-picker`

## Context

Add the following improvements to `packages/pi-model-picker`:

- explicit quick slots (`Ctrl+Alt+1..3`)
- per-model preferred thinking level
- surfaced stale favorites
- alias/tag search
- sort modes

This work is tracked in Trekker under **EPIC-6**.

## Trekker mapping

| ID | Title |
| --- | --- |
| TREK-54 | Design pi-model-picker state schema for slots, thinking prefs, aliases, and sort mode |
| TREK-55 | Implement state migration and stale favorite detection in pi-model-picker |
| TREK-56 | Add explicit quick slots 1-3 and slot management UI/shortcuts |
| TREK-57 | Add per-model preferred thinking level on selection |
| TREK-58 | Expand search to aliases and tags with management affordances |
| TREK-59 | Add sortable views for model-picker lists |
| TREK-60 | Update pi-model-picker docs and tests for new picker features |

## Goals

- Replace implicit favorite-order quick slots with explicit slots 1–3
- Allow models to carry an optional preferred thinking level
- Preserve and visibly surface stale saved entries instead of silently dropping them
- Expand search beyond provider/id/name to aliases and tags
- Add selectable sort modes for model lists

## Files likely involved

| File | Change |
| --- | --- |
| `packages/pi-model-picker/src/index.ts` | Main implementation for state, picker UI, shortcuts, search, sorting, and selection behavior |
| `packages/pi-model-picker/README.md` | Document new shortcuts, slot behavior, thinking prefs, search, and sorting |
| `packages/pi-model-picker/CHANGELOG.md` | Record new user-facing features |
| `tests/` or package-specific test files | Add regression coverage if test location exists/is added |

## Proposed state evolution

Current state:

```json
{
  "favorites": ["provider/model"]
}
```

Proposed state direction:

```json
{
  "version": 2,
  "favorites": ["provider/model"],
  "quickSlots": {
    "1": "provider/model",
    "2": "provider/model",
    "3": null
  },
  "modelPrefs": {
    "provider/model": {
      "thinkingLevel": "medium",
      "aliases": ["fast"],
      "tags": ["vision", "cheap"]
    }
  },
  "sortMode": "favorites"
}
```

### Suggested schema details

```ts
type ThinkingPref = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type SortMode = "favorites" | "provider" | "name" | "context" | "capability";

type ModelPrefs = {
  thinkingLevel?: ThinkingPref;
  aliases?: string[];
  tags?: string[];
};

type ModelPickerStateV2 = {
  version: 2;
  favorites: string[];
  quickSlots: {
    "1": string | null;
    "2": string | null;
    "3": string | null;
  };
  modelPrefs: Record<string, ModelPrefs>;
  sortMode: SortMode;
};
```

### Migration rules

- If `version` is missing, treat the file as legacy v1.
- v1 `favorites` migrate directly into v2 `favorites`.
- Initialize missing `quickSlots` to `{ "1": null, "2": null, "3": null }`.
- Initialize missing `modelPrefs` to `{}`.
- Initialize missing `sortMode` to `"favorites"`.
- Save back as v2 on the first state-changing write.

### Stale entry model

A stale entry is a saved key like `provider/model` that no longer resolves from `ctx.modelRegistry.getAvailable()`.

Recommended behavior:
- Keep stale keys in persisted state until the user removes them.
- Exclude stale keys from selection actions.
- Surface stale status in list rows/notifications/help text.
- Offer targeted cleanup rather than silent deletion.

Notes:
- Legacy `favorites` must migrate cleanly.
- Missing models should remain representable as stale entries until cleaned up.
- Quick slots should be explicit and independent from favorite order.
- `modelPrefs` should persist even if a model is temporarily stale.

## Feature breakdown

### 1. State design and migration — `TREK-54`, `TREK-55`

- [ ] Define final persisted schema for quick slots, model prefs, aliases/tags, and sort mode
- [ ] Migrate legacy favorites-only state automatically
- [ ] Detect stale favorites and stale quick-slot assignments
- [ ] Surface stale entries in UI and/or notifications
- [ ] Add cleanup behavior for stale entries

### 2. Explicit quick slots — `TREK-56`

- [ ] Limit numbered quick slots to `Ctrl+Alt+1..3`
- [ ] Replace favorite-order slot resolution with explicit slot assignment
- [ ] Add UI affordance to assign/unassign highlighted model to slot 1, 2, or 3
- [ ] Show slot badges/markers in list rows
- [ ] Update quick-slot notifications and empty-slot messaging

### Suggested keybindings / controls

| Key | Action |
| --- | --- |
| `Ctrl+Alt+1` | Switch to quick slot 1 |
| `Ctrl+Alt+2` | Switch to quick slot 2 |
| `Ctrl+Alt+3` | Switch to quick slot 3 |
| `Ctrl+1` | Assign/unassign highlighted model to slot 1 |
| `Ctrl+2` | Assign/unassign highlighted model to slot 2 |
| `Ctrl+3` | Assign/unassign highlighted model to slot 3 |
| `Ctrl+F` | Toggle favorite |
| `Ctrl+T` | Cycle preferred thinking level for highlighted model |
| `Ctrl+S` | Cycle sort mode |
| `?` | Toggle inline help / controls legend |

Notes:
- Keep `Ctrl+Alt+P` for quick-switch palette.
- Keep `Ctrl+Alt+N` for next favorite.
- If `Ctrl+1..3` conflicts in TUI practice, fallback to `Alt+1..3` for assignment while preserving `Ctrl+Alt+1..3` for activation.
- Assignment commands should work only inside picker overlays, not globally.

### 3. Preferred thinking levels — `TREK-57`

- [ ] Store an optional preferred thinking level per model
- [ ] Apply preferred thinking level when selecting from:
  - main picker
  - favorites picker
  - quick-switch palette
  - next-favorite cycle
  - quick-slot shortcuts
- [ ] Preserve current behavior when no preference exists
- [ ] Ensure non-reasoning models degrade safely

### 4. Alias/tag search — `TREK-58`

- [ ] Extend filtering to search aliases and tags in addition to provider/id/name
- [ ] Add a lightweight management path for aliases/tags
- [ ] Keep search responsive and per-category behavior intact
- [ ] Make alias/tag matches discoverable in UI where practical

### 5. Sort modes — `TREK-59`

- [ ] Add selectable sort modes for picker lists
- [ ] Initial sort modes should include at least:
  - favorites/manual
  - provider
  - name
  - context window / capability-oriented ordering
- [ ] Preserve useful prioritization for current model and favorites where appropriate
- [ ] Make the active sort mode visible in the UI

### 6. Docs and tests — `TREK-60`

- [ ] Update README usage tables and controls
- [ ] Document state migration and explicit quick-slot behavior
- [ ] Add tests for:
  - migration
  - stale entry handling
  - quick-slot assignment/resolution
  - preferred thinking level application
  - alias/tag filtering
  - sort mode ordering

## Suggested implementation order

1. **Schema design** (`TREK-54`)
2. **Migration + stale entry support** (`TREK-55`)
3. **Explicit quick slots** (`TREK-56`)
4. **Preferred thinking levels** (`TREK-57`)
5. **Alias/tag search** (`TREK-58`)
6. **Sort modes** (`TREK-59`)
7. **Docs/tests** (`TREK-60`)

## Verification

- Quick slots 1–3 select only explicitly assigned models
- Unassigned slot shortcut shows a clear warning
- Legacy favorites state upgrades without data loss
- Stale favorites/slots are visible and cleanable
- Preferred thinking levels apply on all picker-driven selections
- Search matches aliases and tags as expected
- Sort mode changes reorder visible lists predictably
- README matches implemented controls and commands

## Open implementation notes

- Prefer a small state helper layer inside `src/index.ts` or extracted nearby for:
  - schema normalization
  - migration
  - stale detection
  - slot assignment
  - thinking-level cycling
  - sort/filter helpers
- Consider row annotations like:
  - `★` for favorite
  - `[1]`, `[2]`, `[3]` for assigned slots
  - `~` or dim warning text for stale entries
  - short tag chips for aliases/tags only when space allows
- Preferred thinking level should be applied after `pi.setModel(model)` succeeds.
- If the chosen model does not support reasoning, coerce preferred thinking to `off` and notify only when useful.
- Alias/tag management can start as lightweight keyboard actions plus persisted metadata, without needing a full modal editor in v1.
