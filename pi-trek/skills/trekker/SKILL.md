---
name: trekker
description: Trekker task management integration — work on tasks, create epics, track progress, and search across all entities from within Pi. Triggers on task, issue, bug, todo, epic keywords.
---

# Trekker Task Management

## Overview

Trekker is a local-first issue tracker for coding agents. This extension integrates Trekker workflows into Pi via LLM-callable tools, lifecycle hooks, and user commands.

## Available Tools

| Tool | Purpose |
|------|---------|
| `trekker_list_tasks` | List tasks filtered by status and/or epic |
| `trekker_get_task` | Full task details (description, status, priority, tags) |
| `trekker_create_task` | Create a task or subtask |
| `trekker_update_task` | Update status, priority, title, description |
| `trekker_comment` | Add a comment (author: claude) — use before context resets |
| `trekker_search` | Full-text search across epics, tasks, subtasks, comments |
| `trekker_ready` | List unblocked tasks ready to start |
| `trekker_list_epics` | List epics with optional status filter |
| `trekker_get_epic` | Epic details with its associated tasks |
| `trekker_create_epic` | Create a new epic |
| `trekker_update_epic` | Update epic status, priority, title, description |

## User Commands

| Command | Purpose |
|---------|---------|
| `/trek` | Show in_progress and ready tasks |
| `/trek-start <id>` | Set a task in_progress |
| `/trek-done <id>` | Mark a task completed |
| `/trek-plan [topic]` | Toggle plan mode on/off (exploration only, no file writes) |
| `/trek-execute <id>` | Start executing an epic or task (shows tree, starts first todo, injects context) |

## Workflow Rules

### Search-First Rule

**ALWAYS use `trekker_search` before creating** any task or epic. This prevents duplicates. If the search returns something close, update the existing item instead of creating a new one.

### One Task at a Time

Only one task should be `in_progress` at a time. Before setting a new task to `in_progress`, consider whether the current task should be:
- Completed (`status: completed`) if done
- Put back to `todo` if stalled

### Comment Before Context Reset

Before a context reset, session switch, or long pause, use `trekker_comment` to document:
- What was accomplished
- Any decisions made
- What remains to be done

This lets future sessions (or other agents) pick up seamlessly.

### Epic Lifecycle

1. Search first to check for existing epics
2. Create epic: `trekker_create_epic`
3. Add tasks to epic: `trekker_create_task` with `epic_id`
4. Complete individual tasks as they're done
5. Complete epic: `trekker_update_epic` with `status: completed`

### Priority Guide

| Priority | Label | When to Use |
|----------|-------|-------------|
| 0 | Critical | Blocking issue, immediate attention |
| 1 | High | Important, should be next |
| 2 | Medium | Default — normal task |
| 3 | Low | Nice to have |
| 4 | Very Low | If time permits |
| 5 | Someday | Backlog item, no urgency |

## Plan Mode (`/trek-plan`)

Use when starting work on a new feature or bug fix without a clear task breakdown.

**How it works:**

1. Run `/trek-plan [topic]` to enter plan mode
2. File writes are **blocked** — only exploration and Trekker calls are allowed
3. Explore the codebase to understand scope and requirements
4. Write a structured plan as text in the conversation
5. Ask the user: *"Should I interview you to refine this plan, or should I proceed to create Trekker tasks?"*
6. If interview: ask up to 3 clarifying questions, refine the plan, then ask again
7. If proceed: create `trekker_create_epic` → `trekker_create_task` (one per task) → `trekker_create_task` with `parent_id` (one per subtask)
8. Run `/trek-plan` again to exit plan mode

**Rules:**
- Always create: 1 epic → N tasks → subtasks per task
- Exploration (read, ls, grep, cat, find) is allowed
- Trekker CLI tools are allowed
- Edit/write tools are blocked; bash write commands are blocked

## Execute Mode (`/trek-execute <id>`)

Use when an epic or task already exists and you're ready to implement.

**How it works:**

1. Run `/trek-execute EPIC-X` or `/trek-execute TREK-X`
2. The extension loads the full task tree (epic → tasks → subtasks)
3. The first todo task is automatically set to `in_progress`
4. Execution guidance is injected into the LLM context

**Workflow:**
- Work tasks top-to-bottom
- Mark each task `in_progress` when you start
- Add a `trekker_comment` checkpoint when you finish
- Mark it `completed` with `trekker_update_task`
- Add subtasks if unexpected work is discovered mid-execution
- For epics: when all tasks are done, update epic status to `completed`

## Example Workflows

**Starting a new feature with plan mode:**
```
/trek-plan "OAuth Integration"
agent explores, writes plan, asks interview-or-proceed
"proceed"
agent: trekker_create_epic → "OAuth Integration"
       trekker_create_task → "Add Google OAuth" (epic: EPIC-X)
       trekker_create_task → "Add GitHub OAuth" (epic: EPIC-X)
       trekker_create_task → parent_id → "Google token refresh" (child of Google task)
/trek-plan
```

**Executing an epic:**
```
/trek-execute EPIC-X
shows task tree, starts first todo task
agent implements, comments, completes each task
...work...
agent marks epic completed when all tasks are done
```

**Picking up work after a reset:**
```
/trek  (see what's in_progress and ready)
trekker_get_task → TREK-1 (review full context)
trekker_comment → "Resuming work on..." (task: TREK-1)
```

**Bug triage:**
```
trekker_search → "crash on login"
trekker_create_task → "Fix login crash" (priority: 0)
trekker_update_task → TREK-X (status: in_progress)
```
