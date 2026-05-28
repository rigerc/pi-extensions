# Changelog

## 0.2.0 — 2026-05-28

### New features

- **Explicit quick slots 1–3** — assign models to slots with `Ctrl+1`/`2`/`3` inside the picker; activate globally with `Ctrl+Alt+1`/`2`/`3`. Slot badges `[n]` shown in rows.
- **Per-model preferred thinking level** — cycle with `Ctrl+T`; applied automatically on model selection. Shown as `✦m`/`✦h` etc. in rows.
- **Alias and tag search** — search field now matches model aliases and tags stored in `modelPrefs`, in addition to provider/id/name.
- **Sort modes** — cycle with `Ctrl+S` between `favorites`, `provider`, `name`, and `context` (context window size). Active mode shown in status bar.
- **Stale entry surfacing** — favorites and quick-slot assignments whose models are no longer in the registry are displayed with `~` and dimmed; excluded from selection but retained until user cleans them up.
- **Inline help** — press `?` inside any picker to toggle the controls legend.
- **State v2** — new schema with `quickSlots`, `modelPrefs`, `sortMode`, and `version`. Legacy v1 favorites-only files migrate automatically.

### Changed

- `Ctrl+Alt+1..3` now activate **explicit slots** (not favorite order). Slots 4–9 removed.
- `setSelectedModel` applies the model's preferred thinking level after a successful switch.
- Palette mode shows quick-slot models first, then remaining favorites.

## 0.1.0 — 2026-05-27

Forked into `@rigerc/pi-model-picker` package.

- Favorite/unfavorite models with `Ctrl+F`
- Favorites-only picker via `/model-favorites` or `Ctrl+Alt+F`
- Quick-cycle favorites via `/model-next-favorite` or `Ctrl+Alt+N`
- Compact quick-switch palette via `/model-quick-switch` or `Ctrl+Alt+P`
- Numbered quick slots via `Ctrl+Alt+1..9`

- Categorized model picker grouped by provider
- Tab / ← → to switch categories
- Per-category search field with preserved queries
- ↑ / ↓ navigation with wraparound
- Active model highlighted with ● marker
- Model metadata: context window size, `thinking` and `vision` tags
- `/models` command and `Ctrl+Alt+M` shortcut
