import { Type } from 'typebox';

// ── Local helper (avoids @earendil-works/pi-ai peer dep) ──────────────────────

function StringEnum<T extends string>(values: readonly T[], opts?: object) {
  return Type.Unsafe<T>({ type: 'string', enum: values, ...opts });
}

const TaskStatusValues = ['todo', 'in_progress', 'completed', 'wont_fix', 'archived'] as const;
const EpicStatusValues = ['todo', 'in_progress', 'completed', 'archived'] as const;

// ── TaskCreate ─────────────────────────────────────────────────────────────────

export const TaskCreateParams = Type.Object({
  content: Type.String({
    description:
      "Brief, actionable task title in imperative form (e.g. 'Fix auth bug in login flow').",
  }),
  description: Type.Optional(
    Type.String({ description: 'Detailed description including context and acceptance criteria.' }),
  ),
  priority: Type.Optional(
    StringEnum(['urgent', 'high', 'medium', 'low', 'lowest'] as const, {
      description: "Task priority. Defaults to 'medium'.",
    }),
  ),
  tags: Type.Optional(
    Type.String({
      description: "Comma-separated tags for categorization (e.g. 'frontend,bug,urgent').",
    }),
  ),
  parentId: Type.Optional(
    Type.String({ description: 'Parent task ID (e.g. TREK-1). Creates this as a subtask.' }),
  ),
  epicId: Type.Optional(Type.String({ description: 'Epic ID to associate with (e.g. EPIC-1).' })),
});

// ── TaskGet ────────────────────────────────────────────────────────────────────

export const TaskGetParams = Type.Object({
  id: Type.String({ description: 'The task ID to retrieve (e.g. TREK-1).' }),
});

// ── TaskList ───────────────────────────────────────────────────────────────────

export const TaskListParams = Type.Object({
  status: Type.Optional(
    StringEnum(TaskStatusValues, {
      description: 'Filter by status. Omit to list all tasks.',
    }),
  ),
  epicId: Type.Optional(Type.String({ description: 'Filter by epic ID (e.g. EPIC-1).' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum results to return.' })),
  page: Type.Optional(Type.Number({ description: 'Result page number.' })),
});

// ── TaskUpdate ─────────────────────────────────────────────────────────────────

export const TaskUpdateParams = Type.Object({
  id: Type.String({ description: 'The task ID to update (e.g. TREK-1).' }),
  status: Type.Optional(
    Type.Unsafe<'todo' | 'in_progress' | 'completed' | 'wont_fix' | 'archived'>({
      type: 'string',
      enum: TaskStatusValues,
      description: "New Trekker-native status. 'archived' removes the task from active views.",
    }),
  ),
  content: Type.Optional(Type.String({ description: 'New task title.' })),
  description: Type.Optional(Type.String({ description: 'New task description.' })),
  priority: Type.Optional(
    StringEnum(['urgent', 'high', 'medium', 'low', 'lowest'] as const, {
      description: 'New priority.',
    }),
  ),
  tags: Type.Optional(
    Type.String({ description: 'New tags (comma-separated). Replaces existing tags.' }),
  ),
  epicId: Type.Optional(Type.String({ description: 'New epic ID to assign (e.g. EPIC-1).' })),
  removeEpic: Type.Optional(
    Type.Boolean({ description: 'Remove the task from its current epic.' }),
  ),
});

// ── TaskDelete ─────────────────────────────────────────────────────────────────

export const TaskDeleteParams = Type.Object({
  id: Type.String({
    description: 'The task ID to delete (e.g. TREK-1). Archives the task in trekker.',
  }),
});

// ── TaskListSubtasks ───────────────────────────────────────────────────────────

export const TaskListSubtasksParams = Type.Object({
  parentTaskId: Type.String({
    description: 'The parent task ID to list subtasks for (e.g. TREK-1).',
  }),
});

// ── TaskCommentList ────────────────────────────────────────────────────────────

export const TaskCommentListParams = Type.Object({
  id: Type.String({ description: 'The task ID to list comments for (e.g. TREK-1).' }),
});

// ── TaskComment ────────────────────────────────────────────────────────────────

export const TaskCommentParams = Type.Object({
  id: Type.String({ description: 'Task ID to comment on (e.g. TREK-1).' }),
  content: Type.String({
    description: 'Comment text. Use for progress notes, decisions, or summaries.',
  }),
});

// ── TaskSearch ─────────────────────────────────────────────────────────────────

export const TaskSearchParams = Type.Object({
  query: Type.String({
    description: 'Full-text search query across task titles, descriptions, and comments.',
  }),
  type: Type.Optional(
    StringEnum(['epic', 'task', 'subtask', 'comment'] as const, {
      description: 'Optional entity type filter.',
    }),
  ),
});

// ── TaskReady ─────────────────────────────────────────────────────────────────

export const TaskReadyParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Maximum ready tasks to return.' })),
});

// ── TaskHistory ────────────────────────────────────────────────────────────────

export const TaskHistoryParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Maximum history events to return.' })),
  entity: Type.Optional(Type.String({ description: 'Entity ID to inspect (e.g. TREK-1).' })),
  type: Type.Optional(Type.String({ description: 'Entity type filter (task, epic, comment).' })),
  action: Type.Optional(Type.String({ description: 'Action filter (create, update, delete).' })),
  since: Type.Optional(Type.String({ description: 'Timestamp/date filter supported by trekker.' })),
});

