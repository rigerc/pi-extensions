# @rigerc/pi-model-picker

A categorized, keyboard-driven model selector extension for the Pi coding agent.

Highlights:
- Provider-grouped browsing with `Tab`/`←`/`→` category switching and per-category search
- Favorites list (`★`), explicit quick slots 1–3 (`[n]`), and per-model preferred thinking levels (`✦`)
- Alias/tag metadata stored per model, searchable in the picker
- Selectable sort modes: `favorites`, `provider`, `name`, `context`
- Stale saved entries (`~`) are surfaced in favorites/palette views and kept until explicitly cleaned
- `Ctrl+Alt+P` quick-switch palette and `Ctrl+Alt+N` cycle for keyboard-first model switching

## Preview

```text
╔═════════════════════════════════════════════════════════════════╗
║  Select Model                                                   ║
╠═════════════════════════════════════════════════════════════════╣
║◀  Anthropic │ Google │ Cliproxyapi │ Ollama ▶                   ║
║─────────────────────────────────────────────────────────────────║
║  Search: claude_                                                ║
║─────────────────────────────────────────────────────────────────║
║▶ Claude Sonnet 4.6 ● ★ [1] ✦m             200k  thinking       ║
║  Claude Opus 4.5                           200k  thinking       ║
║  Claude Haiku 3.5                          200k  vision         ║
║─────────────────────────────────────────────────────────────────║
║  ↑↓ navigate · Tab/← → category · Ctrl+F fav · sort:favorites  ║
╚═════════════════════════════════════════════════════════════════╝
```

Row annotations:
- `●` — currently active model
- `★` — favorited
- `[1]`/`[2]`/`[3]` — assigned quick slot
- `✦m` — preferred thinking level set (`m`=medium, `h`=high, etc.)
- `~` — stale entry (saved key no longer available from the registry)

## Install

```bash
pi install ./packages/pi-model-picker
```

Restart Pi after installation.

## Usage

| Trigger | Description |
|---------|-------------|
| `/models` | Open the categorized picker |
| `/model-next-favorite` | Switch to the next favorite model |
| `/model-quick-switch` | Open compact quick-switch palette |
| `Ctrl+Alt+M` | Open the categorized picker |
| `Ctrl+Alt+F` | Open quick-switch palette |
| `Ctrl+Alt+P` | Open quick-switch palette |
| `Ctrl+Alt+N` | Switch to the next favorite model |
| `Ctrl+Alt+1` | Activate quick slot 1 |
| `Ctrl+Alt+2` | Activate quick slot 2 |
| `Ctrl+Alt+3` | Activate quick slot 3 |

> `/model` is a built-in Pi command and cannot be overridden. Use `/models` for this picker.

## Controls (inside picker)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate models with wraparound |
| `Tab` / `Shift+Tab` | Switch provider category |
| `←` / `→` | Switch category when search is empty |
| Type | Filter models by name, id, provider, alias, or tag |
| `Ctrl+F` | Toggle favorite (`★`) for highlighted model |
| `Ctrl+U` / `Ctrl+D` | Reorder highlighted favorite up or down |
| `Ctrl+1` | Assign/unassign highlighted model to quick slot 1 |
| `Ctrl+2` | Assign/unassign highlighted model to quick slot 2 |
| `Ctrl+3` | Assign/unassign highlighted model to quick slot 3 |
| `Ctrl+T` | Cycle preferred thinking level (`✦`) for highlighted model |
| `Ctrl+S` | Cycle sort mode (`favorites` → `provider` → `name` → `context`) |
| `?` | Toggle inline controls legend |
| `Enter` | Select highlighted model |
| `Esc` | Cancel |

## Features

### Explicit quick slots

Quick slots 1–3 are explicitly assigned, not derived from favorite order. Assign a model to a slot with `Ctrl+1`/`2`/`3` inside any picker, then activate it with `Ctrl+Alt+1`/`2`/`3` globally.

Activating an empty slot shows a notification with instructions. Activating a stale slot (model no longer available) also notifies without switching.

### Per-model preferred thinking level

Each model can carry a preferred thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Cycle it with `Ctrl+T` inside the picker. When you select a model with a thinking preference set, the level is applied automatically after the model switch.

The current preference is shown as `✦m` / `✦h` etc. in the row.

### Alias and tag search

Add aliases or tags to any model via `Ctrl+T`... (future management UI) or directly in the state file. Search in the picker will match against aliases and tags in addition to provider, id, and name.

### Sort modes

Press `Ctrl+S` inside the picker to cycle through sort modes. The active mode is shown in the status bar:

| Mode | Order |
|------|-------|
| `favorites` | Favorites first (by favorite order), then alphabetical |
| `provider` | Alphabetical by name within each provider tab |
| `name` | Pure alphabetical across all models in the category |
| `context` | By context window size (largest first) |

The active model is always pinned at the top regardless of sort mode.

### Stale entries

Saved favorites and quick-slot assignments whose model key is no longer available in the registry are shown with `~` and dimmed styling. They are excluded from selection but remain in state so they can be cleaned up intentionally. Remove them by unfavoriting (`Ctrl+F`) or unassigning the slot (`Ctrl+1`/`2`/`3`) while the stale entry is highlighted.

### State file

State is stored at `~/.pi/agent/pi-model-picker/favorites.json` (or `$PI_CODING_AGENT_DIR/pi-model-picker/favorites.json`).

Legacy v1 files (favorites-only) are migrated to v2 automatically on first load.

```json
{
  "version": 2,
  "favorites": ["anthropic/claude-sonnet-4-6"],
  "quickSlots": { "1": "anthropic/claude-sonnet-4-6", "2": null, "3": null },
  "modelPrefs": {
    "anthropic/claude-sonnet-4-6": { "thinkingLevel": "medium" }
  },
  "sortMode": "favorites"
}
```

## License

MIT
