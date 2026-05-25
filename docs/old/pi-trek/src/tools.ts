/**
 * pi-trek LLM Tool Definitions
 *
 * Each tool wraps a trekker CLI operation via the typed helpers in cli.ts.
 * Tools are registered in index.ts.
 */

import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  addComment,
  searchTrekker,
  readyTasks,
  listEpics,
  getEpic,
  createEpic,
  updateEpic,
  checkTrekkerAvailable,
} from './cli.js';

// ---------------------------------------------------------------------------
// Tool Registration Helper
// ---------------------------------------------------------------------------

export function registerAllTools(pi: ExtensionAPI): void {
  // ── trekker_list_tasks ──────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_list_tasks',
    label: 'List Trekker Tasks',
    description:
      'List tasks from Trekker with optional filters by status and/or epic ID. ' +
      'Use this to see what tasks exist, find tasks to work on, or check progress.',
    promptSnippet: 'List Trekker tasks filtered by status or epic',
    promptGuidelines: [
      'Use trekker_list_tasks to discover what tasks exist before creating new ones.',
      'Use trekker_list_tasks with status:in_progress to see what you are currently working on.',
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description:
            'Filter by status: todo, in_progress, completed, wont_fix, archived',
        }),
      ),
      epic_id: Type.Optional(
        Type.String({ description: 'Filter by epic ID (e.g., EPIC-1)' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const tasks = await listTasks({
          status: params.status,
          epic: params.epic_id,
        });
        if (tasks.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No tasks found matching the filters.' },
            ],
            details: { tasks: [] },
          };
        }
        const lines = tasks.map(
          (t) =>
            `${t.id} [${t.status}] P${t.priority} — ${t.title}` +
            (t.epicId ? ` (epic: ${t.epicId})` : '') +
            (t.parentTaskId ? ` (subtask of ${t.parentTaskId})` : ''),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Found ${tasks.length} task(s):\n${lines.join('\n')}`,
            },
          ],
          details: { tasks },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_get_task ────────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_get_task',
    label: 'Get Trekker Task Details',
    description:
      'Get full details for a specific Trekker task by ID, including its description, ' +
      'priority, status, tags, epic assignment, and parent task relationship.',
    promptSnippet: 'Get full details of a specific Trekker task by ID',
    parameters: Type.Object({
      id: Type.String({ description: 'Task ID (e.g., TREK-1)' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const task = await getTask(params.id);
        const fields = [
          `ID: ${task.id}`,
          `Title: ${task.title}`,
          `Status: ${task.status}`,
          `Priority: ${task.priority}`,
          `Description: ${task.description ?? '(none)'}`,
          `Epic: ${task.epicId ?? '(none)'}`,
          `Parent Task: ${task.parentTaskId ?? '(none)'}`,
          `Tags: ${task.tags ?? '(none)'}`,
          `Created: ${task.createdAt}`,
          `Updated: ${task.updatedAt}`,
        ];
        return {
          content: [{ type: 'text', text: fields.join('\n') }],
          details: { task },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_create_task ─────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_create_task',
    label: 'Create Trekker Task',
    description:
      'Create a new task or subtask in Trekker. Provide a title, optional description, ' +
      'priority (0-5, default 2), optional epic ID to assign to, and optional parent task ID ' +
      'to create a subtask. ALWAYS search first before creating to avoid duplicates.',
    promptSnippet: 'Create a new task or subtask in Trekker',
    promptGuidelines: [
      'Use trekker_search before trekker_create_task to avoid creating duplicate tasks.',
      'Use parent_id to create a subtask under an existing task.',
    ],
    parameters: Type.Object({
      title: Type.String({ description: 'Task title' }),
      description: Type.Optional(
        Type.String({ description: 'Task description' }),
      ),
      priority: Type.Optional(
        Type.Number({
          description: 'Priority (0=critical, 1=high, 2=medium, 3=low, 4=very low, 5=someday)',
          default: 2,
        }),
      ),
      epic_id: Type.Optional(
        Type.String({ description: 'Epic ID to assign this task to (e.g., EPIC-1)' }),
      ),
      parent_id: Type.Optional(
        Type.String({
          description: 'Parent task ID to create a subtask under (e.g., TREK-1)',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const task = await createTask({
          title: params.title,
          description: params.description,
          priority: params.priority,
          epicId: params.epic_id,
          parentId: params.parent_id,
        });
        const parentNote = task.parentTaskId
          ? ` (subtask of ${task.parentTaskId})`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Created ${task.id}: "${task.title}" [${task.status}] P${task.priority}${parentNote}`,
            },
          ],
          details: { task },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_update_task ─────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_update_task',
    label: 'Update Trekker Task',
    description:
      'Update an existing Trekker task. Can change status, priority, title, and/or description. ' +
      'Common status values: todo, in_progress, completed, wont_fix, archived.',
    promptSnippet: 'Update a Trekker task status, priority, or details',
    promptGuidelines: [
      'Use trekker_update_task with status:completed to mark tasks done.',
      'Only set one task to in_progress at a time.',
    ],
    parameters: Type.Object({
      id: Type.String({ description: 'Task ID to update (e.g., TREK-1)' }),
      status: Type.Optional(
        Type.String({
          description:
            'New status: todo, in_progress, completed, wont_fix, archived',
        }),
      ),
      priority: Type.Optional(
        Type.Number({
          description: 'New priority (0=critical, 1=high, 2=medium, 3=low, 4=very low, 5=someday)',
        }),
      ),
      title: Type.Optional(Type.String({ description: 'New title' })),
      description: Type.Optional(
        Type.String({ description: 'New description' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const task = await updateTask(params.id, {
          title: params.title,
          description: params.description,
          priority: params.priority,
          status: params.status,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Updated ${task.id}: "${task.title}" [${task.status}] P${task.priority}`,
            },
          ],
          details: { task },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_comment ─────────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_comment',
    label: 'Add Trekker Comment',
    description:
      'Add a comment to a Trekker task. The author is automatically set to "claude". ' +
      'Use this to document progress, decisions, or context before ending a session or switching context.',
    promptSnippet: 'Add a comment to a Trekker task',
    promptGuidelines: [
      'Use trekker_comment before context resets or session changes to document progress.',
      'Always include what was done and any remaining work in the comment.',
    ],
    parameters: Type.Object({
      task_id: Type.String({ description: 'Task ID to comment on (e.g., TREK-1)' }),
      content: Type.String({ description: 'Comment content' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const comment = await addComment(params.task_id, params.content, 'claude');
        return {
          content: [
            {
              type: 'text',
              text: `Comment ${comment.id} added to ${params.task_id}`,
            },
          ],
          details: { comment },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_search ──────────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_search',
    label: 'Search Trekker',
    description:
      'Full-text search across all Trekker entities (epics, tasks, subtasks, and comments). ' +
      'Supports FTS5 syntax. Optionally filter by entity type. ALWAYS search before creating.',
    promptSnippet: 'Search Trekker epics, tasks, subtasks, and comments',
    promptGuidelines: [
      'ALWAYS use trekker_search before trekker_create_task or trekker_create_epic to check for duplicates.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (supports FTS5 syntax)' }),
      type: Type.Optional(
        Type.String({
          description:
            'Filter by type: epic, task, subtask, comment (comma-separated for multiple)',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const results = await searchTrekker(
          params.query,
          params.type as any,
        );
        if (results.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No results found.' },
            ],
            details: { results: [] },
          };
        }
        const lines = results.map(
          (r) =>
            `[${r.type}] ${r.id} — ${r.title ?? '(no title)'} (${r.status})` +
            (r.snippet ? `\n  ${r.snippet}` : '') +
            (r.parentId ? `\n  parent: ${r.parentId}` : ''),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Found ${results.length} result(s) for "${params.query}":\n${lines.join('\n')}`,
            },
          ],
          details: { results },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_ready ───────────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_ready',
    label: 'Ready Trekker Tasks',
    description:
      'List Trekker tasks that are unblocked and ready to start working on. ' +
      'Use this when you need a task to work on but none is in_progress.',
    promptSnippet: 'List unblocked Trekker tasks ready to start',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const tasks = await readyTasks();
        if (tasks.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No ready tasks. Create one with trekker_create_task.',
              },
            ],
            details: { tasks: [] },
          };
        }
        const lines = tasks.map(
          (t) =>
            `  ${t.id} P${t.priority} — ${t.title}` +
            (t.description ? `\n    ${t.description}` : ''),
        );
        return {
          content: [
            {
              type: 'text',
              text: `${tasks.length} ready task(s):\n${lines.join('\n')}`,
            },
          ],
          details: { tasks },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_list_epics ──────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_list_epics',
    label: 'List Trekker Epics',
    description:
      'List all epics in Trekker with optional status filter.',
    promptSnippet: 'List Trekker epics',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description:
            'Filter by status: todo, in_progress, completed, archived',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const epics = await listEpics({ status: params.status });
        if (epics.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No epics found.' },
            ],
            details: { epics: [] },
          };
        }
        const lines = epics.map(
          (e) =>
            `${e.id} [${e.status}] P${e.priority} — ${e.title}`,
        );
        return {
          content: [
            {
              type: 'text',
              text: `Found ${epics.length} epic(s):\n${lines.join('\n')}`,
            },
          ],
          details: { epics },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_get_epic ────────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_get_epic',
    label: 'Get Trekker Epic Details',
    description:
      'Get full details for a specific epic by ID, including its description, ' +
      'status, priority, and associated tasks.',
    promptSnippet: 'Get full details of a specific Trekker epic with its tasks',
    parameters: Type.Object({
      id: Type.String({ description: 'Epic ID (e.g., EPIC-1)' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const epic = await getEpic(params.id);
        // Also fetch associated tasks
        const tasks = await listTasks({ epic: params.id });
        const fields = [
          `ID: ${epic.id}`,
          `Title: ${epic.title}`,
          `Status: ${epic.status}`,
          `Priority: ${epic.priority}`,
          `Description: ${epic.description ?? '(none)'}`,
          `Created: ${epic.createdAt}`,
          `Updated: ${epic.updatedAt}`,
          '',
          `Tasks (${tasks.length}):`,
          ...(tasks.length > 0
            ? tasks.map(
                (t) =>
                  `  ${t.id} [${t.status}] — ${t.title}`,
              )
            : ['  (none)']),
        ];
        return {
          content: [{ type: 'text', text: fields.join('\n') }],
          details: { epic, tasks },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_create_epic ─────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_create_epic',
    label: 'Create Trekker Epic',
    description:
      'Create a new epic in Trekker to group related tasks. Provide a title, ' +
      'optional description, and optional priority. ALWAYS search first before creating.',
    promptSnippet: 'Create a new epic in Trekker',
    promptGuidelines: [
      'Use trekker_search before trekker_create_epic to check for existing epics.',
      'After creating an epic, create tasks within it using trekker_create_task with epic_id.',
    ],
    parameters: Type.Object({
      title: Type.String({ description: 'Epic title' }),
      description: Type.Optional(
        Type.String({ description: 'Epic description' }),
      ),
      priority: Type.Optional(
        Type.Number({
          description: 'Priority (0=critical, 1=high, 2=medium, 3=low, 4=very low, 5=someday)',
          default: 2,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const epic = await createEpic({
          title: params.title,
          description: params.description,
          priority: params.priority,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created ${epic.id}: "${epic.title}" [${epic.status}] P${epic.priority}`,
            },
          ],
          details: { epic },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });

  // ── trekker_update_epic ─────────────────────────────────────────────
  pi.registerTool({
    name: 'trekker_update_epic',
    label: 'Update Trekker Epic',
    description:
      'Update an existing Trekker epic. Can change status, priority, title, and/or description. ' +
      'When an epic is completed, all its tasks should be completed first.',
    promptSnippet: 'Update a Trekker epic status, priority, or details',
    parameters: Type.Object({
      id: Type.String({ description: 'Epic ID to update (e.g., EPIC-1)' }),
      status: Type.Optional(
        Type.String({
          description:
            'New status: todo, in_progress, completed, archived',
        }),
      ),
      priority: Type.Optional(
        Type.Number({
          description: 'New priority (0=critical, 1=high, 2=medium, 3=low, 4=very low, 5=someday)',
        }),
      ),
      title: Type.Optional(Type.String({ description: 'New title' })),
      description: Type.Optional(
        Type.String({ description: 'New description' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        return notInitializedResult();
      }
      try {
        const epic = await updateEpic(params.id, {
          title: params.title,
          description: params.description,
          priority: params.priority,
          status: params.status,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Updated ${epic.id}: "${epic.title}" [${epic.status}] P${epic.priority}`,
            },
          ],
          details: { epic },
        };
      } catch (err: unknown) {
        return toolError(err);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notInitializedResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Trekker is not available in this project. Either the `trekker` CLI is not installed or no `.trekker/` directory was found. Run `trekker init` to get started.',
      },
    ],
    details: { available: false },
    isError: true,
  };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Trekker error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}
