[Skip to content](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-todo/src#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-todo/src) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-todo/src) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-todo/src) to refresh your session.Dismiss alert

{{ message }}

[agnishcc](https://github.com/agnishcc)/ **[pi-extention-monorepo](https://github.com/agnishcc/pi-extention-monorepo)** Public

- [Notifications](https://github.com/login?return_to=%2Fagnishcc%2Fpi-extention-monorepo) You must be signed in to change notification settings
- [Fork\\
  0](https://github.com/login?return_to=%2Fagnishcc%2Fpi-extention-monorepo)
- [Star\\
  11](https://github.com/login?return_to=%2Fagnishcc%2Fpi-extention-monorepo)

## Collapse file tree

## Files

main

Search this repository(forward slash)` forward slash/`

/

# src

/

Copy path

## Directory actions

## More options

More options

## Directory actions

## More options

More options

## Latest commit

[![agnishcc](https://avatars.githubusercontent.com/u/30952790?v=4&size=40)](https://github.com/agnishcc)[agnishcc](https://github.com/agnishcc/pi-extention-monorepo/commits?author=agnishcc)

[✨ feat(agent-mode): add keyboard shortcut and session persistence](https://github.com/agnishcc/pi-extention-monorepo/commit/ab52adf9ceb9899ad45e158b1809445965a03fa1)

Open commit details

3 days agoMay 22, 2026

[ab52adf](https://github.com/agnishcc/pi-extention-monorepo/commit/ab52adf9ceb9899ad45e158b1809445965a03fa1) · 3 days agoMay 22, 2026

## History

[History](https://github.com/agnishcc/pi-extention-monorepo/commits/main/packages/edb-todo/src)

Open commit details

[View commit history for this file.](https://github.com/agnishcc/pi-extention-monorepo/commits/main/packages/edb-todo/src) History

/

# src

/

Top

## Folders and files

| Name                                                                                                                                            | Name                                                                                                                                            | Last commit message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Last commit date       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| ### parent directory<br> [..](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-todo)                                    |
| [auto-clear.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/auto-clear.ts 'auto-clear.ts')                | [auto-clear.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/auto-clear.ts 'auto-clear.ts')                | [🚀 deploy(edb-todo): overhaul — individual task tools, file-backed sto…](https://github.com/agnishcc/pi-extention-monorepo/commit/31a6049718478366d34dc47bf5fd6234feb00ae7 '🚀 deploy(edb-todo): overhaul — individual task tools, file-backed storage, dependencies, auto-clear, settings  Introduce 6 individual task tools (TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop) replacing the monolithic todo_write approach. Tasks now persist to disk with memory/session/project scopes, support bidirectional dependency edges (blocks/blockedBy) with cycle detection, auto-clear completed tasks on configurable triggers, and surface a settings panel. A persistent widget above the editor shows live status with animated spinners, elapsed time, and blocked-by hints.')   | last weekMay 15, 2026  |
| [component.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/component.ts 'component.ts')                   | [component.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/component.ts 'component.ts')                   | [🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration](https://github.com/agnishcc/pi-extention-monorepo/commit/29373aa23b711c8973f2630b39cdca34147016db '🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration  Add TaskCreate fields: parentId (subtasks), groupId (parallel groups), blockedByGroup. Add blocked task state with blockQuestion and blockMessageId for supervisor wait flows. Integrate edb-bridge: emit bridge:task_updated on mutations, read task_store_path from system prompt extras, subscribe to bridge:task_updated for sub-agent-driven updates. Add isGroupComplete() and getReadyTasks() for group-join resolution in orchestrators. Widget header now shows blocked count in warning colour. Tree rendering replaces flat list.') | 3 days agoMay 22, 2026 |
| [config.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/config.ts 'config.ts')                            | [config.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/config.ts 'config.ts')                            | [🚀 deploy(edb-todo): overhaul — individual task tools, file-backed sto…](https://github.com/agnishcc/pi-extention-monorepo/commit/31a6049718478366d34dc47bf5fd6234feb00ae7 '🚀 deploy(edb-todo): overhaul — individual task tools, file-backed storage, dependencies, auto-clear, settings  Introduce 6 individual task tools (TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop) replacing the monolithic todo_write approach. Tasks now persist to disk with memory/session/project scopes, support bidirectional dependency edges (blocks/blockedBy) with cycle detection, auto-clear completed tasks on configurable triggers, and surface a settings panel. A persistent widget above the editor shows live status with animated spinners, elapsed time, and blocked-by hints.')   | last weekMay 15, 2026  |
| [file-store.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/file-store.ts 'file-store.ts')                | [file-store.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/file-store.ts 'file-store.ts')                | [✨ feat(agent-mode): add keyboard shortcut and session persistence](https://github.com/agnishcc/pi-extention-monorepo/commit/ab52adf9ceb9899ad45e158b1809445965a03fa1 '✨ feat(agent-mode): add keyboard shortcut and session persistence  Replace status-bar based mode display with session entry persistence via pi.appendEntry(). Add Ctrl+Shift+A shortcut to cycle through defined modes (mode₁ → mode₂ → off → mode₁). Footer now reads the active mode from session entries instead of relying on setStatus.')                                                                                                                                                                                                                                                                                | 3 days agoMay 22, 2026 |
| [index.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/index.ts 'index.ts')                               | [index.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/index.ts 'index.ts')                               | [🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration](https://github.com/agnishcc/pi-extention-monorepo/commit/29373aa23b711c8973f2630b39cdca34147016db '🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration  Add TaskCreate fields: parentId (subtasks), groupId (parallel groups), blockedByGroup. Add blocked task state with blockQuestion and blockMessageId for supervisor wait flows. Integrate edb-bridge: emit bridge:task_updated on mutations, read task_store_path from system prompt extras, subscribe to bridge:task_updated for sub-agent-driven updates. Add isGroupComplete() and getReadyTasks() for group-join resolution in orchestrators. Widget header now shows blocked count in warning colour. Tree rendering replaces flat list.') | 3 days agoMay 22, 2026 |
| [process-tracker.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/process-tracker.ts 'process-tracker.ts') | [process-tracker.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/process-tracker.ts 'process-tracker.ts') | [🚀 deploy(edb-todo): overhaul — individual task tools, file-backed sto…](https://github.com/agnishcc/pi-extention-monorepo/commit/31a6049718478366d34dc47bf5fd6234feb00ae7 '🚀 deploy(edb-todo): overhaul — individual task tools, file-backed storage, dependencies, auto-clear, settings  Introduce 6 individual task tools (TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop) replacing the monolithic todo_write approach. Tasks now persist to disk with memory/session/project scopes, support bidirectional dependency edges (blocks/blockedBy) with cycle detection, auto-clear completed tasks on configurable triggers, and surface a settings panel. A persistent widget above the editor shows live status with animated spinners, elapsed time, and blocked-by hints.')   | last weekMay 15, 2026  |
| [prompt.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/prompt.ts 'prompt.ts')                            | [prompt.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/prompt.ts 'prompt.ts')                            | [🚀 deploy(edb-todo): overhaul — individual task tools, file-backed sto…](https://github.com/agnishcc/pi-extention-monorepo/commit/31a6049718478366d34dc47bf5fd6234feb00ae7 '🚀 deploy(edb-todo): overhaul — individual task tools, file-backed storage, dependencies, auto-clear, settings  Introduce 6 individual task tools (TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput, TaskStop) replacing the monolithic todo_write approach. Tasks now persist to disk with memory/session/project scopes, support bidirectional dependency edges (blocks/blockedBy) with cycle detection, auto-clear completed tasks on configurable triggers, and surface a settings panel. A persistent widget above the editor shows live status with animated spinners, elapsed time, and blocked-by hints.')   | last weekMay 15, 2026  |
| [schemas.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/schemas.ts 'schemas.ts')                         | [schemas.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/schemas.ts 'schemas.ts')                         | [🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration](https://github.com/agnishcc/pi-extention-monorepo/commit/29373aa23b711c8973f2630b39cdca34147016db '🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration  Add TaskCreate fields: parentId (subtasks), groupId (parallel groups), blockedByGroup. Add blocked task state with blockQuestion and blockMessageId for supervisor wait flows. Integrate edb-bridge: emit bridge:task_updated on mutations, read task_store_path from system prompt extras, subscribe to bridge:task_updated for sub-agent-driven updates. Add isGroupComplete() and getReadyTasks() for group-join resolution in orchestrators. Widget header now shows blocked count in warning colour. Tree rendering replaces flat list.') | 3 days agoMay 22, 2026 |
| [state.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/state.ts 'state.ts')                               | [state.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/state.ts 'state.ts')                               | [🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration](https://github.com/agnishcc/pi-extention-monorepo/commit/29373aa23b711c8973f2630b39cdca34147016db '🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration  Add TaskCreate fields: parentId (subtasks), groupId (parallel groups), blockedByGroup. Add blocked task state with blockQuestion and blockMessageId for supervisor wait flows. Integrate edb-bridge: emit bridge:task_updated on mutations, read task_store_path from system prompt extras, subscribe to bridge:task_updated for sub-agent-driven updates. Add isGroupComplete() and getReadyTasks() for group-join resolution in orchestrators. Widget header now shows blocked count in warning colour. Tree rendering replaces flat list.') | 3 days agoMay 22, 2026 |
| [types.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/types.ts 'types.ts')                               | [types.ts](https://github.com/agnishcc/pi-extention-monorepo/blob/main/packages/edb-todo/src/types.ts 'types.ts')                               | [🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration](https://github.com/agnishcc/pi-extention-monorepo/commit/29373aa23b711c8973f2630b39cdca34147016db '🚀 deploy(todo): add subtask, parallel group, and edb-bridge integration  Add TaskCreate fields: parentId (subtasks), groupId (parallel groups), blockedByGroup. Add blocked task state with blockQuestion and blockMessageId for supervisor wait flows. Integrate edb-bridge: emit bridge:task_updated on mutations, read task_store_path from system prompt extras, subscribe to bridge:task_updated for sub-agent-driven updates. Add isGroupComplete() and getReadyTasks() for group-join resolution in orchestrators. Widget header now shows blocked count in warning colour. Tree rendering replaces flat list.') | 3 days agoMay 22, 2026 |
| View all files                                                                                                                                  |

You can’t perform that action at this time.
