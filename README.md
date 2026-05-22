# pi-skillshare

> Search, install, and manage [skillshare](https://github.com/runkids/skillshare) AI agent skills — all from inside Pi.

## Requirements

- [Pi](https://earendil-works.github.io/pi/) (the coding agent harness this extension runs in)
- [skillshare CLI](https://github.com/runkids/skillshare) — `skillshare --version` must be on `PATH`

## Install

```bash
pi install npm:pi-skillshare
```

To develop locally, clone this repo, then:

```bash
pi install ./pi-skillshare
/reload
```

## Commands

| Command                         | Description                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `/skillshare [query]`           | Tabbed TUI: search, installed skills, and status                                       |
| `/skillshare-settings`          | Configure defaults (hub mode, install target, check scope, search limit, update check) |
| `/skillshare-sync [-p \| -g]`   | Sync installed skills to configured targets                                            |
| `/skillshare-update [-p \| -g]` | Check for updates, confirm, then apply them                                            |
| `/skillshare-ui`                | Launch the skillshare web UI in a browser                                              |

### Scope flags (`-p` / `-g`)

`/skillshare-update` and `/skillshare-sync` accept `-p` (project) or `-g` (global) to override which scope they target. When omitted they fall back to the **Check/update scope** setting.

## `/skillshare` — Tabbed TUI

| Tab           | Content                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Search**    | Enter a query → multi-select results → install. Enter confirms, Space toggles.                                                       |
| **Installed** | Lists installed skills from `.skillshare/skills/` or `~/.config/skillshare/skills/`. `u` uninstalls, `U` updates all, `r` refreshes. |
| **Status**    | Shows skill count, install mode, search source. `s` sync, `u` update, `d` doctor.                                                    |

### Key bindings

| Key                              | Action                                             |
| -------------------------------- | -------------------------------------------------- |
| `↑` / `↓` or `k` / `j`           | Navigate lists                                     |
| `←` / `→` or `Tab` / `Shift+Tab` | Switch tabs                                        |
| `Space`                          | Toggle checkbox (search) / change value (settings) |
| `Enter`                          | Confirm selection / install                        |
| `Esc` or `Ctrl+C`                | Close panel                                        |

## `/skillshare-update` flow

1. **Check** — runs `skillshare check --json` to find outdated skills and repos
2. **Summary** — shows what needs updating (skills, tracked repos, stale skills)
3. **Confirm** — asks "Apply all updates now?" before touching anything
4. **Update** — runs `skillshare update` only if confirmed

## `/skillshare-settings`

| Setting                    | Values                        | Default       | Effect                                                                                             |
| -------------------------- | ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Search source              | GitHub search / Community hub | GitHub search | Switches between `--hub` and direct GitHub search                                                  |
| Install target             | Global / Project              | Project       | Where `skillshare install` puts new skills                                                         |
| Check/update scope         | Global / Project              | Project       | Scope for `check`, `update`, and `sync`                                                            |
| Search result limit        | 10 / 20 / 30 / 50             | 20            | Max results per search query                                                                       |
| Check for updates on start | Enabled / Disabled            | Enabled       | Runs `skillshare doctor --json` on startup and prints a notice if a newer CLI version is available |

All settings persist across sessions via `pi.appendEntry`.

> **Startup update check** — the check runs at most once per 60 seconds across all sessions (including subagents), so it won't fire on every spawned agent during a single session.

## File structure

```
pi-skillshare/
├── package.json          # Pi package manifest
├── README.md             # This file
├── .gitignore
└── src/
    ├── index.ts          # Entry point — registers commands
    ├── panels.ts         # TUI components — TabBar, SearchPanel, InstalledPanel, StatusPanel, SettingsPanel
    └── utils.ts          # Shared helpers — CLI wrappers, error parsing, spinner, formatting
```

## Development

```bash
# Edit files in pi-skillshare/src/
pi install ./pi-skillshare
/reload
```

The extension uses the [Pi TUI](https://earendil-works.github.io/pi/docs/tui) for its interactive components.

## License

MIT
