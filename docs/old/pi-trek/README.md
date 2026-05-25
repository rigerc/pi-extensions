# pi-trek 🎯

> Trekker task management hooks, context, and tools for Pi agents.

**pi-trek** is a Pi extension that integrates [Trekker](https://github.com/runkids/trekker) — a local-first issue tracker for coding agents — directly into your Pi agent's workflow. It provides LLM-callable tools, lifecycle hooks for task awareness, context injection, and guardrails that keep your agent naturally aligned with Trekker workflows.

## Requirements

- [Pi](https://earendil-works.github.io/pi/) (the coding agent harness)
- [Trekker CLI](https://github.com/runkids/trekker) — `trekker --version` on `PATH`
- A project initialized with `trekker init` (creates `.trekker/` directory)

## Install

```bash
# From the pi-extensions repo root
pi install ./pi-trek
/reload
```

## What It Does

| Capability | Description |
|-----------|-------------|
| **LLM Tools** | 11 tools the agent can call to list, create, update, search tasks/epics, add comments |
| **Session Awareness** | On session start, notifies about in_progress tasks |
| **Context Injection** | Injects active task summary into LLM context on each turn |
| **Guardrails** | Soft nudges when the agent works without an active task |
| **User Commands** | `/trek`, `/trek-start`, `/trek-done` for quick task management |
| **Bundled Skill** | `skills/trekker/SKILL.md` — agent workflow guidance |
| **Context Recovery** | `prompts/session-start.md` — template for `/prompt:session-start` |

## LLM Tools

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `trekker_list_tasks` | `status?`, `epic_id?` | List tasks with optional filters |
| `trekker_get_task` | `id` | Full task details |
| `trekker_create_task` | `title`, `description?`, `priority?`, `epic_id?`, `parent_id?` | Create task or subtask |
| `trekker_update_task` | `id`, `status?`, `priority?`, `title?`, `description?` | Update a task |
| `trekker_comment` | `task_id`, `content` | Add comment (author: claude) |
| `trekker_search` | `query`, `type?` | Full-text search across all entities |
| `trekker_ready` | _(none)_ | List unblocked tasks ready to start |
| `trekker_list_epics` | `status?` | List epics |
| `trekker_get_epic` | `id` | Epic details with its tasks |
| `trekker_create_epic` | `title`, `description?`, `priority?` | Create a new epic |
| `trekker_update_epic` | `id`, `status?`, `priority?`, `title?`, `description?` | Update an epic |

## User Commands

| Command | Purpose |
|---------|---------|
| `/trek` | Show current in_progress and ready tasks |
| `/trek-start <id>` | Set a task in_progress (e.g., `/trek-start TREK-1`) |
| `/trek-done <id>` | Mark a task completed |

## Agent Workflow

- **Search-first**: Always search before creating tasks/epics to avoid duplicates
- **One task at a time**: Only one task should be in_progress at a time
- **Comment before reset**: Before context resets or session switches, comment on progress
- **Epic lifecycle**: Create epic → add tasks → complete tasks → complete epic

See `skills/trekker/SKILL.md` for the full workflow guidance loaded as a skill.

## Architecture

```
pi-trek/
├── package.json              # Pi package manifest
├── README.md                 # This file
├── src/
│   ├── index.ts              # Entry point — registers tools, hooks, commands
│   ├── cli.ts                # Trekker CLI wrapper (subprocess + --toon parsing)
│   ├── tools.ts              # LLM tool definitions + handlers
│   └── hooks.ts              # Lifecycle hook handlers
├── skills/
│   └── trekker/
│       └── SKILL.md          # Bundled skill — agent workflow guidance
└── prompts/
    └── session-start.md      # Context recovery template
```

All data access goes through `trekker --toon` CLI. The SQLite database is never touched directly.

## Lifecycle Hooks

### `session_start`
- Checks Trekker availability (CLI + `.trekker/` dir)
- Notifies about any in_progress tasks

### `context`
- Injects active in_progress task summary into LLM messages

### `tool_call` — Guardrails
- Before destructive file ops (bash/edit/write), if no task is in_progress, suggests the agent pick a task first
- Soft nudges only — never blocks

## Development

```bash
# Clone the repo, then:
pi install ./pi-trek
/reload
```

## License

MIT
