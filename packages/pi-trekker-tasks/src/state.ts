import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { TrekkerStore } from './trekker-store.js';
import type { Task, TaskPriority, TaskStatus, Epic } from './types.js';

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER = ['✳', '✴', '✵', '✶', '✷', '✸', '✹', '✺', '✻', '✼', '✽'];
const MAX_VISIBLE_TASKS = 12;

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

// ── TrekkerWidget ─────────────────────────────────────────────────────────────

export class TrekkerWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private store: TrekkerStore;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks actively in_progress (show spinner). */
  private activeTaskIds = new Set<string>();
  private taskStartedAt = new Map<string, number>();
  private tui: any | undefined;
  private widgetRegistered = false;
  /** Cached epics for summary display. */
  private epics: Epic[] = [];

  constructor(store: TrekkerStore) {
    this.store = store;
  }

  setStore(store: TrekkerStore) {
    this.store = store;
  }

  /** Update cached epics (call after store.refresh or epic mutations). */
  async refreshEpics(): Promise<void> {
    try {
      this.epics = await this.store.listEpics();
    } catch {
      // Keep stale epics on error
    }
  }

  setUICtx(ctx: ExtensionUIContext) {
    this.uiCtx = ctx;
  }

  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.taskStartedAt.has(taskId)) this.taskStartedAt.set(taskId, Date.now());
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
      this.taskStartedAt.delete(taskId);
    }
    this.update();
  }

  private ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 200);
    }
  }

  private renderTask(
    task: Task,
    isActive: boolean,
    spinnerChar: string,
    indent: number,
    theme: any,
    w: number,
  ): string {
    const truncate = (line: string) => truncateToWidth(line, w);
    const pad = `  ${'  '.repeat(indent)}`;

    let icon: string;
    if (isActive) {
      icon = theme.fg('accent', spinnerChar);
    } else if (task.status === 'completed') {
      icon = theme.fg('success', '✔');
    } else if (task.status === 'in_progress') {
      icon = theme.fg('accent', '◼');
    } else if (task.status === 'wont_fix') {
      icon = theme.fg('error', '✗');
    } else {
      icon = '◻';
    }

    const epicTag = task.epicId ? theme.fg('dim', ` [${task.epicId}]`) : '';

    let text: string;
    if (isActive) {
      const startedAt = this.taskStartedAt.get(task.id) ?? Date.now();
      const elapsed = formatDuration(Date.now() - startedAt);
      const stats = theme.fg('dim', `(${elapsed})`);
      text = `${pad}${icon} ${theme.fg('accent', `${task.content}…`)} ${stats}${epicTag}`;
    } else if (task.status === 'completed') {
      text = `${pad}${icon} ${theme.fg('dim', theme.strikethrough(task.content))}${epicTag}`;
    } else if (task.status === 'wont_fix') {
      text = `${pad}${icon} ${theme.fg('error', task.content)}${epicTag}`;
    } else {
      text = `${pad}${icon} ${task.content}${epicTag}`;
    }

    return truncate(text);
  }

  private renderWidget(tui: any, theme: any): string[] {
    const tasks = this.store.list();
    const w: number = tui.terminal?.columns ?? 80;

    if (tasks.length === 0) return [];

    const completed = tasks.filter((t) => t.status === 'completed');
    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    const wontFix = tasks.filter((t) => t.status === 'wont_fix');
    const todo = tasks.filter((t) => t.status === 'todo');

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (wontFix.length > 0) parts.push(theme.fg('error', `${wontFix.length} wont_fix`));
    if (todo.length > 0) parts.push(`${todo.length} todo`);
    const statusText = `${tasks.length} task${tasks.length !== 1 ? 's' : ''} (${parts.join(', ')})`;

    // Build epic summary: total epics + active count
    let epicSummary = '';
    if (this.epics.length) {
      const activeEpics = this.epics.filter(
        (e) => e.status === 'in_progress' || e.status === 'todo',
      );
      const epicLabel =
        activeEpics.length > 0
          ? `${activeEpics.length}/${this.epics.length} active epic${this.epics.length !== 1 ? 's' : ''}`
          : `${this.epics.length} epic${this.epics.length !== 1 ? 's' : ''}`;
      epicSummary = ` ${theme.fg('dim', `(${epicLabel})`)}`;
    }

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length]!;
    const lines: string[] = [
      truncateToWidth(
        `${theme.fg('accent', '●')} ${theme.fg('accent', statusText)}${epicSummary}`,
        w,
      ),
    ];

    // Render subtasks indented under their parent
    const childrenOf = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.parentId) {
        const arr = childrenOf.get(t.parentId) ?? [];
        arr.push(t);
        childrenOf.set(t.parentId, arr);
      }
    }

    const topLevel = tasks.filter((t) => !t.parentId);
    let rendered = 0;

    for (const task of topLevel) {
      if (rendered >= MAX_VISIBLE_TASKS) break;
      const isActive = this.activeTaskIds.has(task.id) && task.status === 'in_progress';
      lines.push(this.renderTask(task, isActive, spinnerChar, 0, theme, w));
      rendered++;

      for (const child of childrenOf.get(task.id) ?? []) {
        if (rendered >= MAX_VISIBLE_TASKS) break;
        const childActive = this.activeTaskIds.has(child.id) && child.status === 'in_progress';
        lines.push(this.renderTask(child, childActive, spinnerChar, 1, theme, w));
        rendered++;
      }
    }

    if (tasks.length > MAX_VISIBLE_TASKS) {
      lines.push(
        truncateToWidth(theme.fg('dim', `    … and ${tasks.length - MAX_VISIBLE_TASKS} more`), w),
      );
    }

    return lines;
  }

  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget('pi-trekker-tasks', undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Refresh epics for summary display (fire-and-forget, widget re-renders on next tick)
    this.refreshEpics().then(() => {
      if (this.tui) this.tui.requestRender();
    });

    // Prune stale active IDs
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== 'in_progress') {
        this.activeTaskIds.delete(id);
        this.taskStartedAt.delete(id);
      }
    }

    const hasActiveSpinner = tasks.some(
      (t) => this.activeTaskIds.has(t.id) && t.status === 'in_progress',
    );
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        'pi-trekker-tasks',
        (tui: any, theme: any) => {
          this.tui = tui;
          return {
            render: () => this.renderWidget(tui, theme),
            invalidate: () => {},
          };
        },
        { placement: 'aboveEditor' },
      );
      this.widgetRegistered = true;
    } else if (this.tui) {
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget('pi-trekker-tasks', undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}

// ── Shared rendering helpers ───────────────────────────────────────────────────

export const PRIORITY_THEME_COLOR: Record<TaskPriority, 'error' | 'warning' | 'dim'> = {
  urgent: 'error',
  high: 'error',
  medium: 'warning',
  low: 'dim',
  lowest: 'dim',
};

export function priorityColor(p: TaskPriority): 'error' | 'warning' | 'dim' {
  return PRIORITY_THEME_COLOR[p];
}

export function priorityLabel(p: TaskPriority): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function statusIcon(status: TaskStatus): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '●';
  return '○';
}

