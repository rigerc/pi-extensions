/**
 * pi-trekker-tasks
 *
 * Task management extension backed by the trekker CLI, modeled on edb-todo.
 *
 * Tools:
 *   TaskCreate        — Create a task in trekker
 *   TaskList          — List tasks (optionally filtered)
 *   TaskGet           — Get full task details from trekker
 *   TaskUpdate        — Update status, title, description, priority, or tags
 *   TaskDelete        — Delete (archive) a task
 *   TaskComment       — Add a progress note to a trekker task
 *   TaskCommentList   — List comments on a task
 *   TaskListSubtasks  — List subtasks for a parent task
 *   TaskSearch        — Full-text search across trekker
 *
 * Features:
 *   - Live widget above editor (animated spinner, color-coded status)
 *   - System prompt injection of active tasks each turn
 *   - Periodic reminder when task tools go unused for 4+ turns
 *   - Auto-clear completed tasks from widget (configurable)
 *   - Bash interception: raw `trekker` CLI calls are rerouted through Pi tools
 *
 * Commands:
 *   /trekker-tasks   — interactive task viewer and settings
 *   /trekker-ingest  — convert a query or file into trekker tasks via the agent
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { AutoClearManager } from './auto-clear.js';
import { openTrekkerTasksMenu, TrekkerTasksViewComponent } from './component.js';
import { loadConfig } from './config.js';
import type { TrekkerTasksConfig } from './config.js';
import { checkTrekkerAvailable, clearAvailabilityCache } from './cli.js';
import { interceptBashCommand } from './interceptor.js';
import { buildSystemPromptBlock } from './prompt.js';
import {
  TaskCreateParams,
  TaskListParams,
  TaskGetParams,
  TaskUpdateParams,
  TaskDeleteParams,
  TaskCommentParams,
  TaskCommentListParams,
  TaskListSubtasksParams,
  TaskSearchParams,
  TaskReadyParams,
  TaskHistoryParams,
  TaskCompleteParams,
  EpicCreateParams,
  EpicListParams,
  EpicGetParams,
  EpicUpdateParams,
  EpicDeleteParams,
  DepAddParams,
  DepRemoveParams,
  DepListParams,
  CommentUpdateParams,
  CommentDeleteParams,
  SubtaskUpdateParams,
  SubtaskDeleteParams,
  TrekkerInitParams,
  TrekkerQuickstartParams,
} from './schemas.js';
import { priorityColor, priorityLabel, renderTaskListResult, TrekkerWidget } from './state.js';
import { TrekkerStore } from './trekker-store.js';
import type { TaskPriority, TaskStatus, EpicStatus } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const TASK_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'TaskDelete',
  'TaskComment',
  'TaskCommentList',
  'TaskListSubtasks',
  'TaskSearch',
  'TaskReady',
  'TaskHistory',
  'TaskComplete',
  'EpicCreate',
  'EpicList',
  'EpicGet',
  'EpicUpdate',
  'EpicDelete',
  'DepAdd',
  'DepRemove',
  'DepList',
  'CommentUpdate',
  'CommentDelete',
  'SubtaskUpdate',
  'SubtaskDelete',
  'TrekkerInit',
  'TrekkerQuickstart',
]);
const REMINDER_INTERVAL = 4;
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The trekker task tools haven't been used recently. If you're working on tasks, consider using TaskSearch to find related work, TaskCreate to track new work, TaskUpdate to set in_progress when starting, and TaskComplete when done. Use TaskReady to review unblocked work. Ignore this if not applicable. Never mention this reminder to the user.
</system-reminder>`;

// ── Extension entry point ──────────────────────────────────────────────────────

export default function trekkerTasksExtension(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  let cfg: TrekkerTasksConfig = loadConfig(cwd);
  let enabled = false;

  const store = new TrekkerStore();
  const widget = new TrekkerWidget(store);
  const autoClear = new AutoClearManager(
    () => store,
    () => cfg.autoClearCompleted ?? 'on_list_complete',
    AUTO_CLEAR_DELAY,
  );

  // ── Turn tracking ──────────────────────────────────────────────────────────
  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let lastSearchTurn = -Infinity;
  let reminderInjectedThisCycle = false;
  let trekkerUsedThisTurn = false;

  function markTrekkerUsed() {
    trekkerUsedThisTurn = true;
    lastTaskToolUseTurn = currentTurn;
    reminderInjectedThisCycle = false;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on('session_start', async (event, ctx) => {
    cwd = ctx.cwd;
    cfg = loadConfig(cwd);
    clearAvailabilityCache();
    enabled = checkTrekkerAvailable(cwd);

    if (!enabled) return;

    store.resetHidden();
    autoClear.reset();
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    lastSearchTurn = -Infinity;
    reminderInjectedThisCycle = false;
    trekkerUsedThisTurn = false;

    widget.setUICtx(ctx.ui);

    await store.refresh();
    widget.update();
  });

  // ── System prompt injection ────────────────────────────────────────────────

  pi.on('before_agent_start', async (event, ctx) => {
    if (!enabled) return;
    cwd = ctx.cwd;
    cfg = loadConfig(cwd);
    widget.setUICtx(ctx.ui);

    await store.refresh();
    widget.update();

    const block = await buildSystemPromptBlock(store);
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  // ── Turn start: auto-clear + reminder setup ────────────────────────────────

  pi.on('turn_start', async (_event, ctx) => {
    if (!enabled) return;
    cwd = ctx.cwd;
    cfg = loadConfig(cwd);
    widget.setUICtx(ctx.ui);
    currentTurn++;
    trekkerUsedThisTurn = false;

    if (autoClear.onTurnStart(currentTurn)) widget.update();
  });

  // ── Tool result: reminder injection + widget refresh ───────────────────────

  pi.on('tool_result', async (event) => {
    if (!enabled) return;

    if (TASK_TOOL_NAMES.has(event.toolName)) {
      markTrekkerUsed();
      // Refresh widget after Pi tool mutations
      await store.refresh();
      widget.update();
      return {};
    }

    // Bash tool: check if it was an intercepted trekker call (widget already refreshed in hook)
    if (event.toolName === 'bash') {
      const cmd: string = (event.input as any)?.command ?? '';
      if (cmd && /\btrekker\b/.test(cmd)) {
        // Even for mixed commands (not intercepted), refresh widget
        markTrekkerUsed();
        await store.refresh();
        widget.update();
      }
    }

    // Reminder injection if task tools idle
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return {};
    if (reminderInjectedThisCycle) return {};
    if (store.list().length === 0) return {};
    reminderInjectedThisCycle = true;
    lastTaskToolUseTurn = currentTurn;
    return {
      content: [...event.content, { type: 'text' as const, text: SYSTEM_REMINDER }],
    };
  });

  // ── tool_call: bash interception ───────────────────────────────────────────

  pi.on('tool_call', async (event) => {
    if (!enabled) return;
    if (event.toolName !== 'bash') return;

    const cmd: string = (event.input as any)?.command ?? '';
    if (!cmd) return;

    const result = await interceptBashCommand(cmd, store, () => {
      markTrekkerUsed();
      widget.update();
    });

    if (!result) return;
    if ('trekkerUsed' in result) return; // mixed command — let bash run
    return result; // { block: true, reason: "..." }
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!enabled) return;
    widget.setUICtx(ctx.ui);
    widget.update();
  });

  // ── Tool: TaskCreate ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskCreate',
    label: 'TaskCreate',
    description: `Create a task in trekker to track work across sessions.

## When to Use
- Multi-step tasks (3+ distinct steps)
- Non-trivial work that needs tracking
- When the user asks you to use a task list
- Immediately after receiving new instructions

## When NOT to Use
- Single trivial tasks
- Pure conversational responses

## Fields
- **content**: Actionable title in imperative form ("Fix auth bug in login flow")
- **description**: Detailed context and acceptance criteria
- **priority**: urgent / high / medium / low / lowest (default: medium)
- **tags**: Comma-separated tags for categorization (e.g. "frontend,bug")
- **parentId**: TREK-N to create as a subtask
- **epicId**: EPIC-N to associate with an epic`,

    promptGuidelines: [
      'Mark tasks as in_progress before starting and completed when done.',
      'Use TaskList to review open work before starting something new.',
    ],
    parameters: TaskCreateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      autoClear.resetBatchCountdown();
      widget.setUICtx(ctx.ui);

      const task = await store.create({
        content: params.content as string,
        description: params.description as string | undefined,
        priority: params.priority as TaskPriority | undefined,
        tags: params.tags as string | undefined,
        parentId: params.parentId as string | undefined,
        epicId: params.epicId as string | undefined,
      });
      widget.update();

      const searchHint =
        currentTurn - lastSearchTurn > 4
          ? ' Search-first reminder: run TaskSearch before creating related future tasks to avoid duplicates.'
          : '';
      return {
        content: [{ type: 'text', text: `Task ${task.id} created: ${task.content}${searchHint}` }],
        details: { tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      const content = (args.content as string) ?? '';
      const priority = (args.priority as string) ?? 'medium';
      const pColor = priorityColor(priority as TaskPriority);
      const pLabel = theme.fg(pColor, priorityLabel(priority as TaskPriority));
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskCreate ')) + pLabel}  ${theme.fg('muted', content)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: TaskList ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskList',
    label: 'TaskList',
    description: `List all trekker tasks with their current status and priority.

Use to:
- See what work is todo or in progress
- Check overall progress
- Find tasks to start after completing one
- Filter by status or epic`,

    promptSnippet: 'List all trekker tasks with status, priority, and ID',
    parameters: TaskListParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      await store.refresh();
      widget.update();

      let tasks = store.list();
      const filterStatus = params.status as string | undefined;
      const filterEpic = params.epicId as string | undefined;
      if (filterStatus) {
        tasks = tasks.filter((t) => t.status === filterStatus);
      }
      if (filterEpic) {
        tasks = tasks.filter((t) => t.epicId === filterEpic);
      }
      const limit = params.limit as number | undefined;
      const page = (params.page as number | undefined) ?? 1;
      if (tasks.length === 0) {
        const parts: string[] = [];
        if (filterStatus) parts.push(`status=${filterStatus}`);
        if (filterEpic) parts.push(`epic=${filterEpic}`);
        const filterText = parts.length ? ` (${parts.join(', ')})` : '';
        return {
          content: [{ type: 'text', text: `No tasks found${filterText}.` }],
          details: { tasks: [] },
        };
      }

      const statusOrder: Record<string, number> = {
        todo: 0,
        in_progress: 1,
        completed: 2,
        wont_fix: 3,
        archived: 4,
      };
      let sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        return so !== 0 ? so : a.id.localeCompare(b.id);
      });
      if (limit && limit > 0) {
        const start = Math.max(0, page - 1) * limit;
        sorted = sorted.slice(start, start + limit);
      }

      const lines = sorted.map((t) => {
        let line = `[${t.status}] [${t.priority}] ${t.id} ${t.content}`;
        if (t.parentId) line += ` [subtask of ${t.parentId}]`;
        if (t.epicId) line += ` [epic: ${t.epicId}]`;
        if (t.tags) line += ` [tags: ${t.tags}]`;
        return line;
      });

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { tasks: sorted, epics: await store.listEpics() },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('TaskList')), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
        (result.details as any)?.epics ?? [],
      );
    },
  });

  // ── Tool: TaskGet ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskGet',
    label: 'TaskGet',
    description: `Retrieve full details for a trekker task by ID.

Use to:
- Read the full description and requirements before starting work
- Check which epic a task belongs to
- Get task metadata before updating`,

    parameters: TaskGetParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);

      const task = await store.getFromCli(params.id as string);
      const lines = [
        `ID:       ${task.id}`,
        `Title:    ${task.content}`,
        `Status:   ${task.status}`,
        `Priority: ${task.priority}`,
      ];
      if (task.description) lines.push(`Desc:     ${task.description}`);
      if (task.epicId) lines.push(`Epic:     ${task.epicId}`);
      if (task.parentId) lines.push(`Parent:   ${task.parentId}`);
      if (task.tags) lines.push(`Tags:     ${task.tags}`);

      return { content: [{ type: 'text', text: lines.join('\n') }], details: { task } };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskGet '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const task = (result.details as any)?.task;
      if (!task) return new Text(theme.fg('error', 'Task not found'), 0, 0);
      const pColor = priorityColor(task.priority as TaskPriority);
      const pLabel = theme.fg(pColor, priorityLabel(task.priority as TaskPriority));
      return new Text(
        `${theme.fg('accent', task.id)}  ${pLabel}  ${theme.fg('muted', task.status)}\n${task.content}`,
        0,
        0,
      );
    },
  });

  // ── Tool: TaskUpdate ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskUpdate',
    label: 'TaskUpdate',
    description: `Update a trekker task's status, title, description, priority, or tags.

Status values:
- **todo** — not started
- **in_progress** — set BEFORE starting work
- **completed** — set when done
- **wont_fix** — abandoned or intentionally not completed
- **archived** — remove from active views`,

    parameters: TaskUpdateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);

      const task = await store.update(params.id as string, {
        content: params.content as string | undefined,
        description: params.description as string | undefined,
        priority: params.priority as TaskPriority | undefined,
        status: params.status as TaskStatus | undefined,
        tags: params.tags as string | undefined,
        epicId: params.epicId as string | undefined,
        removeEpic: params.removeEpic as boolean | undefined,
      });

      // Track completions for auto-clear
      if (task.status === 'completed') {
        autoClear.trackCompletion(task.id, currentTurn);
      }

      widget.update();

      return {
        content: [{ type: 'text', text: `Task ${task.id} updated → ${task.status}` }],
        details: { tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      const id = String(args.id ?? '');
      const status = args.status ? theme.fg('muted', ` → ${args.status}`) : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskUpdate '))}${theme.fg('accent', id)}${status}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: TaskDelete ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskDelete',
    label: 'TaskDelete',
    description: `Delete (archive) a trekker task by ID.

Use to:
- Remove obsolete or cancelled tasks from the backlog`,

    parameters: TaskDeleteParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);

      const task = await store.deleteTask(params.id as string);
      widget.update();

      return {
        content: [{ type: 'text', text: `Task ${task.id} deleted (archived): ${task.content}` }],
        details: { tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskDelete '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: TaskComment ──────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskComment',
    label: 'TaskComment',
    description: `Add a progress note or decision record to a trekker task.

Use for:
- Progress updates during long-running tasks
- Recording decisions and rationale
- Summarising work before marking completed

Comments are stored in trekker's database and visible in \`trekker comment list <id>\`.`,

    parameters: TaskCommentParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      await store.comment(params.id as string, params.content as string);
      return {
        content: [{ type: 'text', text: `Comment added to ${params.id}.` }],
        details: null,
      };
    },

    renderCall(args, theme) {
      const id = String(args.id ?? '');
      const preview = String(args.content ?? '').slice(0, 40);
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskComment '))}${theme.fg('accent', id)}  ${theme.fg('muted', preview)}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      return new Text(theme.fg('success', text), 0, 0);
    },
  });

  // ── Tool: TaskCommentList ──────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskCommentList',
    label: 'TaskCommentList',
    description: `List all comments on a trekker task.

Use for:
- Reviewing task history and decision records
- Checking prior progress notes before resuming work`,

    parameters: TaskCommentListParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      const comments = await store.listComments(params.id as string);
      if (comments.length === 0) {
        return {
          content: [{ type: 'text', text: `No comments on ${params.id}.` }],
          details: { comments: [] },
        };
      }
      const lines = comments.map((c) => `[${c.createdAt}] ${c.author}: ${c.content}`);
      return {
        content: [{ type: 'text', text: `Comments on ${params.id}:\n${lines.join('\n')}` }],
        details: { comments },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskCommentList '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const comments = (result.details as any)?.comments ?? [];
      if (!comments.length) return new Text(theme.fg('dim', 'No comments'), 0, 0);
      const lines = comments.map(
        (c: any) =>
          `${theme.fg('dim', `[${c.createdAt}]`)}  ${theme.fg('muted', c.author)}: ${c.content?.slice(0, 60) ?? ''}`,
      );
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── Tool: CommentUpdate ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'CommentUpdate',
    label: 'CommentUpdate',
    description: `Update a Trekker comment by comment ID.`,
    parameters: CommentUpdateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const comment = await store.updateComment(
        params.commentId as string,
        params.content as string,
      );
      return {
        content: [{ type: 'text', text: `Comment ${comment.id} updated.` }],
        details: { comment },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('CommentUpdate '))}${theme.fg('muted', String(args.commentId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('success', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Tool: CommentDelete ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'CommentDelete',
    label: 'CommentDelete',
    description: `Delete a Trekker comment by comment ID.`,
    parameters: CommentDeleteParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const comment = await store.deleteComment(params.commentId as string);
      return {
        content: [{ type: 'text', text: `Comment ${comment.id} deleted.` }],
        details: { comment },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('CommentDelete '))}${theme.fg('muted', String(args.commentId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('dim', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Tool: TaskListSubtasks ─────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskListSubtasks',
    label: 'TaskListSubtasks',
    description: `List subtasks for a given parent task.

Use for:
- Checking progress on a multi-step task
- Seeing which subtasks are in progress, todo, or completed`,

    parameters: TaskListSubtasksParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const subtasks = await store.listSubtasks(params.parentTaskId as string);
      if (subtasks.length === 0) {
        return {
          content: [{ type: 'text', text: `No subtasks for ${params.parentTaskId}.` }],
          details: { subtasks: [] },
        };
      }
      const lines = subtasks.map((t) => {
        const icon = t.status === 'in_progress' ? '●' : t.status === 'completed' ? '✓' : '○';
        return `${icon} [${t.status}] [${t.priority}] ${t.id} ${t.content}`;
      });
      return {
        content: [
          { type: 'text', text: `Subtasks for ${params.parentTaskId}:\n${lines.join('\n')}` },
        ],
        details: { subtasks },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskListSubtasks '))}${theme.fg('muted', String(args.parentTaskId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const subtasks = (result.details as any)?.subtasks ?? [];
      if (!subtasks.length) return new Text(theme.fg('dim', 'No subtasks'), 0, 0);
      const lines = subtasks.map((t: any) => {
        const icon =
          t.status === 'in_progress'
            ? theme.fg('accent', '●')
            : t.status === 'completed'
              ? theme.fg('success', '✓')
              : theme.fg('dim', '○');
        return `${icon} ${theme.fg('accent', t.id)}  ${theme.fg('muted', t.status)}  ${t.content}`;
      });
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── Tool: SubtaskUpdate ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'SubtaskUpdate',
    label: 'SubtaskUpdate',
    description: `Update a Trekker subtask's status, title, description, or priority.`,
    parameters: SubtaskUpdateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const subtask = await store.updateSubtask(params.id as string, {
        content: params.content as string | undefined,
        description: params.description as string | undefined,
        priority: params.priority as TaskPriority | undefined,
        status: params.status as TaskStatus | undefined,
      });
      widget.update();
      return {
        content: [{ type: 'text', text: `Subtask ${subtask.id} updated → ${subtask.status}` }],
        details: { subtask, tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      const id = String(args.id ?? '');
      const status = args.status ? theme.fg('muted', ` → ${args.status}`) : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('SubtaskUpdate '))}${theme.fg('accent', id)}${status}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: SubtaskDelete ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'SubtaskDelete',
    label: 'SubtaskDelete',
    description: `Archive/delete a Trekker subtask by ID.`,
    parameters: SubtaskDeleteParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const subtask = await store.deleteSubtask(params.id as string);
      widget.update();
      return {
        content: [{ type: 'text', text: `Subtask ${subtask.id} archived.` }],
        details: { subtask, tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('SubtaskDelete '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: TaskSearch ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskSearch',
    label: 'TaskSearch',
    description: `Full-text search across trekker tasks, subtasks, epics, and comments.

Search before creating new tasks to avoid duplicates.
Useful for finding related work, past decisions, or tasks by keyword.`,

    parameters: TaskSearchParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);

      lastSearchTurn = currentTurn;
      const results = await store.search(params.query as string, params.type as any);
      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No results for "${params.query}".` }],
          details: null,
        };
      }

      const lines = results.map((r) => `[${r.type}] ${r.id} (${r.status}) — ${r.snippet}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { results },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskSearch '))}${theme.fg('muted', String(args.query ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const results = (result.details as any)?.results ?? [];
      if (!results.length) return new Text(theme.fg('dim', 'No results'), 0, 0);
      const lines = results
        .slice(0, 5)
        .map(
          (r: any) =>
            `${theme.fg('accent', r.id)}  ${theme.fg('dim', r.type)}  ${r.snippet?.slice(0, 60) ?? ''}`,
        );
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── Tool: TaskReady ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskReady',
    label: 'TaskReady',
    description: `Show todo tasks that are ready to work on according to Trekker dependency state.

Use after completing work or when deciding what to start next.`,
    parameters: TaskReadyParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const ready = await store.ready();
      const limit = params.limit as number | undefined;
      const tasks = limit ? ready.slice(0, limit) : ready;
      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: 'No ready tasks found.' }], details: { tasks } };
      }
      const lines = tasks.map((t) => `[${t.status}] [${t.priority}] ${t.id} ${t.content}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { tasks },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('TaskReady')), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: TaskHistory ─────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskHistory',
    label: 'TaskHistory',
    description: `Show Trekker history for context recovery and conflict checks.

Use before modifying existing tasks, when resuming work, or when investigating recent changes.`,
    parameters: TaskHistoryParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const text = await store.history({
        limit: params.limit as number | undefined,
        entity: params.entity as string | undefined,
        type: params.type as string | undefined,
        action: params.action as string | undefined,
        since: params.since as string | undefined,
      });
      return { content: [{ type: 'text', text: text || 'No history found.' }], details: { text } };
    },

    renderCall(args, theme) {
      const entity = args.entity ? ` ${String(args.entity)}` : '';
      return new Text(`${theme.fg('toolTitle', theme.bold('TaskHistory'))}${entity}`, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const text = ((result.details as any)?.text ?? '').split('\n').slice(0, 8).join('\n');
      return new Text(theme.fg('muted', text || 'No history'), 0, 0);
    },
  });

  // ── Tool: TaskComplete ────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TaskComplete',
    label: 'TaskComplete',
    description: `Complete a task using the required Trekker workflow: add a summary comment, mark completed, then show ready tasks.`,
    parameters: TaskCompleteParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const taskId = params.id as string;
      const summary = params.summary as string;
      await store.comment(taskId, summary.startsWith('Summary:') ? summary : `Summary: ${summary}`);
      const task = await store.update(taskId, { status: 'completed' });
      autoClear.trackCompletion(task.id, currentTurn);
      const ready = await store.ready();
      widget.update();
      const readyText =
        ready.length > 0
          ? `\n\nNext ready tasks:\n${ready.map((t) => `[${t.priority}] ${t.id} ${t.content}`).join('\n')}`
          : '\n\nNo ready tasks found.';
      return {
        content: [{ type: 'text', text: `Task ${task.id} completed.${readyText}` }],
        details: { task, ready, tasks: store.list() },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('TaskComplete '))}${theme.fg('accent', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      return TrekkerTasksViewComponent.renderTaskResult(
        (result.details as any)?.tasks ?? [],
        expanded,
        theme,
      );
    },
  });

  // ── Tool: EpicCreate ──────────────────────────────────────────────────────

  pi.registerTool({
    name: 'EpicCreate',
    label: 'EpicCreate',
    description: `Create an epic in trekker to group related tasks.

Use when work spans multiple tasks that share a goal or deliverable.
Create the epic first, then use TaskCreate with \`epicId\` to associate tasks.`,
    parameters: EpicCreateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const epic = await store.createEpic({
        title: params.title as string,
        description: params.description as string | undefined,
        priority: params.priority as TaskPriority | undefined,
      });
      return {
        content: [{ type: 'text', text: `Epic ${epic.id} created: ${epic.title}` }],
        details: { epic },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('EpicCreate '))}${theme.fg('muted', String(args.title ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const epic = (result.details as any)?.epic;
      if (!epic) return new Text(theme.fg('error', 'Epic not created'), 0, 0);
      return new Text(
        `${theme.fg('accent', epic.id)}  ${theme.fg('muted', epic.status)}\n${epic.title}`,
        0,
        0,
      );
    },
  });

  // ── Tool: EpicList ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'EpicList',
    label: 'EpicList',
    description: `List epics in trekker, optionally filtered by status.

Use to find the right epicId before creating tasks, or to review overall progress.`,
    parameters: EpicListParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      let epics = await store.listEpics(params.status as EpicStatus | undefined);
      const limit = params.limit as number | undefined;
      const page = (params.page as number | undefined) ?? 1;
      if (limit && limit > 0) {
        const start = Math.max(0, page - 1) * limit;
        epics = epics.slice(start, start + limit);
      }
      if (epics.length === 0) {
        return { content: [{ type: 'text', text: 'No epics found.' }], details: { epics: [] } };
      }
      const lines = epics.map((e) => {
        const icon = e.status === 'in_progress' ? '●' : e.status === 'completed' ? '✓' : '○';
        return `${icon} [${e.status}] [${e.priority}] ${e.id} ${e.title}`;
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { epics },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('EpicList')), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const epics = (result.details as any)?.epics ?? [];
      if (!epics.length) return new Text(theme.fg('dim', 'No epics'), 0, 0);
      const lines = epics.slice(0, 5).map((e: any) => {
        const icon =
          e.status === 'in_progress'
            ? theme.fg('accent', '●')
            : e.status === 'completed'
              ? theme.fg('success', '✓')
              : theme.fg('dim', '○');
        return `${icon} ${theme.fg('accent', e.id)}  ${theme.fg('muted', e.title)}`;
      });
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── Tool: EpicGet ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'EpicGet',
    label: 'EpicGet',
    description: `Retrieve full details for a Trekker epic by ID.`,
    parameters: EpicGetParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const epic = await store.getEpic(params.id as string);
      const lines = [
        `ID:       ${epic.id}`,
        `Title:    ${epic.title}`,
        `Status:   ${epic.status}`,
        `Priority: ${epic.priority}`,
      ];
      if (epic.description) lines.push(`Desc:     ${epic.description}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { epic } };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('EpicGet '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const epic = (result.details as any)?.epic;
      if (!epic) return new Text(theme.fg('error', 'Epic not found'), 0, 0);
      return new Text(
        `${theme.fg('accent', epic.id)}  ${theme.fg('muted', epic.status)}\n${epic.title}`,
        0,
        0,
      );
    },
  });

  // ── Tool: EpicUpdate ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'EpicUpdate',
    label: 'EpicUpdate',
    description: `Update an epic's status, title, description, or priority.

Status values: todo, in_progress, completed, archived.`,
    parameters: EpicUpdateParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const epic = await store.updateEpic(params.id as string, {
        title: params.title as string | undefined,
        description: params.description as string | undefined,
        priority: params.priority as TaskPriority | undefined,
        status: params.status as EpicStatus | undefined,
      });
      return {
        content: [{ type: 'text', text: `Epic ${epic.id} updated → ${epic.status}` }],
        details: { epic },
      };
    },

    renderCall(args, theme) {
      const id = String(args.id ?? '');
      const status = args.status ? theme.fg('muted', ` → ${args.status}`) : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('EpicUpdate '))}${theme.fg('accent', id)}${status}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const epic = (result.details as any)?.epic;
      if (!epic) return new Text(theme.fg('error', 'Epic not found'), 0, 0);
      return new Text(
        `${theme.fg('accent', epic.id)}  ${theme.fg('muted', epic.status)}\n${epic.title}`,
        0,
        0,
      );
    },
  });

  // ── Tool: EpicDelete ───────────────────────────────────────────────────────

  pi.registerTool({
    name: 'EpicDelete',
    label: 'EpicDelete',
    description: `Archive/delete a Trekker epic by ID.`,
    parameters: EpicDeleteParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const epic = await store.deleteEpic(params.id as string);
      return {
        content: [{ type: 'text', text: `Epic ${epic.id} archived: ${epic.title}` }],
        details: { epic },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('EpicDelete '))}${theme.fg('muted', String(args.id ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const epic = (result.details as any)?.epic;
      if (!epic) return new Text(theme.fg('error', 'Epic not found'), 0, 0);
      return new Text(theme.fg('dim', `${epic.id} ${epic.status}`), 0, 0);
    },
  });

  // ── Tool: DepAdd ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'DepAdd',
    label: 'DepAdd',
    description: `Add a dependency between two tasks: taskId will not appear in ready tasks until dependsOnId is completed.

Use to make execution order explicit when tasks must run in sequence.`,
    parameters: DepAddParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      await store.addDep(params.taskId as string, params.dependsOnId as string);
      return {
        content: [
          {
            type: 'text',
            text: `Dependency added: ${params.taskId} depends on ${params.dependsOnId}.`,
          },
        ],
        details: null,
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('DepAdd '))}${theme.fg('accent', String(args.taskId ?? ''))} depends on ${theme.fg('accent', String(args.dependsOnId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('success', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Tool: DepRemove ────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'DepRemove',
    label: 'DepRemove',
    description: `Remove a dependency between two tasks.`,
    parameters: DepRemoveParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      await store.removeDep(params.taskId as string, params.dependsOnId as string);
      return {
        content: [
          {
            type: 'text',
            text: `Dependency removed: ${params.taskId} no longer depends on ${params.dependsOnId}.`,
          },
        ],
        details: null,
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('DepRemove '))}${theme.fg('accent', String(args.taskId ?? ''))} ← ${theme.fg('accent', String(args.dependsOnId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('dim', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Tool: DepList ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'DepList',
    label: 'DepList',
    description: `List task dependencies before starting or changing task status.`,
    parameters: DepListParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const deps = await store.listDeps(params.taskId as string);
      if (deps.length === 0) {
        return {
          content: [{ type: 'text', text: `No dependencies for ${params.taskId}.` }],
          details: { deps },
        };
      }
      const lines = deps.map((d) => `${d.taskId} depends on ${d.dependsOnTaskId}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { deps } };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('DepList '))}${theme.fg('muted', String(args.taskId ?? ''))}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('muted', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Tool: TrekkerQuickstart ───────────────────────────────────────────────

  pi.registerTool({
    name: 'TrekkerQuickstart',
    label: 'TrekkerQuickstart',
    description: `Show Trekker's token-efficient quickstart guide.`,
    parameters: TrekkerQuickstartParams,

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!enabled)
        return { content: [{ type: 'text', text: 'Trekker not available.' }], details: null };
      widget.setUICtx(ctx.ui);
      const text = await store.quickstart();
      return { content: [{ type: 'text', text }], details: { text } };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('TrekkerQuickstart')), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const text = ((result.details as any)?.text ?? '').split('\n').slice(0, 8).join('\n');
      return new Text(theme.fg('muted', text), 0, 0);
    },
  });

  // ── Tool: TrekkerInit ─────────────────────────────────────────────────────

  pi.registerTool({
    name: 'TrekkerInit',
    label: 'TrekkerInit',
    description: `Initialize Trekker in the current project. Requires confirm=true.`,
    parameters: TrekkerInitParams,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!params.confirm) {
        return {
          content: [{ type: 'text', text: 'TrekkerInit cancelled: confirm must be true.' }],
          details: null,
        };
      }
      widget.setUICtx(ctx.ui);
      const text = await store.init();
      clearAvailabilityCache();
      enabled = checkTrekkerAvailable(cwd);
      await store.refresh();
      widget.update();
      return {
        content: [{ type: 'text', text: text || 'Trekker initialized.' }],
        details: { text },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('TrekkerInit')), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const first = result.content[0];
      return new Text(theme.fg('success', first?.type === 'text' ? first.text : ''), 0, 0);
    },
  });

  // ── Command: /trekker-tasks ────────────────────────────────────────────────

  pi.registerCommand('trekker-tasks', {
    description: 'Open the trekker task manager',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!enabled) {
        ctx.ui.notify('pi-trekker-tasks: trekker not available in this project.', 'error');
        return;
      }
      widget.setUICtx(ctx.ui);
      await store.refresh();
      await openTrekkerTasksMenu(ctx.ui, store, cfg, cwd, async () => {
        await store.refresh();
        widget.update();
      });
      widget.update();
    },
  });

  // ── Command: /trekker-ingest ───────────────────────────────────────────────

  pi.registerCommand('trekker-ingest', {
    description:
      'Convert a query or file into trekker tasks (usage: /trekker-ingest <query or path>)',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!enabled) {
        ctx.ui.notify('pi-trekker-tasks: trekker not available — cannot ingest.', 'error');
        return;
      }
      const trimmed = args?.trim() ?? '';
      if (!trimmed) {
        ctx.ui.notify('Usage: /trekker-ingest <query or file path>', 'warning');
        return;
      }
      let input = trimmed;
      if (existsSync(trimmed)) {
        input = readFileSync(trimmed, 'utf-8');
      }
      pi.sendUserMessage(buildIngestMessage(input), { deliverAs: 'followUp' });
    },
  });
}

// ── /trekker-ingest prompt builder ────────────────────────────────────────────

function buildIngestMessage(input: string): string {
  return [
    'Ingest the following into Trekker as a structured set of tasks.',
    '',
    '## Input',
    '```',
    input.trim(),
    '```',
    '',
    '## Workflow',
    '',
    '### 1. Search first',
    'Use `TaskSearch` to check for existing related work before creating anything:',
    '```',
    'TaskSearch({ query: "<what you\'re about to do>" })',
    '```',
    'If matching tasks already exist, prefer updating them over creating duplicates.',
    '',
    '### 2. Plan & create',
    'Decide scope, then create everything in one pass:',
    '',
    '**Small scope (1–3 tasks):** create tasks directly:',
    '```',
    'TaskCreate({ content: "<task title>", description: "<detail>", priority: "urgent" | "high" | "medium" | "low" | "lowest", tags: "frontend,bug" })',
    '```',
    '',
    '**Larger scope:** create an epic first, then all tasks under it immediately:',
    '```',
    'EpicCreate({ title: "<Epic title>", description: "<description>", priority: "medium" })',
    'TaskCreate({ content: "<task>", description: "<detail>", epicId: "EPIC-N", priority: "medium" })',
    'TaskCreate({ content: "<task>", description: "<detail>", epicId: "EPIC-N", priority: "medium" })',
    '```',
    'Use `parentId` on `TaskCreate` to nest subtasks directly under a parent task.',
    '',
    '### 3. Wire dependencies (if order matters)',
    'Only if tasks must run in sequence:',
    '```',
    'DepAdd({ taskId: "TREK-B", dependsOnId: "TREK-A" })   // B waits for A',
    '```',
    '',
    'Keep tasks atomic and independently completable. Prefer `TaskComment` to record',
    'decisions or open questions rather than embedding them in titles.',
  ].join('\n');
}
