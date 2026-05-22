# pi-trekker

Pi package integrating Trekker persistent task memory with Pi.

## Features

- `.trekker/` project detection and footer status
- Plan-mode UI indicator in Pi when write/edit tools are disabled
- `/trekker` command namespace
- Session-start Trekker context injection using `--toon` where available
- Prompted checkpoint hooks on compact/shutdown/session switch/fork
- Plan-mode steering and write/edit protection
- CLI-backed agent tools for Trekker operations, including unified list/search/show/history/comment reads
- Structured rendering of Trekker `--toon` output for user-facing read commands
- Trekker subtasks as durable agent todo items with footer/widget progress, commands, and tools
- Bundled Trekker skill and prompt templates

Most features activate only when the current project has a `.trekker/` folder.

## Install locally

```bash
pi install ./pi-trekker
/reload
```

## Commands

```text
/trekker status
/trekker init
/trekker settings
/trekker search <query>
/trekker list [trekker-list-args]
/trekker ready
/trekker start <task-id>
/trekker subtasks [task-id]
/trekker subtasks add [task-id] <title>
/trekker subtasks start <subtask-id>
/trekker subtasks done <subtask-id>
/trekker subtasks sync [task-id]
/trekker subtasks plan [task-id] [goal]
/trekker checkpoint [task-id]
/trekker done [task-id]
/trekker history [limit]
/trekker show <id>
/trekker dashboard
/trekker plan [goal]
```

## Settings UI

Run:

```text
/trekker settings
```

The settings flow uses Pi's built-in `select`/`input` dialogs for stability. It supports editing settings by section and saving either:

- project settings: `.pi/settings.json`
- user settings: `~/.pi/agent/settings.json`

Session edits are also stored with `pi.appendEntry()` so they survive reload/resume in the current session branch.

The UI section includes `Rich feedback`, which controls notifications when Trekker context is injected, tools are enabled/disabled, checkpoints are written, settings are saved, dashboard state is checked, or tasks are started/completed. When plan mode is active, pi-trekker sets a persistent `PLAN MODE` footer status; enabling `Editor widget` also shows a banner near the editor.

Read commands such as `/trekker list`, `/trekker ready`, `/trekker history`, `/trekker search`, and `/trekker show` request Trekker `--toon` output, parse it, and render concise summaries in Pi. The corresponding read tools preserve raw and parsed TOON data in tool result details.

The `Subtasks` settings section controls durable agent todos backed by Trekker subtasks: context injection, footer progress, editor checklist widget, auto-load, write guardrails, parent-completion prompts, and widget size. The model also gets `trekker_subtask_*` tools for listing, creating, starting, updating, and completing subtasks.

## Design note

The extension intentionally talks to Trekker through the Trekker CLI via `pi.exec("trekker", args)`. It does not use Trekker's MCP server or read `.trekker/trekker.db` directly.
