/**
 * interceptor.ts — Bash trekker command interception and Pi tool dispatch.
 *
 * When the agent runs raw `trekker` CLI commands through bash, we intercept
 * them and route through the Pi tool implementations instead. This keeps the
 * widget, turn-counter, and reminder system accurate regardless of whether the
 * agent uses Pi tools or bash directly.
 *
 * Decision logic:
 *   - ALL parts are trekker → block bash, execute via Pi tools, return result
 *   - MIXED (trekker + other) → let bash run, mark trekker-used for tracking
 *   - None are trekker → ignore
 */

import type { TrekkerStore } from './trekker-store.js';
import type { TaskPriority, TaskStatus, EpicStatus } from './types.js';

// ── Parsed tool call discriminated union ──────────────────────────────────────

export type ParsedToolCall =
  | {
      tool: 'TaskCreate';
      args: {
        content: string;
        description?: string;
        priority?: TaskPriority;
        tags?: string;
        parentId?: string;
        epicId?: string;
      };
    }
  | { tool: 'TaskList'; args: { status?: TaskStatus; epicId?: string } }
  | { tool: 'TaskGet'; args: { id: string } }
  | {
      tool: 'TaskUpdate';
      args: {
        id: string;
        status?: TaskStatus;
        content?: string;
        description?: string;
        priority?: TaskPriority;
        tags?: string;
      };
    }
  | { tool: 'TaskDelete'; args: { id: string } }
  | { tool: 'TaskComment'; args: { id: string; content: string } }
  | { tool: 'TaskSearch'; args: { query: string } }
  | { tool: 'TaskReady'; args: {} }
  | { tool: 'TaskHistory'; args: { entity?: string; limit?: number } }
  | { tool: 'EpicCreate'; args: { title: string; description?: string; priority?: TaskPriority } }
  | { tool: 'EpicList'; args: { status?: EpicStatus } }
  | { tool: 'EpicGet'; args: { id: string } }
  | {
      tool: 'EpicUpdate';
      args: {
        id: string;
        title?: string;
        description?: string;
        priority?: TaskPriority;
        status?: EpicStatus;
      };
    }
  | { tool: 'DepAdd'; args: { taskId: string; dependsOnId: string } }
  | { tool: 'DepRemove'; args: { taskId: string; dependsOnId: string } }
  | { tool: 'DepList'; args: { taskId: string } };

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/** Split a shell command string into tokens, respecting single and double quotes. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Parse flag/positional args from a token list. */
function parseArgs(tokens: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.startsWith('-')) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) {
        flags[tok] = next;
        i += 2;
      } else {
        flags[tok] = 'true';
        i++;
      }
    } else {
      positional.push(tok);
      i++;
    }
  }
  return { flags, positional };
}

/** Map CLI priority int to TaskPriority. */
function toPriority(raw: string | undefined): TaskPriority | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (n <= 1) return 'high';
  if (n <= 3) return 'medium';
  return 'low';
}

/** Map CLI epic status string to EpicStatus. */
function toEpicStatus(raw: string | undefined): EpicStatus | undefined {
  if (!raw) return undefined;
  if (raw === 'todo' || raw === 'in_progress' || raw === 'completed' || raw === 'archived') {
    return raw;
  }
  return undefined;
}

/** Map CLI status string to TaskStatus. */
function toStatus(raw: string | undefined): TaskStatus | undefined {
  if (!raw) return undefined;
  if (
    raw === 'todo' ||
    raw === 'in_progress' ||
    raw === 'completed' ||
    raw === 'wont_fix' ||
    raw === 'archived'
  ) {
    return raw;
  }
  return undefined;
}

// ── Split command on && and ; (respecting quotes) ────────────────────────────

export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === '&' && cmd[i + 1] === '&') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++; // skip second &
        continue;
      }
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ── Single-command parser ─────────────────────────────────────────────────────

