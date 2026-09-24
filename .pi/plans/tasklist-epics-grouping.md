# Show epics in TaskList UI, properly grouped

## Context

`TaskList` currently only renders tasks. Epics exist in the store (`store.listEpics()`) and tasks reference them via `epicId`, but epics are never displayed in the tool result UI. The user wants epics to appear as group headers with their tasks nested underneath.

**Current rendering** (`TaskList` + `renderTaskListResult`):

- Flat list of tasks, sorted by status
- `epicId` shown as a dim tag `[EPIC-N]` on each task line
- No epic headers, no grouping

**Desired rendering**:

- Epics shown as section headers (with their own status icon)
- Tasks grouped under their epic
- Tasks without an epic shown under a default section
- Subtasks still indented under their parent within each epic group

## Files to modify

| File                                | Change                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `pi-trekker-tasks/src/state.ts`     | Update `renderTaskListResult` to accept `Epic[]` and render grouped output |
| `pi-trekker-tasks/src/component.ts` | Update `TrekkerTasksViewComponent.renderTaskResult` to pass epics through  |
| `pi-trekker-tasks/src/index.ts`     | Update `TaskList` execute to load epics, include in details                |

## Reuse

- `Epic` interface and `mapEpicStatus`/`unmapEpicStatus` already defined in `types.ts`
- `store.listEpics()` already implemented in `trekker-store.ts`
- `STATUS_ICON` in `types.ts` for status rendering
- `priorityColor`/`priorityLabel` in `state.ts` for priority badges
- Existing epic rendering in `EpicList.renderResult` (status icons, formatting)

## Steps

- [ ] **1. Update `renderTaskListResult` in `state.ts`** to accept an optional `epics: Epic[]` parameter
  - If epics provided, group tasks by `epicId`
  - Render each epic as a header line with its status icon, title, and task count
  - Render tasks under their epic header (subtasks still indented)
  - Tasks with no `epicId` go under a "No epic" or "Unassigned" section
  - Maintain backward compatibility: if no epics passed, fall back to current flat rendering

- [ ] **2. Update `TrekkerTasksViewComponent.renderTaskResult` in `component.ts`**
  - Add optional `epics` parameter, forward to `renderTaskListResult`

- [ ] **3. Update `TaskList` tool in `index.ts`**
  - After `store.refresh()`, also call `store.listEpics()`
  - Include epics in `details: { tasks: sorted, epics }`
  - Update `renderResult` to pass epics through

- [ ] **4. Verify TypeScript compiles and lint is clean**

## Verification

- Run `TaskList` with epics present → should see epic headers with grouped tasks
- Run `TaskList` with no epics → should look identical to current behavior (backward compat)
- Run `TaskList` with mixed tasks (some with epicId, some without) → unassigned tasks grouped separately
- Subtasks should still show indented under their parent within the epic group
- `TaskCreate`, `TaskUpdate` renderResult still works (they don't pass epics, so fallback applies)
