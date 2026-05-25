# pi-trek-commit

Trekker worktree discipline for Pi — keeps your git history aligned with
Trekker task boundaries.

- Detects `trekker ... -s completed` / `trekker epic complete` and prompts
  the agent to commit using [Conventional Commits](https://www.conventionalcommits.org/).
- **Blocks** `trekker ... -s in_progress` when the git worktree has
  uncommitted changes — enforcing clean worktrees per task.
- Warns if no summary comment was added before marking a task completed.
- Auto-disables when trekker CLI or `.trekker/` is missing.
- Injects a `trekker quickstart` reference into the system prompt (first turn only).

**Pi-only.** Install via local path.

## How it works

### System prompt integration

On the first agent turn, a brief Trekker availability notice is
appended to the system prompt. This avoids triggering automatic
execution of `trekker quickstart` while keeping the agent informed.

### Completed → commit prompt

```bash
trekker task update TREK-1 -s completed
# → ⏏ Trekker task `TREK-1` marked completed.
#   Remember to commit using Conventional Commits...
```

Also detects `trekker epic complete EPIC-1` and
`trekker subtask update TREK-1-SUB-1 -s completed`.

### In-progress → blocked if dirty

```bash
trekker task update TREK-1 -s in_progress
# → BLOCKED: Cannot start `TREK-1` — the working tree has
#   uncommitted changes. Commit or stash first.
```

### Missing comment → warning

If no `trekker comment add <id>` was called in the same turn before
`-s completed`, the commit prompt includes a warning reminding the
agent to add a summary comment first.

## Install

```bash
pi install ./pi-trek-commit
```

## Requirements

- Pi coding agent (`@earendil-works/pi-coding-agent`)
- [Trekker CLI](https://github.com/...) available on PATH
- `.trekker/trekker.db` in the project root

## Scope

| Feature | Status |
|---------|--------|
| Detect `-s completed` (task, subtask, epic) | ✅ |
| Detect `epic complete` | ✅ |
| Block `-s in_progress` on dirty worktree | ✅ |
| Warn on missing summary comment | ✅ |
| Disable when trekker unavailable | ✅ |
| System-prompt quickstart reference | ✅ |
| Detect `-s in_progress` (commit prompt) | ❌ (out of scope) |
| Auto-commit | ❌ (agent decides) |
| Conventional Commits | ✅ |

## License

MIT