/** Parse one trekker subcommand into a typed ParsedToolCall. Returns null if unrecognized. */
export function parseSingleTrekkerCommand(part: string): ParsedToolCall | null {
  const tokens = tokenize(part.trim());
  if (tokens.length === 0 || tokens[0] !== 'trekker') return null;

  // Drop --toon flag if present
  const sub = tokens.slice(1).filter((t) => t !== '--toon');
  const [entity, action] = sub;

  if (!entity) return null;

  // ── trekker list ──────────────────────────────────────────────────────────
  if (entity === 'list') {
    const { flags } = parseArgs(sub.slice(1));
    return { tool: 'TaskList', args: { status: toStatus(flags['--status'] ?? flags['-s']) } };
  }

  // ── trekker ready ─────────────────────────────────────────────────────────
  if (entity === 'ready') {
    return { tool: 'TaskReady', args: {} };
  }

  // ── trekker history ───────────────────────────────────────────────────────
  if (entity === 'history') {
    const { flags } = parseArgs(sub.slice(1));
    const rawLimit = flags['--limit'];
    const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
    return { tool: 'TaskHistory', args: { entity: flags['--entity'], limit } };
  }

  // ── trekker search <query> ────────────────────────────────────────────────
  if (entity === 'search') {
    if (!action) return null;
    return { tool: 'TaskSearch', args: { query: action } };
  }

  // ── trekker task ... ──────────────────────────────────────────────────────
  if (entity === 'task') {
    const rest = sub.slice(2);

    if (action === 'create') {
      const { flags } = parseArgs(rest);
      const content = flags['-t'];
      if (!content) return null;
      return {
        tool: 'TaskCreate',
        args: {
          content,
          description: flags['-d'],
          priority: toPriority(flags['-p']),
          tags: flags['--tags'],
          epicId: flags['-e'],
        },
      };
    }

    if (action === 'update') {
      const [id, ...flagTokens] = rest;
      if (!id) return null;
      const { flags } = parseArgs(flagTokens);
      return {
        tool: 'TaskUpdate',
        args: {
          id,
          content: flags['-t'],
          description: flags['-d'],
          priority: toPriority(flags['-p']),
          status: toStatus(flags['-s']),
          tags: flags['--tags'],
        },
      };
    }

    if (action === 'show' || action === 'get') {
      const id = rest[0];
      if (!id) return null;
      return { tool: 'TaskGet', args: { id } };
    }

    if (action === 'list') {
      const { flags } = parseArgs(rest);
      return {
        tool: 'TaskList',
        args: {
          status: toStatus(flags['-s'] ?? flags['--status']),
          epicId: flags['-e'] ?? flags['--epic'],
        },
      };
    }

    if (action === 'delete') {
      const id = rest[0];
      if (!id) return null;
      return { tool: 'TaskDelete', args: { id } };
    }
  }

  // ── trekker subtask ... ───────────────────────────────────────────────────
  if (entity === 'subtask') {
    const rest = sub.slice(2);

    if (action === 'create') {
      const [parentId, ...flagTokens] = rest;
      if (!parentId) return null;
      const { flags } = parseArgs(flagTokens);
      const content = flags['-t'];
      if (!content) return null;
      return {
        tool: 'TaskCreate',
        args: {
          content,
          description: flags['-d'],
          priority: toPriority(flags['-p']),
          parentId,
        },
      };
    }

    if (action === 'update') {
      const [id, ...flagTokens] = rest;
      if (!id) return null;
      const { flags } = parseArgs(flagTokens);
      return {
        tool: 'TaskUpdate',
        args: {
          id,
          content: flags['-t'],
          description: flags['-d'],
          priority: toPriority(flags['-p']),
          status: toStatus(flags['-s']),
        },
      };
    }

    if (action === 'show') {
      const id = rest[0];
      if (!id) return null;
      return { tool: 'TaskGet', args: { id } };
    }
  }

  // ── trekker comment ... ───────────────────────────────────────────────────
  if (entity === 'comment' && action === 'add') {
    const rest = sub.slice(2);
    const [id, ...flagTokens] = rest;
    if (!id) return null;
    const { flags } = parseArgs(flagTokens);
    const content = flags['-c'];
    if (!content) return null;
    return { tool: 'TaskComment', args: { id, content } };
  }

  // ── trekker epic ... ──────────────────────────────────────────────────────
  if (entity === 'epic') {
    const rest = sub.slice(2);

    if (action === 'create') {
      const { flags } = parseArgs(rest);
      const title = flags['-t'];
      if (!title) return null;
      return {
        tool: 'EpicCreate',
        args: { title, description: flags['-d'], priority: toPriority(flags['-p']) },
      };
    }

    if (action === 'list') {
      const { flags } = parseArgs(rest);
      const rawStatus = flags['-s'] ?? flags['--status'];
      return { tool: 'EpicList', args: { status: toEpicStatus(rawStatus) } };
    }

    if (action === 'update') {
      const [id, ...flagTokens] = rest;
      if (!id) return null;
      const { flags } = parseArgs(flagTokens);
      return {
        tool: 'EpicUpdate',
        args: {
          id,
          title: flags['-t'],
          description: flags['-d'],
          priority: toPriority(flags['-p']),
          status: toEpicStatus(flags['-s']),
        },
      };
    }

    if (action === 'show' || action === 'get') {
      const id = rest[0];
      if (!id) return null;
      return { tool: 'EpicGet', args: { id } };
    }
  }

  // ── trekker dep ... ───────────────────────────────────────────────────────
  if (entity === 'dep') {
    const rest = sub.slice(2);
    const [taskId, dependsOnId] = rest;
    if (!taskId) return null;

    if (action === 'add' && dependsOnId) return { tool: 'DepAdd', args: { taskId, dependsOnId } };
    if (action === 'remove' && dependsOnId)
      return { tool: 'DepRemove', args: { taskId, dependsOnId } };
    if (action === 'list') return { tool: 'DepList', args: { taskId } };
  }

  return null;
}

