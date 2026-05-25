/**
 * TrekkerStore — in-memory cache backed by the trekker CLI.
 *
 * Provides a synchronous `list()` / `get()` interface for the widget and
 * auto-clear manager while async CLI calls update the cache. Visual-only
 * "deletion" (auto-clear) hides tasks from the widget without touching
 * the trekker database.
 */

import {
  listTasks,
  getTask as cliGetTask,
  createTask as cliCreateTask,
  updateTask as cliUpdateTask,
  addComment as cliAddComment,
  listComments as cliListComments,
  deleteTask as cliDeleteTask,
  listSubtasks as cliListSubtasks,
  searchTrekker,
  createEpic as cliCreateEpic,
  listEpics as cliListEpics,
  updateEpic as cliUpdateEpic,
  trekkerCmd,
  type Task as CliTask,
  type Epic as CliEpic,
  type Comment as CliComment,
  type CreateTaskOpts,
  type UpdateTaskOpts,
  type CreateEpicOpts,
  type UpdateEpicOpts,
  type SearchResult,
} from './cli.js';
import {
  mapStatus,
  mapPriority,
  unmapStatus,
  unmapPriority,
  mapEpicStatus,
  unmapEpicStatus,
  type Task,
  type Epic,
  type TaskPriority,
  type TaskStatus,
  type EpicStatus,
} from './types.js';

// ── Conversion helpers ─────────────────────────────────────────────────────────

function fromCliEpic(e: CliEpic): Epic {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? undefined,
    status: mapEpicStatus(e.status as any),
    priority: mapPriority(e.priority),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function fromCliTask(t: CliTask): Task {
  return {
    id: t.id,
    content: t.title,
    description: t.description ?? undefined,
    status: mapStatus(t.status),
    priority: mapPriority(t.priority),
    parentId: t.parentTaskId ?? undefined,
    epicId: t.epicId ?? undefined,
    tags: t.tags ?? undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function fromCliComment(c: CliComment): {
  id: string;
  taskId: string;
  author: string;
  content: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: c.id,
    taskId: c.taskId,
    author: c.author,
    content: c.content,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── TrekkerStore ───────────────────────────────────────────────────────────────

export class TrekkerStore {
  /** Cached task list from last refresh. */
  private cache: Task[] = [];
  /** IDs hidden from widget display (auto-clear, visual only). */
  private hiddenIds = new Set<string>();

  /** Refresh cache from trekker CLI. Returns the updated list. */
  async refresh(): Promise<Task[]> {
    try {
      const tasks = await listTasks();
      this.cache = tasks.map(fromCliTask);
    } catch {
      // Leave stale cache on error — widget keeps showing last known state
    }
    return this.cache;
  }

  // ── Synchronous interface (used by widget, auto-clear, prompt) ─────────────

  /** All non-hidden tasks (for widget and prompt). */
  list(): Task[] {
    return this.cache.filter((t) => !this.hiddenIds.has(t.id));
  }

  /** Get a task by ID (returns even if hidden, for auto-clear checks). */
  get(id: string): Task | undefined {
    return this.cache.find((t) => t.id === id);
  }

  /** Active tasks: in_progress or pending, not hidden. */
  activeTasks(): Task[] {
    return this.list().filter((t) => t.status === 'in_progress' || t.status === 'pending');
  }

  /** Visual-only delete: hides a task from the widget. Does NOT modify trekker DB. */
  hide(id: string): void {
    this.hiddenIds.add(id);
  }

  /** Visual-only clear: hides all completed tasks from the widget. */
  clearCompleted(): void {
    for (const t of this.cache) {
      if (t.status === 'completed') this.hiddenIds.add(t.id);
    }
  }

  /** Reset visual-only state (call on session start). */
  resetHidden(): void {
    this.hiddenIds.clear();
  }

  // ── Async mutations (call trekker CLI, then refresh) ──────────────────────

  async create(opts: {
    content: string;
    description?: string;
    priority?: TaskPriority;
    tags?: string;
    parentId?: string;
    epicId?: string;
  }): Promise<Task> {
    const cliOpts: CreateTaskOpts = {
      title: opts.content,
      description: opts.description,
      priority: opts.priority ? unmapPriority(opts.priority) : undefined,
      tags: opts.tags,
      epicId: opts.epicId,
      parentId: opts.parentId,
    };
    const created = await cliCreateTask(cliOpts);
    await this.refresh();
    return fromCliTask(created);
  }

  async update(
    id: string,
    opts: {
      content?: string;
      description?: string;
      priority?: TaskPriority;
      status?: TaskStatus;
      tags?: string;
    },
  ): Promise<Task> {
    const cliOpts: UpdateTaskOpts = {
      title: opts.content,
      description: opts.description,
      priority: opts.priority ? unmapPriority(opts.priority) : undefined,
      status: opts.status ? unmapStatus(opts.status) : undefined,
      tags: opts.tags,
    };
    const updated = await cliUpdateTask(id, cliOpts);
    await this.refresh();
    return fromCliTask(updated);
  }

  async comment(id: string, content: string): Promise<void> {
    await cliAddComment(id, content, 'agent');
    // No need to refresh — comments don't change task display
  }

  async listComments(taskId: string): Promise<
    {
      id: string;
      taskId: string;
      author: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }[]
  > {
    return (await cliListComments(taskId)).map(fromCliComment);
  }

  async deleteTask(id: string): Promise<Task> {
    const deleted = await cliDeleteTask(id);
    await this.refresh();
    return fromCliTask(deleted);
  }

  async search(query: string): Promise<SearchResult[]> {
    return searchTrekker(query);
  }

  async getFromCli(id: string): Promise<Task> {
    const t = await cliGetTask(id);
    return fromCliTask(t);
  }

  async listSubtasks(parentTaskId: string): Promise<Task[]> {
    return (await cliListSubtasks(parentTaskId)).map(fromCliTask);
  }

  // ── Epic operations ──────────────────────────────────────────────────────────

  async createEpic(opts: {
    title: string;
    description?: string;
    priority?: TaskPriority;
  }): Promise<Epic> {
    const cliOpts: CreateEpicOpts = {
      title: opts.title,
      description: opts.description,
      priority: opts.priority ? unmapPriority(opts.priority) : undefined,
    };
    const created = await cliCreateEpic(cliOpts);
    return fromCliEpic(created);
  }

  async listEpics(status?: EpicStatus): Promise<Epic[]> {
    const cliStatus = status ? unmapEpicStatus(status) : undefined;
    const epics = await cliListEpics(cliStatus ? { status: cliStatus } : undefined);
    return epics.map(fromCliEpic);
  }

  async updateEpic(
    id: string,
    opts: {
      title?: string;
      description?: string;
      priority?: TaskPriority;
      status?: EpicStatus;
    },
  ): Promise<Epic> {
    const cliOpts: UpdateEpicOpts = {
      title: opts.title,
      description: opts.description,
      priority: opts.priority ? unmapPriority(opts.priority) : undefined,
      status: opts.status ? unmapEpicStatus(opts.status) : undefined,
    };
    const updated = await cliUpdateEpic(id, cliOpts);
    return fromCliEpic(updated);
  }

  // ── Dependency operations ────────────────────────────────────────────────────

  async addDep(taskId: string, dependsOnId: string): Promise<void> {
    await trekkerCmd('dep', 'add', taskId, dependsOnId);
  }

  async removeDep(taskId: string, dependsOnId: string): Promise<void> {
    await trekkerCmd('dep', 'remove', taskId, dependsOnId);
  }
}
