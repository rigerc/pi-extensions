/**
 * Trekker CLI Wrapper
 *
 * Shells out to `trekker` with `--toon`, parses the structured text output.
 * All other modules import from here exclusively — no direct trekker calls.
 *
 * The --toon format has three shapes:
 *   1. Single entity: flat `key: value` pairs
 *   2. List: total/page/limit + `items[N]{fields}:` + indented CSV rows
 *   3. Search: like list but with `results[N]{fields}:` header
 *   4. Error: `success: false`, `error: message`, `details: null`
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  projectId?: string;
  epicId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  priority: number;
  status: 'todo' | 'in_progress' | 'completed' | 'wont_fix' | 'archived';
  tags: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Epic {
  id: string;
  projectId?: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'completed' | 'archived';
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface Dependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface SearchResult {
  type: 'epic' | 'task' | 'subtask' | 'comment';
  id: string;
  title: string | null;
  snippet: string;
  score: number;
  status: string;
  parentId: string | null;
}

export type EntityType = 'epic' | 'task' | 'subtask' | 'comment';

export interface TaskFilters {
  status?: string;
  epic?: string;
  limit?: number;
  page?: number;
}

export interface EpicFilters {
  status?: string;
  limit?: number;
  page?: number;
}

export interface CreateTaskOpts {
  title: string;
  description?: string;
  priority?: number;
  tags?: string;
  epicId?: string;
  parentId?: string;
}

export interface UpdateTaskOpts {
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
  tags?: string;
  epicId?: string;
  removeEpic?: boolean;
}

export interface CreateEpicOpts {
  title: string;
  description?: string;
  priority?: number;
}

export interface UpdateEpicOpts {
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
}

export interface HistoryFilters {
  limit?: number;
  entity?: string;
  type?: string;
  action?: string;
  since?: string;
}

// ---------------------------------------------------------------------------
// TOON Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single `key: value` line. Returns [key, value] or null.
 * Values can be plain text, "quoted strings", or the literal `null`.
 */
function parseKeyValue(line: string): [string, string | null] | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const key = line.slice(0, colonIdx).trim();
  const raw = line.slice(colonIdx + 1).trim();
  if (raw === 'null') return [key, null];
  if (raw.startsWith('"') && raw.endsWith('"')) return [key, raw.slice(1, -1)];
  if (raw.startsWith('"')) {
    // Handle values that span lines (unlikely in TOON but be safe)
    return [key, raw.slice(1)];
  }
  return [key, raw];
}

/**
 * Parse a table header like `items[3]{id,title}:` or `results[1]{type,id,...}:`.
 * Returns { name, fields } or null.
 */
function parseTableHeader(line: string): { name: string; count: number; fields: string[] } | null {
  const match = line.match(/^(\w+)\[(\d+)\]\{(.+?)\}:$/);
  if (!match) return null;
  return {
    name: match[1],
    count: parseInt(match[2], 10),
    fields: match[3].split(',').map((f) => f.trim()),
  };
}

/**
 * Parse a CSV row with double-quote escaping into a record keyed by `fields`.
 */
function parseCsvRow(line: string, fields: string[]): Record<string, string | null> {
  const values: (string | null)[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim() === '' ? null : current.trim());
      current = '';
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  values.push(current.trim() === '' ? null : current.trim());

  const record: Record<string, string | null> = {};
  for (let j = 0; j < fields.length; j++) {
    record[fields[j]] = values[j] ?? null;
  }
  return record;
}

interface ToonOutput {
  /** Parsed key-value pairs from the flat section. */
  fields: Record<string, string | null>;
  /** Table rows (items, results), if any. */
  rows?: Record<string, string | null>[];
  /** Whether the output indicates an error. */
  isError: boolean;
  /** Error message if isError. */
  error?: string;
}

/**
 * Parse full TOON text output into a structured result.
 */