// ── TaskComplete ───────────────────────────────────────────────────────────────

export const TaskCompleteParams = Type.Object({
  id: Type.String({ description: 'Task ID to complete (e.g. TREK-1).' }),
  summary: Type.String({
    description: 'Completion summary. Include files changed and important behavior changes.',
  }),
});

// ── EpicCreate ─────────────────────────────────────────────────────────────────

export const EpicCreateParams = Type.Object({
  title: Type.String({
    description: "Brief, descriptive epic title (e.g. 'Auth system overhaul').",
  }),
  description: Type.Optional(Type.String({ description: 'What this epic covers and its goal.' })),
  priority: Type.Optional(
    StringEnum(['urgent', 'high', 'medium', 'low', 'lowest'] as const, {
      description: "Epic priority. Defaults to 'medium'.",
    }),
  ),
});

// ── EpicList ───────────────────────────────────────────────────────────────────

export const EpicListParams = Type.Object({
  status: Type.Optional(
    StringEnum(EpicStatusValues, {
      description: 'Filter by status. Omit to list all epics.',
    }),
  ),
  limit: Type.Optional(Type.Number({ description: 'Maximum results to return.' })),
  page: Type.Optional(Type.Number({ description: 'Result page number.' })),
});

// ── EpicGet ───────────────────────────────────────────────────────────────────

export const EpicGetParams = Type.Object({
  id: Type.String({ description: 'The epic ID to retrieve (e.g. EPIC-1).' }),
});

// ── EpicUpdate ─────────────────────────────────────────────────────────────────

export const EpicUpdateParams = Type.Object({
  id: Type.String({ description: 'The epic ID to update (e.g. EPIC-1).' }),
  title: Type.Optional(Type.String({ description: 'New epic title.' })),
  description: Type.Optional(Type.String({ description: 'New epic description.' })),
  priority: Type.Optional(
    StringEnum(['urgent', 'high', 'medium', 'low', 'lowest'] as const, {
      description: 'New priority.',
    }),
  ),
  status: Type.Optional(
    Type.Unsafe<'todo' | 'in_progress' | 'completed' | 'archived'>({
      type: 'string',
      enum: EpicStatusValues,
      description: "'archived' removes the epic from active views.",
    }),
  ),
});

// ── EpicDelete ────────────────────────────────────────────────────────────────

export const EpicDeleteParams = Type.Object({
  id: Type.String({ description: 'The epic ID to archive/delete (e.g. EPIC-1).' }),
});

// ── DepAdd ─────────────────────────────────────────────────────────────────────

export const DepAddParams = Type.Object({
  taskId: Type.String({
    description: "The task that depends on another (e.g. TREK-2 — 'this task needs X done first').",
  }),
  dependsOnId: Type.String({
    description: 'The task that must complete first (e.g. TREK-1).',
  }),
});

// ── DepRemove ──────────────────────────────────────────────────────────────────

export const DepRemoveParams = Type.Object({
  taskId: Type.String({ description: 'The dependent task ID.' }),
  dependsOnId: Type.String({ description: 'The prerequisite task ID to remove.' }),
});

// ── DepList ───────────────────────────────────────────────────────────────────

export const DepListParams = Type.Object({
  taskId: Type.String({ description: 'Task ID whose dependencies should be listed.' }),
});

// ── CommentUpdate/Delete ──────────────────────────────────────────────────────

export const CommentUpdateParams = Type.Object({
  commentId: Type.String({ description: 'Comment ID to update.' }),
  content: Type.String({ description: 'Replacement comment text.' }),
});

export const CommentDeleteParams = Type.Object({
  commentId: Type.String({ description: 'Comment ID to delete.' }),
});

// ── SubtaskUpdate/Delete ──────────────────────────────────────────────────────

export const SubtaskUpdateParams = Type.Omit(TaskUpdateParams, ['epicId', 'removeEpic']);

export const SubtaskDeleteParams = Type.Object({
  id: Type.String({ description: 'The subtask ID to archive/delete.' }),
});

// ── System Tools ──────────────────────────────────────────────────────────────

export const TrekkerInitParams = Type.Object({
  confirm: Type.Boolean({ description: 'Must be true to initialize trekker in this project.' }),
});

export const TrekkerQuickstartParams = Type.Object({});