// ── Classification result ─────────────────────────────────────────────────────

export type InterceptResult =
  | { action: 'block'; calls: ParsedToolCall[]; raw: string }
  | { action: 'track' } // mixed command, let bash run but count as trekker use
  | { action: 'ignore' };

/**
 * Classify a bash command string.
 *
 * - "block": ALL parts are trekker → caller should block bash and dispatch
 * - "track": MIXED parts → let bash run but mark trekker-used
 * - "ignore": no trekker → pass through silently
 */
export function classifyCommand(cmd: string): InterceptResult {
  const parts = splitCommand(cmd);
  if (parts.length === 0) return { action: 'ignore' };

  const isTrekker = (p: string) => /\btrekker\b/.test(p);
  const hasTrekker = parts.some(isTrekker);
  if (!hasTrekker) return { action: 'ignore' };

  const allTrekker = parts.every(isTrekker);
  if (!allTrekker) return { action: 'track' };

  // Attempt to parse each part into a tool call
  const calls: ParsedToolCall[] = [];
  for (const part of parts) {
    const parsed = parseSingleTrekkerCommand(part);
    if (!parsed) {
      // Unrecognized trekker subcommand — fall back to track (let bash run it)
      return { action: 'track' };
    }
    calls.push(parsed);
  }

  return { action: 'block', calls, raw: cmd };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/** Execute a parsed tool call against the store, return a human-readable result. */
export async function dispatchToolCall(store: TrekkerStore, call: ParsedToolCall): Promise<string> {
  switch (call.tool) {
    case 'TaskCreate': {
      const task = await store.create({
        content: call.args.content,
        description: call.args.description,
        priority: call.args.priority,
        tags: call.args.tags,
        parentId: call.args.parentId,
        epicId: call.args.epicId,
      });
      return `Task created: [${task.id}] ${task.content} (${task.status}, ${task.priority})`;
    }

    case 'TaskList': {
      const tasks = store.list();
      if (tasks.length === 0) return 'No tasks found.';
      let filtered = tasks;
      if (call.args.status) {
        filtered = filtered.filter((t) => t.status === call.args.status);
      }
      if (call.args.epicId) {
        filtered = filtered.filter((t) => t.epicId === call.args.epicId);
      }
      if (filtered.length === 0) return `No tasks match the given filters.`;
      return filtered
        .map((t) => {
          const icon = t.status === 'in_progress' ? '●' : t.status === 'completed' ? '✓' : '○';
          return `${icon} [${t.status}] [${t.priority}] ${t.id} ${t.content}`;
        })
        .join('\n');
    }

    case 'TaskGet': {
      const task = await store.getFromCli(call.args.id);
      const lines = [
        `ID:          ${task.id}`,
        `Title:       ${task.content}`,
        `Status:      ${task.status}`,
        `Priority:    ${task.priority}`,
      ];
      if (task.description) lines.push(`Description: ${task.description}`);
      if (task.epicId) lines.push(`Epic:        ${task.epicId}`);
      if (task.parentId) lines.push(`Parent:      ${task.parentId}`);
      return lines.join('\n');
    }

    case 'TaskUpdate': {
      const task = await store.update(call.args.id, {
        content: call.args.content,
        description: call.args.description,
        priority: call.args.priority,
        status: call.args.status,
        tags: call.args.tags,
      });
      return `Task updated: [${task.id}] ${task.content} → ${task.status}`;
    }

    case 'TaskDelete': {
      const task = await store.deleteTask(call.args.id);
      return `Task deleted: [${task.id}] ${task.content} → ${task.status}`;
    }

    case 'TaskComment': {
      await store.comment(call.args.id, call.args.content);
      return `Comment added to ${call.args.id}.`;
    }

    case 'TaskSearch': {
      const results = await store.search(call.args.query);
      if (results.length === 0) return `No results for "${call.args.query}".`;
      return results.map((r) => `[${r.type}] ${r.id} ${r.title ?? ''} — ${r.snippet}`).join('\n');
    }

    case 'TaskReady': {
      const tasks = await store.ready();
      if (tasks.length === 0) return 'No ready tasks found.';
      return tasks.map((t) => `○ [${t.priority}] ${t.id} ${t.content}`).join('\n');
    }

    case 'TaskHistory': {
      return store.history({ entity: call.args.entity, limit: call.args.limit });
    }

    case 'EpicCreate': {
      const epic = await store.createEpic({
        title: call.args.title,
        description: call.args.description,
        priority: call.args.priority,
      });
      return `Epic created: [${epic.id}] ${epic.title} (${epic.status}, ${epic.priority})`;
    }

    case 'EpicList': {
      const epics = await store.listEpics(call.args.status);
      if (epics.length === 0) return 'No epics found.';
      return epics
        .map((e) => {
          const icon = e.status === 'in_progress' ? '●' : e.status === 'completed' ? '✓' : '○';
          return `${icon} [${e.status}] [${e.priority}] ${e.id} ${e.title}`;
        })
        .join('\n');
    }

    case 'EpicGet': {
      const epic = await store.getEpic(call.args.id);
      const lines = [
        `ID:          ${epic.id}`,
        `Title:       ${epic.title}`,
        `Status:      ${epic.status}`,
        `Priority:    ${epic.priority}`,
      ];
      if (epic.description) lines.push(`Description: ${epic.description}`);
      return lines.join('\n');
    }

    case 'EpicUpdate': {
      const epic = await store.updateEpic(call.args.id, {
        title: call.args.title,
        description: call.args.description,
        priority: call.args.priority,
        status: call.args.status,
      });
      return `Epic updated: [${epic.id}] ${epic.title} → ${epic.status}`;
    }

    case 'DepAdd': {
      await store.addDep(call.args.taskId, call.args.dependsOnId);
      return `Dependency added: ${call.args.taskId} depends on ${call.args.dependsOnId}.`;
    }

    case 'DepRemove': {
      await store.removeDep(call.args.taskId, call.args.dependsOnId);
      return `Dependency removed: ${call.args.taskId} no longer depends on ${call.args.dependsOnId}.`;
    }

    case 'DepList': {
      const deps = await store.listDeps(call.args.taskId);
      if (deps.length === 0) return `No dependencies for ${call.args.taskId}.`;
      return deps.map((d) => `${d.taskId} depends on ${d.dependsOnTaskId}`).join('\n');
    }
  }
}

/**
 * Intercept a bash command. Returns block payload for Pi's tool_call hook
 * (or null if not intercepting).
 *
 * Usage in tool_call hook:
 *   const intercept = await interceptBashCommand(cmd, store);
 *   if (intercept) return intercept;
 */
export async function interceptBashCommand(
  cmd: string,
  store: TrekkerStore,
  onIntercepted: () => void,
): Promise<{ block: true; reason: string } | { trekkerUsed: true } | null> {
  const result = classifyCommand(cmd);

  if (result.action === 'ignore') return null;
  if (result.action === 'track') {
    onIntercepted();
    return { trekkerUsed: true };
  }

  // block: execute all calls sequentially
  onIntercepted();
  const outputs: string[] = [];
  for (const call of result.calls) {
    try {
      const out = await dispatchToolCall(store, call);
      outputs.push(`[intercepted \`${callToCliHint(call)}\`]\n${out}`);
    } catch (err) {
      outputs.push(`[intercepted \`${callToCliHint(call)}\` — error: ${(err as Error).message}]`);
    }
  }

  return { block: true, reason: outputs.join('\n\n') };
}

function callToCliHint(call: ParsedToolCall): string {
  switch (call.tool) {
    case 'TaskCreate':
      return `trekker task create -t "${call.args.content}"`;
    case 'TaskList':
      return call.args.status ? `trekker task list -s ${call.args.status}` : 'trekker list';
    case 'TaskGet':
      return `trekker task show ${call.args.id}`;
    case 'TaskUpdate':
      return `trekker task update ${call.args.id}`;
    case 'TaskDelete':
      return `trekker task delete ${call.args.id}`;
    case 'TaskComment':
      return `trekker comment add ${call.args.id}`;
    case 'TaskSearch':
      return `trekker search "${call.args.query}"`;
    case 'TaskReady':
      return 'trekker ready';
    case 'TaskHistory':
      return call.args.entity ? `trekker history --entity ${call.args.entity}` : 'trekker history';
    case 'EpicCreate':
      return `trekker epic create -t "${call.args.title}"`;
    case 'EpicList':
      return call.args.status ? `trekker epic list -s ${call.args.status}` : 'trekker epic list';
    case 'EpicGet':
      return `trekker epic show ${call.args.id}`;
    case 'EpicUpdate':
      return `trekker epic update ${call.args.id}`;
    case 'DepAdd':
      return `trekker dep add ${call.args.taskId} ${call.args.dependsOnId}`;
    case 'DepRemove':
      return `trekker dep remove ${call.args.taskId} ${call.args.dependsOnId}`;
    case 'DepList':
      return `trekker dep list ${call.args.taskId}`;
  }
}