// ── Tool result rendering ─────────────────────────────────────────────────────

// ── Shared rendering helpers for single task lines ────────────────────────────

function renderTaskLine(task: Task, theme: any, includeSubtaskIndent = true): string {
  const icon =
    task.status === 'completed'
      ? theme.fg('success', '✓')
      : task.status === 'in_progress'
        ? theme.fg('accent', '●')
        : task.status === 'wont_fix'
          ? theme.fg('error', '✗')
          : theme.fg('dim', '○');
  const pColor = priorityColor(task.priority);
  const pLabel = theme.fg(pColor, priorityLabel(task.priority));
  const subtaskIndent = includeSubtaskIndent && task.parentId ? '  ' : '';
  const content =
    task.status === 'completed'
      ? theme.fg('dim', theme.strikethrough(task.content))
      : task.status === 'in_progress'
        ? theme.fg('text', theme.bold(task.content))
        : task.status === 'wont_fix'
          ? theme.fg('error', task.content)
          : theme.fg('muted', task.content);
  return `${subtaskIndent}${icon} ${pLabel}  ${content}`;
}

// ── Tool result rendering ─────────────────────────────────────────────────────

export function renderTaskListResult(
  tasks: Task[],
  expanded: boolean,
  theme: any,
  epics?: Epic[],
): any {
  if (!tasks?.length) return new Text(theme.fg('dim', 'No tasks found'), 0, 0);

  const doneCount = tasks.filter((t) => t.status === 'completed').length;
  const inProgCount = tasks.filter((t) => t.status === 'in_progress').length;
  const wontFixCount = tasks.filter((t) => t.status === 'wont_fix').length;
  const total = tasks.length;

  const parts: string[] = [];
  if (inProgCount > 0) parts.push(theme.fg('accent', `● ${inProgCount} active`));
  if (wontFixCount > 0) parts.push(theme.fg('error', `✗ ${wontFixCount} wont_fix`));
  parts.push(theme.fg('success', `✓ ${doneCount}/${total} done`));
  let output = parts.join('  ');

  // ── Epic-grouped rendering ────────────────────────────────────────────────
  if (epics?.length) {
    // Group tasks by epicId
    const tasksByEpic = new Map<string, Task[]>();
    const noEpicTasks: Task[] = [];
    for (const t of tasks) {
      if (t.epicId) {
        const group = tasksByEpic.get(t.epicId) ?? [];
        group.push(t);
        tasksByEpic.set(t.epicId, group);
      } else {
        noEpicTasks.push(t);
      }
    }

    // Build ordered epic list: active/in-progress epics first, then todo, then completed, then unassigned
    const epicOrder: Epic[] = [...epics].sort((a, b) => {
      const statusOrder: Record<string, number> = {
        in_progress: 0,
        todo: 1,
        completed: 2,
        wont_fix: 3,
        archived: 4,
      };
      return (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
    });

    const displayLimit = expanded ? Infinity : 5;
    let shown = 0;

    // Render epic groups
    for (const epic of epicOrder) {
      const epicTasks = tasksByEpic.get(epic.id);
      if (!epicTasks?.length) continue;

      if (shown >= displayLimit) break;

      const epicIcon =
        epic.status === 'completed'
          ? theme.fg('success', '✓')
          : epic.status === 'in_progress'
            ? theme.fg('accent', '●')
            : theme.fg('dim', '○');
      const epicTaskCount = theme.fg('dim', `(${epicTasks.length})`);
      output += `\n${epicIcon} ${theme.bold(theme.fg('accent', epic.title))} ${epicTaskCount}`;

      const epicDisplay = expanded ? epicTasks : epicTasks.slice(0, displayLimit - shown);
      for (const t of epicDisplay) {
        if (shown >= displayLimit) break;
        output += `\n${renderTaskLine(t, theme)}`;
        shown++;
      }
    }

    // Render unassigned tasks
    if (noEpicTasks.length > 0) {
      if (shown < displayLimit) {
        const unassignedHeader = theme.fg('muted', 'Unassigned');
        const unassignedCount = theme.fg('dim', `(${noEpicTasks.length})`);
        output += `\n${unassignedHeader} ${unassignedCount}`;

        const unassignedDisplay = expanded
          ? noEpicTasks
          : noEpicTasks.slice(0, displayLimit - shown);
        for (const t of unassignedDisplay) {
          if (shown >= displayLimit) break;
          output += `\n${renderTaskLine(t, theme)}`;
          shown++;
        }
      }
    }

    if (!expanded && shown < total) {
      output += `\n${theme.fg('dim', `... ${total - shown} more`)}`;
    }

    return new Text(output, 0, 0);
  }

  // ── Legacy flat rendering (no epics) ─────────────────────────────────────
  const display = expanded ? tasks : tasks.slice(0, 5);
  for (const t of display) {
    output += `\n${renderTaskLine(t, theme)}`;
  }

  if (!expanded && tasks.length > 5) {
    output += `\n${theme.fg('dim', `... ${tasks.length - 5} more`)}`;
  }

  return new Text(output, 0, 0);
}
