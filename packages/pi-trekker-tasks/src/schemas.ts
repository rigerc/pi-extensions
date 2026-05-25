import { Type } from 'typebox';

// ── Local helper (avoids @earendil-works/pi-ai peer dep) ──────────────────────

function StringEnum<T extends string>(values: readonly T[], opts?: object) {
  return Type.Unsafe<T>({ type: 'string', enum: values, ...opts });
}

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
    StringEnum(['pending', 'in_progress', 'completed', 'failed', 'deleted'] as const, {
      description: 'Filter by status. Omit to list all tasks.',
    }),
  ),
  epicId: Type.Optional(Type.String({ description: 'Filter by epic ID (e.g. EPIC-1).' })),
});

// ── TaskUpdate ─────────────────────────────────────────────────────────────────

export const TaskUpdateParams = Type.Object({
  id: Type.String({ description: 'The task ID to update (e.g. TREK-1).' }),
  status: Type.Optional(
    Type.Unsafe<'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted'>({
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'failed', 'deleted'],
      description:
        "New status. 'deleted' archives the task in trekker. 'failed' marks it wont_fix.",
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
    StringEnum(['pending', 'in_progress', 'completed', 'deleted'] as const, {
      description: 'Filter by status. Omit to list all epics.',
    }),
  ),
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
    Type.Unsafe<'pending' | 'in_progress' | 'completed' | 'deleted'>({
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'deleted'],
      description: "'deleted' archives the epic in trekker.",
    }),
  ),
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
