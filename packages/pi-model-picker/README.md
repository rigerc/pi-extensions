# @rigerc/pi-model-picker

A categorized, keyboard-driven model selector extension for the Pi coding agent.

This is a fork of `pi-model-picker` packaged for this monorepo. It adds provider-grouped browsing, favorites, a quick-switch palette, cycling, and numbered quick slots.

Highlights:
- `Ctrl+F` toggles favorite on the selected model
- `/model-quick-switch` or `Ctrl+Alt+P` opens a compact favorites palette
- `Ctrl+Alt+1..9` jump to the first nine quick slots in favorite order

## Preview

```text
╔═════════════════════════════════════════════════════════════════╗
║  Select Model                                                   ║
╠═════════════════════════════════════════════════════════════════╣
║◀  Anthropic │ Google │ Cliproxyapi │ Ollama ▶                   ║
║─────────────────────────────────────────────────────────────────║
║  Search: claude_                                                ║
║─────────────────────────────────────────────────────────────────║
║▶ Claude Sonnet 4.6 ●                         200k  thinking     ║
║  Claude Opus 4.5                             200k  thinking     ║
║  Claude Haiku 3.5                            200k  vision       ║
║─────────────────────────────────────────────────────────────────║
║  ↑↓ navigate  ·  Tab/← → category  ·  enter select  ·  esc     ║
╚═════════════════════════════════════════════════════════════════╝
```

## Install

Local path install while developing this repository:

```bash
pi install ./packages/pi-model-picker
```

Restart Pi after installation.

## Usage

| Trigger | Description |
|---------|-------------|
| `/models` | Open the categorized picker |
| `/model-favorites` | Open the favorites-only picker |
| `/model-next-favorite` | Switch to the next favorite model |
| `/model-quick-switch` | Open compact quick-switch palette |
| `Ctrl+Alt+M` | Open the categorized picker |
| `Ctrl+Alt+F` | Open the favorites-only picker |
| `Ctrl+Alt+P` | Open compact quick-switch palette |
| `Ctrl+Alt+N` | Switch to the next favorite model |
| `Ctrl+Alt+1..9` | Jump to quick slots 1 through 9 |

> `/model` is a built-in Pi command and cannot be overridden. Use `/models` for this picker.

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate models with wraparound |
| `Tab` / `Shift+Tab` | Switch provider category |
| `←` / `→` | Switch category when the search field is empty |
| Type | Filter models in the current category |
| `Ctrl+F` | Toggle favorite for highlighted model |
| `Enter` | Select highlighted model |
| `Esc` | Cancel |

## License

MIT