function parseToonOutput(stdout: string): ToonOutput {
  const lines = stdout.split('\n');
  const fields: Record<string, string | null> = {};
  let rows: Record<string, string | null>[] | undefined;
  let inTable = false;
  let tableFields: string[] | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    // Check for error pattern
    if (line.startsWith('success: false')) {
      // The next key-value should be `error:` — handled below
      continue;
    }

    // Check for table header
    const tableHeader = parseTableHeader(line);
    if (tableHeader) {
      inTable = true;
      tableFields = tableHeader.fields;
      rows = [];
      continue;
    }

    // Check for indented CSV row within a table
    if (inTable && tableFields && (line.startsWith('  ') || rawLine.startsWith('  '))) {
      const trimmed = line.trim();
      if (trimmed) {
        const row = parseCsvRow(trimmed, tableFields);
        if (rows) rows.push(row);
      }
      continue;
    }

    // Outside table context — parse as key-value pair
    inTable = false;
    const kv = parseKeyValue(line);
    if (kv) {
      fields[kv[0]] = kv[1];
    }
  }

  const isError = fields['success'] === 'false' || !!fields['error'];

  return {
    fields,
    rows,
    isError,
    error: fields['error'] ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Serialization: async mutex + retry for SQLite lock errors
// ---------------------------------------------------------------------------

/**
 * Lightweight async mutex that serializes concurrent calls.
 * Ensures only one trekker CLI invocation runs at a time, preventing
 * SQLITE_BUSY / "database is locked" errors from concurrent access.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    // Always resolve the queue so subsequent callers aren't blocked by rejections
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

const mutex = new AsyncMutex();

/**
 * Detect SQLite lock errors in a thrown error or captured stderr.
 */
function isSqliteLockError(err: unknown, stderr?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const combined = `${message}\n${stderr ?? ''}`.toLowerCase();
  return (
    combined.includes('database is locked') ||
    combined.includes('sqlite_busy') ||
    (combined.includes('sql logic error') && combined.includes('locked'))
  );
}

/** Sleep helper for backoff delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;

/**
 * Retry an async function with exponential backoff on SQLite lock errors.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteLockError(err)) throw err;
      if (attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------

/**
 * Run `trekker` with the given arguments and `--toon`, return parsed output.
 * Serialized via async mutex to prevent concurrent SQLite access.
 * Retries on SQLITE_BUSY / "database is locked" with exponential backoff.
 * Throws if the binary is not available or returns an error.
 */
async function trekkerCmdRaw(...args: string[]): Promise<ToonOutput> {
  const allArgs = [...args, '--toon'];
  return mutex.acquire(async () => {
    return retryWithBackoff(() => {
      return new Promise<ToonOutput>((resolve, reject) => {
        execFile(
          'trekker',
          allArgs,
          {
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (stdout) {
              const parsed = parseToonOutput(stdout);
              if (parsed.isError) {
                reject(new Error(parsed.error ?? 'Trekker returned an error'));
              } else {
                resolve(parsed);
              }
            } else if (err) {
              const msg = stderr?.trim() || err.message;
              reject(new Error(`trekker failed: ${msg}`));
            } else {
              reject(new Error('trekker returned empty output'));
            }
          },
        );
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Type coercion helpers
// ---------------------------------------------------------------------------

function toTask(fields: Record<string, string | null>): Task {
  return {
    id: fields['id'] ?? '',
    projectId: fields['projectId'] ?? undefined,
    epicId: fields['epicId'] ?? null,
    parentTaskId: fields['parentTaskId'] ?? null,
    title: fields['title'] ?? '',
    description: fields['description'] ?? null,
    priority: fields['priority'] ? parseInt(fields['priority'], 10) : 2,
    status: (fields['status'] as Task['status']) ?? 'todo',
    tags: fields['tags'] ?? null,
    createdAt: fields['createdAt'] ?? '',
    updatedAt: fields['updatedAt'] ?? '',
  };
}

function toEpic(fields: Record<string, string | null>): Epic {
  return {
    id: fields['id'] ?? '',
    projectId: fields['projectId'] ?? undefined,
    title: fields['title'] ?? '',
    description: fields['description'] ?? null,
    status: (fields['status'] as Epic['status']) ?? 'todo',
    priority: fields['priority'] ? parseInt(fields['priority'], 10) : 2,
    createdAt: fields['createdAt'] ?? '',
    updatedAt: fields['updatedAt'] ?? '',
  };
}

function toComment(fields: Record<string, string | null>): Comment {
  return {
    id: fields['id'] ?? '',
    taskId: fields['taskId'] ?? '',
    author: fields['author'] ?? '',
    content: fields['content'] ?? '',
    createdAt: fields['createdAt'] ?? '',
    updatedAt: fields['updatedAt'] ?? '',
  };
}

function toSearchResult(fields: Record<string, string | null>): SearchResult {
  return {
    type: (fields['type'] as SearchResult['type']) ?? 'task',
    id: fields['id'] ?? '',
    title: fields['title'] ?? null,
    snippet: fields['snippet'] ?? '',
    score: fields['score'] ? parseFloat(fields['score']) : 0,
    status: fields['status'] ?? '',
    parentId: fields['parentId'] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a raw trekker command. For internal use or ad-hoc operations.
 */
export async function trekkerCmd(...args: string[]): Promise<ToonOutput> {
  return trekkerCmdRaw(...args);
}

export async function trekkerText(...args: string[]): Promise<string> {
  const allArgs = [...args, '--toon'];
  return mutex.acquire(async () => {
    return retryWithBackoff(() => {
      return new Promise<string>((resolve, reject) => {
        execFile(
          'trekker',
          allArgs,
          {
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) {
              const msg = stderr?.trim() || err.message;
              reject(new Error(`trekker failed: ${msg}`));
              return;
            }
            resolve(stdout.trim());
          },
        );
      });
    });
  });
}

// ---- Tasks ----

export async function listTasks(filters?: TaskFilters): Promise<Task[]> {
  const args: string[] = ['task', 'list'];
  if (filters?.status) args.push('-s', filters.status);
  if (filters?.epic) args.push('-e', filters.epic);
  if (filters?.limit !== undefined) args.push('--limit', String(filters.limit));
  if (filters?.page !== undefined) args.push('--page', String(filters.page));
  const out = await trekkerCmdRaw(...args);
  return (out.rows ?? []).map(toTask);
}

export async function getTask(id: string): Promise<Task> {
  const out = await trekkerCmdRaw('task', 'show', id);
  return toTask(out.fields);
}

export async function createTask(opts: CreateTaskOpts): Promise<Task> {
  const args: string[] = ['task', 'create', '-t', opts.title];
  if (opts.description) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  if (opts.tags) args.push('--tags', opts.tags);
  if (opts.epicId) args.push('-e', opts.epicId);
  if (opts.parentId) {
    return createSubtask(opts.parentId, {
      title: opts.title,
      description: opts.description,
      priority: opts.priority,
    });
  }
  const out = await trekkerCmdRaw(...args);
  return toTask(out.fields);
}

async function createSubtask(
  parentId: string,
  opts: { title: string; description?: string; priority?: number },
): Promise<Task> {
  const args: string[] = ['subtask', 'create', parentId, '-t', opts.title];
  if (opts.description) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  const out = await trekkerCmdRaw(...args);
  return toTask(out.fields);
}

export async function updateTask(id: string, opts: UpdateTaskOpts): Promise<Task> {
  const args: string[] = ['task', 'update', id];
  if (opts.title) args.push('-t', opts.title);
  if (opts.description !== undefined) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  if (opts.status) args.push('-s', opts.status);
  if (opts.tags !== undefined) args.push('--tags', opts.tags);
  if (opts.epicId) args.push('-e', opts.epicId);
  if (opts.removeEpic) args.push('--no-epic');
  const out = await trekkerCmdRaw(...args);
  return toTask(out.fields);
}

export async function addComment(
  taskId: string,
  content: string,
  author?: string,
): Promise<Comment> {
  const args: string[] = ['comment', 'add', taskId, '-c', content];
  if (author) args.push('-a', author);
  const out = await trekkerCmdRaw(...args);
  return toComment(out.fields);
}

export async function listComments(taskId: string): Promise<Comment[]> {
  const out = await trekkerCmdRaw('comment', 'list', taskId);
  return (out.rows ?? []).map(toComment);
}

export async function updateComment(commentId: string, content: string): Promise<Comment> {
  const out = await trekkerCmdRaw('comment', 'update', commentId, '-c', content);
  return toComment(out.fields);
}

export async function deleteComment(commentId: string): Promise<Comment> {
  const out = await trekkerCmdRaw('comment', 'delete', commentId);
  return toComment(out.fields);
}

// ---- Epics ----

export async function createEpic(opts: CreateEpicOpts): Promise<Epic> {
  const args: string[] = ['epic', 'create', '-t', opts.title];
  if (opts.description) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  const out = await trekkerCmdRaw(...args);
  return toEpic(out.fields);
}

export async function listEpics(filters?: EpicFilters): Promise<Epic[]> {
  const args: string[] = ['epic', 'list'];
  if (filters?.status) args.push('-s', filters.status);
  if (filters?.limit !== undefined) args.push('--limit', String(filters.limit));
  if (filters?.page !== undefined) args.push('--page', String(filters.page));
  const out = await trekkerCmdRaw(...args);
  return (out.rows ?? []).map(toEpic);
}

export async function getEpic(id: string): Promise<Epic> {
  const out = await trekkerCmdRaw('epic', 'show', id);
  return toEpic(out.fields);
}

export async function updateEpic(id: string, opts: UpdateEpicOpts): Promise<Epic> {
  const args: string[] = ['epic', 'update', id];
  if (opts.title) args.push('-t', opts.title);
  if (opts.description !== undefined) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  if (opts.status) args.push('-s', opts.status);
  const out = await trekkerCmdRaw(...args);
  return toEpic(out.fields);
}

export async function deleteEpic(id: string): Promise<Epic> {
  const out = await trekkerCmdRaw('epic', 'delete', id);
  return toEpic(out.fields);
}

// ---- Utilities ----

export async function searchTrekker(
  query: string,
  type?: EntityType | EntityType[],
): Promise<SearchResult[]> {
  const args: string[] = ['search', query];
  if (type) {
    const types = Array.isArray(type) ? type.join(',') : type;
    args.push('--type', types);
  }
  const out = await trekkerCmdRaw(...args);
  return (out.rows ?? []).map(toSearchResult);
}

export async function readyTasks(): Promise<Task[]> {
  const out = await trekkerCmdRaw('ready');
  return (out.rows ?? []).map(toTask);
}

/**
 * List subtasks for a given parent task.
 */
export async function listSubtasks(parentTaskId: string): Promise<Task[]> {
  const out = await trekkerCmdRaw('subtask', 'list', parentTaskId);
  return (out.rows ?? []).map(toTask);
}

export async function updateSubtask(id: string, opts: UpdateTaskOpts): Promise<Task> {
  const args: string[] = ['subtask', 'update', id];
  if (opts.title) args.push('-t', opts.title);
  if (opts.description !== undefined) args.push('-d', opts.description);
  if (opts.priority !== undefined) args.push('-p', String(opts.priority));
  if (opts.status) args.push('-s', opts.status);
  const out = await trekkerCmdRaw(...args);
  return toTask(out.fields);
}

export async function deleteSubtask(id: string): Promise<Task> {
  const out = await trekkerCmdRaw('subtask', 'delete', id);
  return toTask(out.fields);
}

/**
 * Delete (archive) a task.
 */
export async function deleteTask(id: string): Promise<Task> {
  const out = await trekkerCmdRaw('task', 'delete', id);
  return toTask(out.fields);
}

export async function history(filters?: HistoryFilters): Promise<string> {
  const args: string[] = ['history'];
  if (filters?.limit !== undefined) args.push('--limit', String(filters.limit));
  if (filters?.entity) args.push('--entity', filters.entity);
  if (filters?.type) args.push('--type', filters.type);
  if (filters?.action) args.push('--action', filters.action);
  if (filters?.since) args.push('--since', filters.since);
  return trekkerText(...args);
}

export async function quickstart(): Promise<string> {
  return trekkerText('quickstart');
}

export async function initTrekker(): Promise<string> {
  return trekkerText('init');
}

// ---- Initialization check ----

let _checked = false;
let _available = false;

/**
 * Check if the `trekker` CLI is available and the project has a `.trekker/` dir.
 * Call once at session start. Subsequent calls return cached result.
 */
export function checkTrekkerAvailable(cwd: string): boolean {
  if (_checked) return _available;

  try {
    execFileSync('trekker', ['--version'], { stdio: 'ignore' });
  } catch {
    _checked = true;
    _available = false;
    return false;
  }

  // Check for .trekker/ dir by walking up from cwd
  let dir = cwd;
  let found = false;
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, '.trekker'))) {
      found = true;
      break;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  _checked = true;
  _available = found;
  return _available;
}

/**
 * Reset the cached availability check (for testing / reload).
 */
export function resetAvailabilityCheck(): void {
  _checked = false;
  _available = false;
}

/**
 * Clear the cached availability check (next call re-checks).
 */
export function clearAvailabilityCache(): void {
  _checked = false;
}
