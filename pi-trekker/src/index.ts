import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

type PolicyMode = 'off' | 'guide' | 'prompt' | 'block';
type CheckpointMode = 'off' | 'manual' | 'prompt' | 'auto';
type TrekkerState = 'active' | 'missing' | 'locked' | 'unavailable' | 'disabled';

const TREKKER_READ_TOOL_NAMES = [
  'trekker_search',
  'trekker_list',
  'trekker_ready',
  'trekker_history',
  'trekker_show',
  'trekker_comments',
  'trekker_subtask_list',
] as const;
const TREKKER_MUTATING_TOOL_NAMES = [
  'trekker_add_comment',
  'trekker_create_task',
  'trekker_update_task',
  'trekker_create_epic',
  'trekker_add_dependency',
  'trekker_complete_task',
  'trekker_subtask_create',
  'trekker_subtask_update',
  'trekker_subtask_start',
  'trekker_subtask_complete',
] as const;
const TREKKER_TOOL_NAMES = [...TREKKER_READ_TOOL_NAMES, ...TREKKER_MUTATING_TOOL_NAMES] as const;

interface TrekkerConfig {
  enabled: boolean;
  requireProjectTrekker: boolean;
  agentName: string;
  sessionStart: {
    injectContext: boolean;
    includeCurrentTask: boolean;
    includeRecentHistory: boolean;
    includeReadyTasks: boolean;
    historyLimit: number;
    readyLimit: number;
    includeQuickstartHint: boolean;
  };
  workflow: {
    strictness: PolicyMode;
    oneInProgressTask: PolicyMode;
    requireSearchBeforeCreate: PolicyMode;
    requireSummaryBeforeDone: PolicyMode;
  };
  checkpoint: {
    mode: CheckpointMode;
    onCompact: boolean;
    onShutdown: boolean;
    onSessionSwitch: boolean;
    onFork: boolean;
  };
  planMode: {
    enabled: boolean;
    plansDir: string;
    allowPlanWrites: boolean;
    blockImplementationWrites: boolean;
    blockRiskyShellWrites: boolean;
  };
  ui: {
    footerStatus: boolean;
    editorWidget: boolean;
    richFeedback: boolean;
    dashboardDetection: boolean;
    dashboardUrl: string;
    dashboardProbePorts: number[];
  };
  tools: {
    enabled: boolean;
    mutatingTools: boolean;
    readOnlyWhenPlanning: boolean;
  };
  subtasks: {
    enabled: boolean;
    injectContext: boolean;
    footerProgress: boolean;
    editorWidget: boolean;
    autoLoadOnSessionStart: boolean;
    requireForImplementation: PolicyMode;
    oneInProgressSubtask: PolicyMode;
    promptToCompleteParent: boolean;
    maxWidgetItems: number;
  };
}

const DEFAULT_CONFIG: TrekkerConfig = {
  enabled: true,
  requireProjectTrekker: true,
  agentName: 'pi',
  sessionStart: {
    injectContext: true,
    includeCurrentTask: true,
    includeRecentHistory: true,
    includeReadyTasks: true,
    historyLimit: 10,
    readyLimit: 10,
    includeQuickstartHint: true,
  },
  workflow: {
    strictness: 'prompt',
    oneInProgressTask: 'prompt',
    requireSearchBeforeCreate: 'prompt',
    requireSummaryBeforeDone: 'prompt',
  },
  checkpoint: {
    mode: 'prompt',
    onCompact: true,
    onShutdown: true,
    onSessionSwitch: true,
    onFork: true,
  },
  planMode: {
    enabled: true,
    plansDir: 'docs/plans',
    allowPlanWrites: true,
    blockImplementationWrites: true,
    blockRiskyShellWrites: true,
  },
  ui: {
    footerStatus: true,
    editorWidget: false,
    richFeedback: true,
    dashboardDetection: true,
    dashboardUrl: 'http://localhost:3000',
    dashboardProbePorts: [3000, 5173, 4173],
  },
  tools: {
    enabled: true,
    mutatingTools: true,
    readOnlyWhenPlanning: true,
  },
  subtasks: {
    enabled: true,
    injectContext: true,
    footerProgress: true,
    editorWidget: true,
    autoLoadOnSessionStart: true,
    requireForImplementation: 'guide',
    oneInProgressSubtask: 'prompt',
    promptToCompleteParent: true,
    maxWidgetItems: 8,
  },
};

interface TrekkerSubtask {
  id: string;
  parentTaskId: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface RuntimeState {
  state: TrekkerState;
  root: string | null;
  currentTask: string;
  activeTaskId: string | null;
  recentHistory: string;
  readyTasks: string;
  lastSearchAt: number;
  changedFiles: Set<string>;
  checkpointsDisabledThisSession: boolean;
  dashboardOnline: boolean;
  planModeUiActive: boolean | null;
  subtasks: TrekkerSubtask[];
  activeSubtaskId: string | null;
  subtasksLoadedForTaskId: string | null;
  subtaskChangedFiles: Map<string, Set<string>>;
}

type FeedbackKind = 'context' | 'tools' | 'checkpoint' | 'settings' | 'dashboard' | 'project';

function cloneConfig(config: TrekkerConfig): TrekkerConfig {
  return JSON.parse(JSON.stringify(config)) as TrekkerConfig;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T extends JsonObject>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  const output: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = output[key];
    output[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

function mergeConfig(saved: Partial<TrekkerConfig> | undefined): TrekkerConfig {
  return deepMerge(
    cloneConfig(DEFAULT_CONFIG) as unknown as JsonObject,
    saved,
  ) as unknown as TrekkerConfig;
}

function readJsonFile(file: string): JsonObject {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
  } catch {
    return {};
  }
}

function agentSettingsPath(): string {
  return path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent'),
    'settings.json',
  );
}

function projectSettingsPath(cwd: string, root: string | null): string {
  return path.join(root ?? cwd, '.pi', 'settings.json');
}

function loadConfigFromSettings(cwd: string, root: string | null): TrekkerConfig {
  const userSettings = readJsonFile(agentSettingsPath());
  const projectSettings = readJsonFile(projectSettingsPath(cwd, root));
  let next = deepMerge(
    cloneConfig(DEFAULT_CONFIG) as unknown as JsonObject,
    userSettings.trekker,
  ) as unknown as TrekkerConfig;
  next = deepMerge(
    next as unknown as JsonObject,
    projectSettings.trekker,
  ) as unknown as TrekkerConfig;
  return next;
}

function writeConfigToSettings(file: string, nextConfig: TrekkerConfig): void {
  const settings = readJsonFile(file);
  settings.trekker = cloneConfig(nextConfig) as unknown as JsonObject;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function findTrekkerRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.trekker'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function looksLocked(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('database is locked') || lower.includes('sqlite_busy');
}

function truncate(text: string, max = 6000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function parseActiveTaskId(output: string): string | null {
  return output.match(/\b[A-Z]+-\d+\b/)?.[0] ?? null;
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) args.push(match[1] ?? match[2] ?? match[3] ?? '');
  return args;
}

interface ToonTable {
  name: string;
  count: number;
  columns: string[];
  rows: Record<string, string>[];
}

interface ParsedToon {
  scalars: Record<string, string>;
  tables: ToonTable[];
  raw: string;
  unparsed: string[];
}

interface TrekkerToonResult {
  raw: string;
  parsed: ParsedToon;
}

function toon(args: string[]): string[] {
  return args[0] === '--toon' ? args : ['--toon', ...args];
}

function splitToonRow(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseToon(text: string): ParsedToon {
  const parsed: ParsedToon = { scalars: {}, tables: [], raw: text, unparsed: [] };
  const lines = text.split(/\r?\n/);
  let currentTable: ToonTable | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const tableMatch = line.match(/^([A-Za-z_][\w-]*)\[(\d+)](?:\{([^}]*)})?:\s*$/);
    if (tableMatch) {
      currentTable = {
        name: tableMatch[1] ?? '',
        count: Number.parseInt(tableMatch[2] ?? '0', 10),
        columns: tableMatch[3]?.split(',').map((column) => column.trim()).filter(Boolean) ?? [],
        rows: [],
      };
      parsed.tables.push(currentTable);
      continue;
    }

    if (line.startsWith('  ') && currentTable) {
      if (currentTable.columns.length === 0) {
        parsed.unparsed.push(line.trim());
        continue;
      }
      const values = splitToonRow(line.trim());
      const row: Record<string, string> = {};
      currentTable.columns.forEach((column, index) => {
        row[column] = values[index] ?? '';
      });
      if (values.length > currentTable.columns.length) row._extra = values.slice(currentTable.columns.length).join(',');
      currentTable.rows.push(row);
      continue;
    }

    const scalarMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (scalarMatch && !line.startsWith(' ')) {
      parsed.scalars[scalarMatch[1] ?? ''] = scalarMatch[2] ?? '';
      currentTable = null;
      continue;
    }

    parsed.unparsed.push(line);
  }

  return parsed;
}

async function runTrekker(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal) {
  const result = await pi.exec('trekker', args, { cwd, signal, timeout: 30_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.code !== 0) {
    const err = new Error(output || `trekker exited with code ${result.code}`) as Error & {
      code?: number;
    };
    err.code = result.code;
    throw err;
  }
  return output;
}

async function runTrekkerToon(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<TrekkerToonResult> {
  const raw = await runTrekker(pi, cwd, toon(args), signal);
  return { raw, parsed: parseToon(raw) };
}

function makeToolResult(text: string, command?: string[], cwd?: string, exitCode = 0, extraDetails: JsonObject = {}) {
  return {
    content: [{ type: 'text' as const, text: truncate(text) }],
    details: { command, cwd, exitCode, ...extraDetails },
  };
}

function makeToonToolResult(result: TrekkerToonResult, command: string[], cwd?: string, rendered = result.raw, exitCode = 0) {
  return makeToolResult(rendered, command, cwd, exitCode, { raw: result.raw, parsed: result.parsed as unknown as JsonObject });
}

function firstTable(parsed: ParsedToon, names: string[]): ToonTable | undefined {
  return parsed.tables.find((table) => names.includes(table.name)) ?? parsed.tables[0];
}

function ellipsize(value: string | undefined, max = 80): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function renderRows(table: ToonTable, columns: string[], maxRows = 20): string[] {
  const rows = table.rows.slice(0, maxRows).map((row) => columns.map((column) => row[column]).filter(Boolean).join(' · '));
  if (table.rows.length > maxRows) rows.push(`… ${table.rows.length - maxRows} more`);
  return rows;
}

function renderItemList(parsed: ParsedToon, title = 'Trekker items'): string {
  const table = firstTable(parsed, ['items', 'results']);
  if (!table) return truncate(parsed.raw);
  const total = parsed.scalars.total ?? String(table.count);
  const lines = [`${title} (${total})`];
  if (table.rows.length === 0) return `${lines[0]}\nNo items.`;
  for (const row of table.rows.slice(0, 20)) {
    const id = row.id ? `${row.id}` : '';
    const status = row.status ? `[${row.status}]` : '';
    const priority = row.priority ? `p${row.priority}` : '';
    const entity = row.entityType ?? row.type ?? '';
    const titleText = ellipsize(row.title ?? row.description ?? row.content ?? row.snapshot ?? row.id, 110);
    lines.push(`- ${[id, status, priority, entity].filter(Boolean).join(' ')}${titleText ? ` ${titleText}` : ''}`.trimEnd());
  }
  if (table.rows.length > 20) lines.push(`… ${table.rows.length - 20} more`);
  return truncate(lines.join('\n'));
}

function renderHistory(parsed: ParsedToon): string {
  const table = firstTable(parsed, ['events']);
  if (!table) return truncate(parsed.raw);
  const total = parsed.scalars.total ?? String(table.count);
  const lines = [`Trekker history (${total})`];
  if (table.rows.length === 0) return `${lines[0]}\nNo events.`;
  for (const row of table.rows.slice(0, 15)) {
    const head = [row.id, row.action, row.entityType, row.entityId].filter(Boolean).join(' · ');
    const preview = ellipsize(row.content ?? row.snapshot ?? row.changes, 100);
    lines.push(`- ${head}${row.timestamp ? ` @ ${row.timestamp}` : ''}${preview ? ` — ${preview}` : ''}`);
  }
  if (table.rows.length > 15) lines.push(`… ${table.rows.length - 15} more`);
  return truncate(lines.join('\n'));
}

function renderShow(parsed: ParsedToon, fallbackTitle = 'Trekker item'): string {
  const scalarEntries = Object.entries(parsed.scalars).filter(([, value]) => value !== '');
  const lines = [fallbackTitle];
  if (scalarEntries.length > 0) {
    for (const [key, value] of scalarEntries.slice(0, 20)) lines.push(`${key}: ${ellipsize(value, 140)}`);
  }
  for (const table of parsed.tables) {
    lines.push(`${table.name} (${table.rows.length || table.count})`);
    lines.push(...renderRows(table, table.columns.slice(0, 4), 8).map((line) => `- ${ellipsize(line, 140)}`));
  }
  return lines.length > 1 ? truncate(lines.join('\n')) : truncate(parsed.raw);
}

function renderToon(parsed: ParsedToon, kind: 'list' | 'ready' | 'search' | 'history' | 'show', title?: string): string {
  if (kind === 'history') return renderHistory(parsed);
  if (kind === 'show') return renderShow(parsed, title);
  if (kind === 'ready') return renderItemList(parsed, title ?? 'Ready Trekker tasks');
  if (kind === 'search') return renderItemList(parsed, title ?? 'Trekker search results');
  return renderItemList(parsed, title ?? 'Trekker items');
}

function parseSubtasks(result: TrekkerToonResult, parentTaskId: string): TrekkerSubtask[] {
  const table = firstTable(result.parsed, ['items', 'results']);
  if (!table) return [];
  return table.rows
    .map((row) => ({
      id: row.id ?? row.subtaskId ?? '',
      parentTaskId: row.parentTaskId ?? row.taskId ?? parentTaskId,
      title: row.title ?? '',
      description: row.description || undefined,
      status: row.status ?? 'todo',
      priority: row.priority || undefined,
      createdAt: row.createdAt || undefined,
      updatedAt: row.updatedAt || undefined,
    }))
    .filter((subtask) => subtask.id);
}

function renderSubtaskChecklist(subtasks: TrekkerSubtask[], parentTaskId: string, maxItems = 8): string {
  const completed = subtasks.filter((subtask) => subtask.status === 'completed').length;
  const lines = [`Trekker subtasks for ${parentTaskId} (${completed}/${subtasks.length})`];
  if (subtasks.length === 0) return `${lines[0]}\n  □ No subtasks yet`;
  for (const subtask of subtasks.slice(0, maxItems)) {
    const marker = subtask.status === 'completed' ? '✓' : subtask.status === 'in_progress' ? '▶' : '□';
    lines.push(`  ${marker} ${subtask.id} ${ellipsize(subtask.title, 90)}`);
  }
  if (subtasks.length > maxItems) lines.push(`  … ${subtasks.length - maxItems} more`);
  return lines.join('\n');
}

function subtaskProgress(subtasks: TrekkerSubtask[]): { completed: number; total: number; activeId: string | null } {
  return {
    completed: subtasks.filter((subtask) => subtask.status === 'completed').length,
    total: subtasks.length,
    activeId: subtasks.find((subtask) => subtask.status === 'in_progress')?.id ?? null,
  };
}

function isPlanModeActive(pi: ExtensionAPI, config: TrekkerConfig): boolean {
  if (!config.planMode.enabled) return false;
  const activeTools = pi.getActiveTools();
  return !activeTools.includes('edit') && !activeTools.includes('write');
}

function isInsidePlansDir(
  ctx: ExtensionContext,
  config: TrekkerConfig,
  targetPath: string,
): boolean {
  const root = path.resolve(ctx.cwd, config.planMode.plansDir);
  const target = path.resolve(ctx.cwd, targetPath.replace(/^@/, ''));
  return target === root || target.startsWith(root + path.sep);
}

function isRiskyShellWrite(command: string): boolean {
  return (
    /(^|\s)(rm|mv|cp)\s/.test(command) ||
    />\>?/.test(command) ||
    /\btee\b/.test(command) ||
    /\bsed\s+-i\b/.test(command)
  );
}

function buildCheckpoint(runtime: RuntimeState): string {
  const files = [...runtime.changedFiles].sort();
  return `Checkpoint:\nDone: \nNext: \nFiles: ${files.length ? files.join(', ') : '(none tracked)'}\nState: `;
}

export default function trekkerExtension(pi: ExtensionAPI) {
  let config = cloneConfig(DEFAULT_CONFIG);
  const runtime: RuntimeState = {
    state: 'missing',
    root: null,
    currentTask: '',
    activeTaskId: null,
    recentHistory: '',
    readyTasks: '',
    lastSearchAt: 0,
    changedFiles: new Set<string>(),
    checkpointsDisabledThisSession: false,
    dashboardOnline: false,
    planModeUiActive: null,
    subtasks: [],
    activeSubtaskId: null,
    subtasksLoadedForTaskId: null,
    subtaskChangedFiles: new Map<string, Set<string>>(),
  };

  function saveConfig() {
    pi.appendEntry<TrekkerConfig>('trekker-config', cloneConfig(config));
  }

  function feedback(
    ctx: ExtensionContext,
    _kind: FeedbackKind,
    message: string,
    type: 'info' | 'warning' | 'error' = 'info',
  ) {
    if (!config.ui.richFeedback || !ctx.hasUI) return;
    ctx.ui.notify(message, type);
  }

  function updateActiveToolsForState(ctx?: ExtensionContext) {
    const current = pi.getActiveTools();
    const allNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const trekkerNames = new Set<string>(TREKKER_TOOL_NAMES);
    let next = current.filter((name) => !trekkerNames.has(name));
    let reason = 'disabled or unavailable';

    if (config.enabled && config.tools.enabled && runtime.state === 'active') {
      const planning = isPlanModeActive(pi, config);
      const wanted =
        planning && config.tools.readOnlyWhenPlanning
          ? TREKKER_READ_TOOL_NAMES
          : config.tools.mutatingTools
            ? TREKKER_TOOL_NAMES
            : TREKKER_READ_TOOL_NAMES;
      reason =
        planning && config.tools.readOnlyWhenPlanning
          ? 'read-only tools active for plan mode'
          : 'tools active';
      next = [...next, ...wanted.filter((name) => allNames.has(name))];
    }

    if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
      const before = current.filter((name) => trekkerNames.has(name)).length;
      const after = next.filter((name) => trekkerNames.has(name)).length;
      pi.setActiveTools(next);
      if (ctx && before !== after) {
        feedback(ctx, 'tools', `Trekker tools updated: ${after} active (${reason}).`);
      }
    }
  }

  async function refreshState(ctx: ExtensionContext) {
    if (!config.enabled) {
      runtime.state = 'disabled';
      runtime.root = null;
      runtime.activeTaskId = null;
      runtime.currentTask = '';
      return;
    }

    runtime.root = findTrekkerRoot(ctx.cwd);
    if (!runtime.root && config.requireProjectTrekker) {
      runtime.state = 'missing';
      runtime.activeTaskId = null;
      runtime.currentTask = '';
      return;
    }

    const cwd = runtime.root ?? ctx.cwd;
    try {
      await runTrekker(pi, cwd, ['--version'], ctx.signal);
      runtime.state = 'active';
      if (!runtime.root) runtime.root = cwd;
      const active = await runTrekker(
        pi,
        runtime.root,
        toon(['task', 'list', '--status', 'in_progress']),
        ctx.signal,
      );
      runtime.currentTask = active || 'No in-progress Trekker tasks.';
      runtime.activeTaskId = parseActiveTaskId(active);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.state = looksLocked(message) ? 'locked' : 'unavailable';
    }
  }

  async function refreshContextData(ctx: ExtensionContext) {
    if (runtime.state !== 'active' || !runtime.root) return;
    try {
      runtime.recentHistory = config.sessionStart.includeRecentHistory
        ? await runTrekker(
            pi,
            runtime.root,
            toon(['history', '--limit', String(config.sessionStart.historyLimit)]),
            ctx.signal,
          )
        : '';
      runtime.readyTasks = config.sessionStart.includeReadyTasks
        ? await runTrekker(pi, runtime.root, toon(['ready']), ctx.signal)
        : '';
    } catch (err) {
      if (looksLocked(err instanceof Error ? err.message : String(err))) runtime.state = 'locked';
    }
  }

  async function refreshSubtasks(ctx: ExtensionContext, taskId = runtime.activeTaskId) {
    if (!config.subtasks.enabled || runtime.state !== 'active' || !runtime.root || !taskId) {
      runtime.subtasks = [];
      runtime.activeSubtaskId = null;
      runtime.subtasksLoadedForTaskId = null;
      return;
    }
    try {
      const result = await runTrekkerToon(pi, runtime.root, ['subtask', 'list', taskId], ctx.signal);
      runtime.subtasks = parseSubtasks(result, taskId);
      runtime.activeSubtaskId = subtaskProgress(runtime.subtasks).activeId;
      runtime.subtasksLoadedForTaskId = taskId;
    } catch (err) {
      if (looksLocked(err instanceof Error ? err.message : String(err))) runtime.state = 'locked';
      runtime.subtasks = [];
      runtime.activeSubtaskId = null;
      runtime.subtasksLoadedForTaskId = taskId;
    }
  }

  function updateSubtaskUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!config.subtasks.enabled || !runtime.activeTaskId) {
      ctx.ui.setWidget('trekker-subtasks', undefined);
      return;
    }
    if (config.subtasks.editorWidget || config.ui.editorWidget) {
      ctx.ui.setWidget(
        'trekker-subtasks',
        renderSubtaskChecklist(runtime.subtasks, runtime.activeTaskId, config.subtasks.maxWidgetItems).split('\n'),
        { placement: 'belowEditor' },
      );
    } else {
      ctx.ui.setWidget('trekker-subtasks', undefined);
    }
  }

  async function probeDashboard() {
    if (!config.ui.dashboardDetection) {
      runtime.dashboardOnline = false;
      return;
    }
    const urls = [
      config.ui.dashboardUrl,
      ...config.ui.dashboardProbePorts.map((port) => `http://localhost:${port}`),
    ];
    for (const url of [...new Set(urls)]) {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 500);
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        clearTimeout(id);
        if (res.ok || res.status < 500) {
          runtime.dashboardOnline = true;
          return;
        }
      } catch {
        // ignore
      }
    }
    runtime.dashboardOnline = false;
  }

  function updateFooter(ctx: ExtensionContext) {
    if (!config.ui.footerStatus || !ctx.hasUI) return;
    let text = 'Trekker: disabled';
    if (runtime.state === 'active') {
      text = runtime.activeTaskId
        ? `Trekker: ${runtime.activeTaskId} in_progress`
        : 'Trekker: no active task';
      if (runtime.activeTaskId && config.subtasks.enabled && config.subtasks.footerProgress) {
        const progress = subtaskProgress(runtime.subtasks);
        text += progress.total > 0
          ? ` · subtasks ${progress.completed}/${progress.total}${progress.activeId ? ` · active ${progress.activeId}` : ''}`
          : ' · no subtasks';
      }
      if (runtime.dashboardOnline) text += ' · dashboard online';
    } else if (runtime.state === 'missing') text = 'Trekker: not initialized';
    else if (runtime.state === 'locked') text = 'Trekker: locked';
    else if (runtime.state === 'unavailable') text = 'Trekker: unavailable';
    ctx.ui.setStatus('trekker', text);
  }

  function updatePlanModeUi(ctx: ExtensionContext, notifyOnActivation = false) {
    if (!ctx.hasUI) return;
    const planning = isPlanModeActive(pi, config);
    ctx.ui.setStatus(
      'trekker-plan-mode',
      planning ? `PLAN MODE: plans only (${config.planMode.plansDir}/)` : undefined,
    );
    ctx.ui.setWidget(
      'trekker-plan-mode',
      planning && config.ui.editorWidget
        ? [
            '📝 Trekker plan mode is ON — implementation writes are blocked.',
            `Allowed plan output: ${config.planMode.plansDir}/`,
          ]
        : undefined,
      { placement: 'belowEditor' },
    );
    if (runtime.planModeUiActive !== planning) {
      if (planning && notifyOnActivation)
        feedback(
          ctx,
          'project',
          `Trekker plan mode is on. UI indicator enabled; write plans under ${config.planMode.plansDir}/.`,
        );
      runtime.planModeUiActive = planning;
    }
  }

  async function ensureActive(ctx: ExtensionCommandContext): Promise<boolean> {
    await refreshState(ctx);
    updateFooter(ctx);
    if (runtime.state === 'active') return true;
    if (runtime.state === 'missing' && ctx.hasUI) {
      const choice = await ctx.ui.select('Trekker is not initialized for this project.', [
        'Initialize',
        'Continue without Trekker',
        'Cancel',
      ]);
      if (choice === 'Initialize') {
        await runTrekker(pi, ctx.cwd, ['init'], ctx.signal);
        await refreshState(ctx);
        updateFooter(ctx);
        return (runtime.state as TrekkerState) === 'active';
      }
      return false;
    }
    if (ctx.hasUI) ctx.ui.notify(`Trekker is ${runtime.state}`, 'error');
    return false;
  }

  async function maybeCheckpoint(ctx: ExtensionContext, reason: string) {
    if (runtime.checkpointsDisabledThisSession) return;
    if (runtime.state !== 'active' || !runtime.root || !runtime.activeTaskId) return;
    if (config.checkpoint.mode === 'off' || config.checkpoint.mode === 'manual') return;

    let content = buildCheckpoint(runtime);
    if (config.checkpoint.mode === 'prompt') {
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(`Add a Trekker checkpoint before ${reason}?`, [
        'Add checkpoint',
        'Skip once',
        'Disable this session',
      ]);
      if (choice === 'Skip once' || !choice) return;
      if (choice === 'Disable this session') {
        runtime.checkpointsDisabledThisSession = true;
        return;
      }
      const edited = await ctx.ui.editor('Trekker checkpoint', content);
      if (!edited?.trim()) return;
      content = edited.trim();
    }

    await runTrekker(
      pi,
      runtime.root,
      ['comment', 'add', runtime.activeTaskId, '-a', config.agentName, '-c', content],
      ctx.signal,
    );
    runtime.changedFiles.clear();
    feedback(ctx, 'checkpoint', `Checkpoint added to ${runtime.activeTaskId}.`);
  }

  pi.on('session_start', async (_event, ctx) => {
    const root = findTrekkerRoot(ctx.cwd);
    config = loadConfigFromSettings(ctx.cwd, root);

    const sessionConfigEntry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === 'custom' && entry.customType === 'trekker-config');
    if (sessionConfigEntry && 'data' in sessionConfigEntry) {
      config = deepMerge(
        config as unknown as JsonObject,
        sessionConfigEntry.data,
      ) as unknown as TrekkerConfig;
    }

    await refreshState(ctx);
    await probeDashboard();
    await refreshContextData(ctx);
    if (config.subtasks.autoLoadOnSessionStart) await refreshSubtasks(ctx);
    updateActiveToolsForState(ctx);
    updateFooter(ctx);
    updateSubtaskUi(ctx);
    updatePlanModeUi(ctx);
    if (runtime.state === 'active') {
      const parts = [
        runtime.activeTaskId ? `active ${runtime.activeTaskId}` : 'no active task',
        config.sessionStart.includeRecentHistory ? 'history loaded' : undefined,
        config.sessionStart.includeReadyTasks ? 'ready tasks loaded' : undefined,
        runtime.dashboardOnline ? 'dashboard online' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      feedback(ctx, 'project', `Trekker project active: ${parts}.`);
    } else {
      feedback(
        ctx,
        'project',
        `Trekker state: ${runtime.state}.`,
        runtime.state === 'missing' ? 'info' : 'warning',
      );
    }
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    const messages: string[] = [];
    if (config.sessionStart.injectContext && runtime.state === 'active') {
      if (config.sessionStart.includeQuickstartHint)
        messages.push(
          'Trekker is available for persistent task memory. For command syntax and workflow, inspect `trekker quickstart` output with the shell when needed.',
        );
      if (config.sessionStart.includeCurrentTask && runtime.currentTask)
        messages.push(`Current Trekker task:\n${truncate(runtime.currentTask, 1500)}`);
      if (config.sessionStart.includeRecentHistory && runtime.recentHistory)
        messages.push(`Recent Trekker history:\n${truncate(runtime.recentHistory, 1500)}`);
      if (config.sessionStart.includeReadyTasks && runtime.readyTasks)
        messages.push(`Ready Trekker tasks:\n${truncate(runtime.readyTasks, 1500)}`);
      if (config.subtasks.enabled && config.subtasks.injectContext && runtime.activeTaskId) {
        if (runtime.subtasksLoadedForTaskId !== runtime.activeTaskId) await refreshSubtasks(ctx);
        messages.push(`Current Trekker subtasks for ${runtime.activeTaskId}:\n${renderSubtaskChecklist(runtime.subtasks, runtime.activeTaskId, config.subtasks.maxWidgetItems)}\n\nUse these as your durable todo list. Update subtask status as work progresses.`);
      }
    }
    if (isPlanModeActive(pi, config)) {
      messages.push(
        `You are in plan mode.\n\nDo not write or edit implementation files. You may inspect files and gather context.\n\nIf producing a plan, save it under the configured plan folder, default: ${config.planMode.plansDir}/.\n\nUse Trekker for task context when available. Run \`trekker quickstart\` if you need the Trekker command reference.`,
      );
    }
    updateActiveToolsForState(ctx);
    updateSubtaskUi(ctx);
    updatePlanModeUi(ctx, true);
    if (messages.length === 0) return;
    feedback(
      ctx,
      'context',
      `Injected Trekker context (${messages.length} section${messages.length === 1 ? '' : 's'}).`,
    );
    return {
      message: { customType: 'trekker-context', content: messages.join('\n\n'), display: false },
    };
  });

  pi.on('tool_call', async (event, ctx) => {
    updatePlanModeUi(ctx);
    const planning = isPlanModeActive(pi, config);
    if (
      planning &&
      config.planMode.blockImplementationWrites &&
      (event.toolName === 'edit' || event.toolName === 'write')
    ) {
      const file = typeof event.input?.path === 'string' ? event.input.path : '';
      if (!config.planMode.allowPlanWrites || !isInsidePlansDir(ctx, config, file)) {
        return {
          block: true,
          reason: `Blocked: Trekker plan mode is active. Write plans only under ${config.planMode.plansDir}/ or exit plan mode before modifying implementation files.`,
        };
      }
    }
    if (planning && config.planMode.blockRiskyShellWrites && event.toolName === 'bash') {
      const command = typeof event.input?.command === 'string' ? event.input.command : '';
      if (isRiskyShellWrite(command))
        return {
          block: true,
          reason:
            'Blocked: Trekker plan mode is active and this shell command appears to modify files.',
        };
    }
    if (
      config.subtasks.enabled &&
      config.subtasks.requireForImplementation !== 'off' &&
      runtime.activeTaskId &&
      runtime.subtasks.length === 0 &&
      (event.toolName === 'edit' || event.toolName === 'write')
    ) {
      const reason = `Active task ${runtime.activeTaskId} has no Trekker subtasks. Use /trekker subtasks plan or create subtasks before multi-step implementation.`;
      if (config.subtasks.requireForImplementation === 'block') return { block: true, reason };
      if (config.subtasks.requireForImplementation === 'prompt' && ctx.hasUI) {
        const ok = await ctx.ui.confirm('No Trekker subtasks for active task.', `${reason}\n\nContinue anyway?`);
        if (!ok) return { block: true, reason };
      } else if (config.subtasks.requireForImplementation === 'guide') {
        feedback(ctx, 'project', reason, 'warning');
      }
    }
  });

  pi.on('tool_result', async (event) => {
    if (
      (event.toolName === 'edit' || event.toolName === 'write') &&
      typeof event.input?.path === 'string'
    ) {
      runtime.changedFiles.add(event.input.path);
      if (runtime.activeSubtaskId) {
        const files = runtime.subtaskChangedFiles.get(runtime.activeSubtaskId) ?? new Set<string>();
        files.add(event.input.path);
        runtime.subtaskChangedFiles.set(runtime.activeSubtaskId, files);
      }
    }
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    if (config.checkpoint.onCompact) await maybeCheckpoint(ctx, 'compaction');
  });
  pi.on('session_before_switch', async (_event, ctx) => {
    if (config.checkpoint.onSessionSwitch) await maybeCheckpoint(ctx, 'session switch');
  });
  pi.on('session_before_fork', async (_event, ctx) => {
    if (config.checkpoint.onFork) await maybeCheckpoint(ctx, 'fork');
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (config.checkpoint.onShutdown) await maybeCheckpoint(ctx, 'shutdown');
  });

  pi.registerCommand('trekker', {
    description:
      'Trekker task memory: /trekker status|init|settings|search|list|ready|start|subtasks|checkpoint|done|history|show|dashboard|plan',
    handler: async (args, ctx) => {
      const parts = splitArgs(args ?? '');
      const sub = parts.shift() ?? 'status';
      try {
        switch (sub) {
          case 'help':
            ctx.ui.notify(
              'Usage: /trekker status|init|settings|search <query>|list [args]|ready|start <id>|subtasks [list|sync|add|start|done|plan]|checkpoint [id]|done [id]|history|show <id>|dashboard|plan [goal]',
              'info',
            );
            return;
          case 'status':
            await refreshState(ctx);
            await probeDashboard();
            updateActiveToolsForState(ctx);
            updateFooter(ctx);
            updatePlanModeUi(ctx);
            ctx.ui.notify(
              `State: ${runtime.state}\nRoot: ${runtime.root ?? '(none)'}\nActive: ${runtime.activeTaskId ?? '(none)'}\nPlan mode: ${isPlanModeActive(pi, config) ? 'on' : 'off'}\nDashboard: ${runtime.dashboardOnline ? 'online' : 'offline'}`,
              'info',
            );
            return;
          case 'init':
            ctx.ui.notify(await runTrekker(pi, ctx.cwd, ['init'], ctx.signal), 'info');
            await refreshState(ctx);
            updateActiveToolsForState(ctx);
            updateFooter(ctx);
            updatePlanModeUi(ctx);
            return;
          case 'settings':
            await openSettings(ctx);
            return;
          case 'search': {
            if (!(await ensureActive(ctx))) return;
            const query = parts.join(' ');
            if (!query) return ctx.ui.notify('Usage: /trekker search <query>', 'error');
            runtime.lastSearchAt = Date.now();
            const result = await runTrekkerToon(
              pi,
              runtime.root!,
              ['search', query, '--type', 'task', '--limit', '20'],
              ctx.signal,
            );
            ctx.ui.notify(renderToon(result.parsed, 'search'), 'info');
            return;
          }
          case 'list':
            if (await ensureActive(ctx)) {
              const result = await runTrekkerToon(pi, runtime.root!, ['list', ...parts], ctx.signal);
              ctx.ui.notify(renderToon(result.parsed, 'list'), 'info');
            }
            return;
          case 'ready':
            if (await ensureActive(ctx)) {
              const result = await runTrekkerToon(pi, runtime.root!, ['ready'], ctx.signal);
              ctx.ui.notify(renderToon(result.parsed, 'ready'), 'info');
            }
            return;
          case 'history':
            if (await ensureActive(ctx)) {
              const result = await runTrekkerToon(
                pi,
                runtime.root!,
                ['history', '--limit', parts[0] ?? String(config.sessionStart.historyLimit)],
                ctx.signal,
              );
              ctx.ui.notify(renderToon(result.parsed, 'history'), 'info');
            }
            return;
          case 'show': {
            if (!(await ensureActive(ctx))) return;
            const id = parts[0];
            if (!id) return ctx.ui.notify('Usage: /trekker show <id>', 'error');
            const result = await runTrekkerToon(
              pi,
              runtime.root!,
              [id.startsWith('EPIC-') ? 'epic' : 'task', 'show', id],
              ctx.signal,
            );
            ctx.ui.notify(renderToon(result.parsed, 'show', id), 'info');
            return;
          }
          case 'subtasks': {
            if (!(await ensureActive(ctx))) return;
            const action = parts.shift() ?? 'list';
            const taskId = parts[0]?.startsWith('TREK-') ? parts.shift()! : runtime.activeTaskId;
            if (!taskId) return ctx.ui.notify('No active Trekker task. Pass a task id.', 'error');

            if (action === 'list' || action === 'sync') {
              await refreshSubtasks(ctx, taskId);
              updateFooter(ctx);
              updateSubtaskUi(ctx);
              ctx.ui.notify(renderSubtaskChecklist(runtime.subtasks, taskId, config.subtasks.maxWidgetItems), 'info');
              return;
            }

            if (action === 'clear-ui') {
              runtime.subtasks = [];
              runtime.activeSubtaskId = null;
              runtime.subtasksLoadedForTaskId = null;
              ctx.ui.setWidget('trekker-subtasks', undefined);
              updateFooter(ctx);
              return;
            }

            if (action === 'add') {
              const title = parts.join(' ');
              if (!title) return ctx.ui.notify('Usage: /trekker subtasks add [task-id] <title>', 'error');
              ctx.ui.notify(await runTrekker(pi, runtime.root!, ['subtask', 'create', taskId, '-t', title], ctx.signal), 'info');
              await refreshSubtasks(ctx, taskId);
              updateFooter(ctx);
              updateSubtaskUi(ctx);
              return;
            }

            if (action === 'start' || action === 'done') {
              const subtaskId = parts[0];
              if (!subtaskId) return ctx.ui.notify(`Usage: /trekker subtasks ${action} <subtask-id>`, 'error');
              const status = action === 'start' ? 'in_progress' : 'completed';
              ctx.ui.notify(await runTrekker(pi, runtime.root!, ['subtask', 'update', subtaskId, '-s', status], ctx.signal), 'info');
              await refreshSubtasks(ctx, taskId);
              updateFooter(ctx);
              updateSubtaskUi(ctx);
              const progress = subtaskProgress(runtime.subtasks);
              feedback(ctx, 'project', `${action === 'start' ? 'Started' : 'Completed'} subtask ${subtaskId}${progress.total ? ` (${progress.completed}/${progress.total} done)` : ''}.`);
              if (action === 'done' && config.subtasks.promptToCompleteParent && progress.total > 0 && progress.completed === progress.total && ctx.hasUI) {
                const ok = await ctx.ui.confirm(`All subtasks complete for ${taskId}.`, 'Mark parent task completed now?');
                if (ok) pi.sendUserMessage(`/trekker done ${taskId}`, { deliverAs: 'followUp' });
              }
              return;
            }

            if (action === 'plan') {
              const goal = parts.join(' ') || `Plan implementation subtasks for ${taskId}`;
              pi.sendUserMessage(`Draft 3-8 Trekker subtasks for ${taskId}: ${goal}\n\nShow the proposed checklist and ask before creating subtasks.`, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
              return;
            }

            ctx.ui.notify(`Unknown /trekker subtasks action: ${action}`, 'error');
            return;
          }
          case 'start': {
            if (!(await ensureActive(ctx))) return;
            const id = parts[0];
            if (!id)
              return ctx.ui.notify(
                'Usage: /trekker start <task-id>. Use /trekker search <query> first.',
                'info',
              );
            if (
              runtime.activeTaskId &&
              runtime.activeTaskId !== id &&
              config.workflow.oneInProgressTask === 'prompt' &&
              ctx.hasUI
            ) {
              const ok = await ctx.ui.confirm(
                'Another Trekker task is already in progress.',
                `Start ${id} anyway?`,
              );
              if (!ok) return;
            }
            ctx.ui.notify(
              truncate(
                await runTrekker(
                  pi,
                  runtime.root!,
                  ['task', 'update', id, '-s', 'in_progress'],
                  ctx.signal,
                ),
              ),
              'info',
            );
            await refreshState(ctx);
            await refreshSubtasks(ctx, id);
            updateActiveToolsForState(ctx);
            updateFooter(ctx);
            updateSubtaskUi(ctx);
            feedback(ctx, 'project', `Started Trekker task ${id}.`);
            return;
          }
          case 'checkpoint': {
            if (!(await ensureActive(ctx))) return;
            const id = parts[0] ?? runtime.activeTaskId;
            if (!id) return ctx.ui.notify('No active Trekker task. Pass a task id.', 'error');
            const edited = ctx.hasUI
              ? await ctx.ui.editor('Trekker checkpoint', buildCheckpoint(runtime))
              : buildCheckpoint(runtime);
            if (!edited?.trim()) return;
            ctx.ui.notify(
              truncate(
                await runTrekker(
                  pi,
                  runtime.root!,
                  ['comment', 'add', id, '-a', config.agentName, '-c', edited.trim()],
                  ctx.signal,
                ),
              ),
              'info',
            );
            runtime.changedFiles.clear();
            return;
          }
          case 'done': {
            if (!(await ensureActive(ctx))) return;
            const id = parts[0] ?? runtime.activeTaskId;
            if (!id) return ctx.ui.notify('No active Trekker task. Pass a task id.', 'error');
            const summary = ctx.hasUI
              ? await ctx.ui.editor('Completion summary', 'Summary: ')
              : 'Summary: completed.';
            if (!summary?.trim()) return;
            await runTrekker(
              pi,
              runtime.root!,
              ['comment', 'add', id, '-a', config.agentName, '-c', summary.trim()],
              ctx.signal,
            );
            const done = await runTrekker(
              pi,
              runtime.root!,
              ['task', 'update', id, '-s', 'completed'],
              ctx.signal,
            );
            const ready = await runTrekkerToon(pi, runtime.root!, ['ready'], ctx.signal);
            ctx.ui.notify(truncate(`${done}\n\n${renderToon(ready.parsed, 'ready')}`), 'info');
            await refreshState(ctx);
            updateActiveToolsForState(ctx);
            updateFooter(ctx);
            feedback(ctx, 'project', `Completed Trekker task ${id}.`);
            return;
          }
          case 'dashboard':
            await probeDashboard();
            updateFooter(ctx);
            feedback(
              ctx,
              'dashboard',
              runtime.dashboardOnline
                ? `Trekker dashboard appears online: ${config.ui.dashboardUrl}`
                : 'Trekker dashboard not detected.',
              runtime.dashboardOnline ? 'info' : 'warning',
            );
            return;
          case 'plan': {
            if (!(await ensureActive(ctx))) return;
            const goal =
              parts.join(' ') ||
              (ctx.hasUI ? await ctx.ui.input('Plan goal', 'Describe the goal') : '');
            if (!goal?.trim()) return;
            const slug =
              goal
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 48) || 'plan';
            const planPath = path.join(
              config.planMode.plansDir,
              `${new Date().toISOString().slice(0, 10)}-${slug}.md`,
            );
            pi.sendUserMessage(
              `Draft an implementation plan for: ${goal}\n\nSave the plan to ${planPath}. Do not modify implementation files. After drafting, ask whether to create Trekker epic/tasks.`,
              ctx.isIdle() ? undefined : { deliverAs: 'followUp' },
            );
            return;
          }
          default:
            ctx.ui.notify(`Unknown /trekker subcommand: ${sub}`, 'error');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (looksLocked(message) && ctx.hasUI) {
          const choice = await ctx.ui.select('Trekker database is locked.', [
            'Retry the command',
            'Continue without Trekker',
            'Cancel',
          ]);
          if (choice === 'Retry the command')
            pi.sendUserMessage(`/trekker ${args ?? ''}`, { deliverAs: 'followUp' });
        } else ctx.ui.notify(message, 'error');
      }
    },
  });

  async function openSettings(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) return ctx.ui.notify('/trekker settings requires interactive mode', 'error');

    type SettingItem = {
      section: string;
      label: string;
      detail: string;
      value: () => string;
      edit: () => Promise<void> | void;
    };

    const cycle = <T extends string>(values: readonly T[], current: T): T => {
      const idx = values.indexOf(current);
      return values[(idx + 1) % values.length] ?? values[0];
    };

    const boolItem = (
      section: string,
      label: string,
      detail: string,
      get: () => boolean,
      set: (value: boolean) => void,
    ): SettingItem => ({
      section,
      label,
      detail,
      value: () => (get() ? 'enabled' : 'disabled'),
      edit: () => set(!get()),
    });

    const modeItem = <T extends string>(
      section: string,
      label: string,
      detail: string,
      values: readonly T[],
      get: () => T,
      set: (value: T) => void,
    ): SettingItem => ({
      section,
      label,
      detail,
      value: () => get(),
      edit: () => set(cycle(values, get())),
    });

    const numberItem = (
      section: string,
      label: string,
      detail: string,
      get: () => number,
      set: (value: number) => void,
    ): SettingItem => ({
      section,
      label,
      detail,
      value: () => String(get()),
      edit: async () => {
        const value = await ctx.ui.input(label, String(get()));
        if (!value) return;
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) set(parsed);
        else ctx.ui.notify(`Invalid number: ${value}`, 'error');
      },
    });

    const stringItem = (
      section: string,
      label: string,
      detail: string,
      get: () => string,
      set: (value: string) => void,
    ): SettingItem => ({
      section,
      label,
      detail,
      value: () => get(),
      edit: async () => {
        const value = await ctx.ui.input(label, get());
        if (value !== undefined) set(value.trim());
      },
    });

    const buildItems = (): SettingItem[] => [
      boolItem(
        'Project',
        'Enabled',
        'Master switch for the extension',
        () => config.enabled,
        (v) => (config.enabled = v),
      ),
      boolItem(
        'Project',
        'Require .trekker',
        'Gate most features unless project has .trekker/',
        () => config.requireProjectTrekker,
        (v) => (config.requireProjectTrekker = v),
      ),
      stringItem(
        'Project',
        'Agent name',
        'Author name used for Trekker comments',
        () => config.agentName,
        (v) => (config.agentName = v || DEFAULT_CONFIG.agentName),
      ),

      boolItem(
        'Session Context',
        'Inject context',
        'Inject Trekker context before agent starts',
        () => config.sessionStart.injectContext,
        (v) => (config.sessionStart.injectContext = v),
      ),
      boolItem(
        'Session Context',
        'Current task',
        'Include current in-progress task',
        () => config.sessionStart.includeCurrentTask,
        (v) => (config.sessionStart.includeCurrentTask = v),
      ),
      boolItem(
        'Session Context',
        'Recent history',
        'Include Trekker audit history',
        () => config.sessionStart.includeRecentHistory,
        (v) => (config.sessionStart.includeRecentHistory = v),
      ),
      boolItem(
        'Session Context',
        'Ready tasks',
        'Include ready/unblocked tasks',
        () => config.sessionStart.includeReadyTasks,
        (v) => (config.sessionStart.includeReadyTasks = v),
      ),
      numberItem(
        'Session Context',
        'History limit',
        'Number of history rows to include',
        () => config.sessionStart.historyLimit,
        (v) => (config.sessionStart.historyLimit = v),
      ),
      numberItem(
        'Session Context',
        'Ready limit',
        'Reserved setting for ready-task display limit',
        () => config.sessionStart.readyLimit,
        (v) => (config.sessionStart.readyLimit = v),
      ),
      boolItem(
        'Session Context',
        'Quickstart hint',
        'Tell agent to run trekker quickstart when needed',
        () => config.sessionStart.includeQuickstartHint,
        (v) => (config.sessionStart.includeQuickstartHint = v),
      ),

      modeItem(
        'Workflow Safety',
        'Strictness',
        'Overall safety posture',
        ['off', 'guide', 'prompt', 'block'] as const,
        () => config.workflow.strictness,
        (v) => (config.workflow.strictness = v),
      ),
      modeItem(
        'Workflow Safety',
        'One in-progress',
        'Policy for multiple in-progress tasks',
        ['off', 'guide', 'prompt', 'block'] as const,
        () => config.workflow.oneInProgressTask,
        (v) => (config.workflow.oneInProgressTask = v),
      ),
      modeItem(
        'Workflow Safety',
        'Search before create',
        'Policy for creating tasks without a recent search',
        ['off', 'guide', 'prompt', 'block'] as const,
        () => config.workflow.requireSearchBeforeCreate,
        (v) => (config.workflow.requireSearchBeforeCreate = v),
      ),
      modeItem(
        'Workflow Safety',
        'Summary before done',
        'Policy for completing tasks without summary',
        ['off', 'prompt', 'block'] as const,
        () => config.workflow.requireSummaryBeforeDone,
        (v) => (config.workflow.requireSummaryBeforeDone = v),
      ),

      modeItem(
        'Checkpointing',
        'Mode',
        'Checkpoint creation behavior',
        ['off', 'manual', 'prompt', 'auto'] as const,
        () => config.checkpoint.mode,
        (v) => (config.checkpoint.mode = v),
      ),
      boolItem(
        'Checkpointing',
        'Before compact',
        'Prompt before session compaction',
        () => config.checkpoint.onCompact,
        (v) => (config.checkpoint.onCompact = v),
      ),
      boolItem(
        'Checkpointing',
        'Before shutdown',
        'Prompt before Pi exits',
        () => config.checkpoint.onShutdown,
        (v) => (config.checkpoint.onShutdown = v),
      ),
      boolItem(
        'Checkpointing',
        'Before switch',
        'Prompt before session switch',
        () => config.checkpoint.onSessionSwitch,
        (v) => (config.checkpoint.onSessionSwitch = v),
      ),
      boolItem(
        'Checkpointing',
        'Before fork',
        'Prompt before fork/clone',
        () => config.checkpoint.onFork,
        (v) => (config.checkpoint.onFork = v),
      ),

      boolItem(
        'Plan Mode',
        'Protections',
        'Enable plan-mode write/edit guards',
        () => config.planMode.enabled,
        (v) => (config.planMode.enabled = v),
      ),
      stringItem(
        'Plan Mode',
        'Plans directory',
        'Allowed directory for plan files',
        () => config.planMode.plansDir,
        (v) => (config.planMode.plansDir = v || DEFAULT_CONFIG.planMode.plansDir),
      ),
      boolItem(
        'Plan Mode',
        'Allow plan writes',
        'Permit writes inside plans directory',
        () => config.planMode.allowPlanWrites,
        (v) => (config.planMode.allowPlanWrites = v),
      ),
      boolItem(
        'Plan Mode',
        'Block implementation writes',
        'Block edit/write outside plans directory',
        () => config.planMode.blockImplementationWrites,
        (v) => (config.planMode.blockImplementationWrites = v),
      ),
      boolItem(
        'Plan Mode',
        'Block risky shell',
        'Block bash commands that appear to mutate files',
        () => config.planMode.blockRiskyShellWrites,
        (v) => (config.planMode.blockRiskyShellWrites = v),
      ),

      boolItem('Subtasks', 'Enabled', 'Use Trekker subtasks as durable agent todos', () => config.subtasks.enabled, (v) => (config.subtasks.enabled = v)),
      boolItem('Subtasks', 'Inject context', 'Include subtask checklist before agent starts', () => config.subtasks.injectContext, (v) => (config.subtasks.injectContext = v)),
      boolItem('Subtasks', 'Footer progress', 'Show subtask progress in footer', () => config.subtasks.footerProgress, (v) => (config.subtasks.footerProgress = v)),
      boolItem('Subtasks', 'Editor widget', 'Show subtask checklist near the editor', () => config.subtasks.editorWidget, (v) => (config.subtasks.editorWidget = v)),
      boolItem('Subtasks', 'Auto-load', 'Load active task subtasks on session start', () => config.subtasks.autoLoadOnSessionStart, (v) => (config.subtasks.autoLoadOnSessionStart = v)),
      modeItem('Subtasks', 'Require for writes', 'Policy when implementation starts without subtasks', ['off', 'guide', 'prompt', 'block'] as const, () => config.subtasks.requireForImplementation, (v) => (config.subtasks.requireForImplementation = v)),
      modeItem('Subtasks', 'One in-progress', 'Policy for multiple active subtasks', ['off', 'guide', 'prompt', 'block'] as const, () => config.subtasks.oneInProgressSubtask, (v) => (config.subtasks.oneInProgressSubtask = v)),
      boolItem('Subtasks', 'Complete parent', 'Prompt to complete parent when all subtasks are done', () => config.subtasks.promptToCompleteParent, (v) => (config.subtasks.promptToCompleteParent = v)),
      numberItem('Subtasks', 'Max widget items', 'Maximum subtasks shown in editor widget', () => config.subtasks.maxWidgetItems, (v) => (config.subtasks.maxWidgetItems = v)),

      boolItem(
        'UI',
        'Footer status',
        'Show Trekker state in footer',
        () => config.ui.footerStatus,
        (v) => (config.ui.footerStatus = v),
      ),
      boolItem(
        'UI',
        'Editor widget',
        'Show a plan-mode banner near the editor',
        () => config.ui.editorWidget,
        (v) => (config.ui.editorWidget = v),
      ),
      boolItem(
        'UI',
        'Rich feedback',
        'Show notifications when context, tools, checkpoints, and dashboard state change',
        () => config.ui.richFeedback,
        (v) => (config.ui.richFeedback = v),
      ),
      boolItem(
        'UI',
        'Dashboard detection',
        'Probe for trekker-dashboard',
        () => config.ui.dashboardDetection,
        (v) => (config.ui.dashboardDetection = v),
      ),
      stringItem(
        'UI',
        'Dashboard URL',
        'Primary dashboard URL to probe/show',
        () => config.ui.dashboardUrl,
        (v) => (config.ui.dashboardUrl = v || DEFAULT_CONFIG.ui.dashboardUrl),
      ),

      boolItem(
        'Agent Tools',
        'Enable tools',
        'Expose Trekker tools to the model',
        () => config.tools.enabled,
        (v) => (config.tools.enabled = v),
      ),
      boolItem(
        'Agent Tools',
        'Mutating tools',
        'Allow create/update/comment tools',
        () => config.tools.mutatingTools,
        (v) => (config.tools.mutatingTools = v),
      ),
      boolItem(
        'Agent Tools',
        'Read-only while planning',
        'Disable mutating tools in plan mode',
        () => config.tools.readOnlyWhenPlanning,
        (v) => (config.tools.readOnlyWhenPlanning = v),
      ),
    ];

    const saveToProject = () => {
      const file = projectSettingsPath(ctx.cwd, runtime.root);
      writeConfigToSettings(file, config);
      feedback(ctx, 'settings', `Saved Trekker settings to ${file}.`);
    };
    const saveToUser = () => {
      const file = agentSettingsPath();
      writeConfigToSettings(file, config);
      feedback(ctx, 'settings', `Saved Trekker settings to ${file}.`);
    };

    while (true) {
      const action = await ctx.ui.select('Trekker Settings', [
        'Edit settings',
        'Save project settings',
        'Save user settings',
        'Reset session defaults',
        'Close',
      ]);

      if (!action || action === 'Close') break;
      if (action === 'Save project settings') {
        saveToProject();
        continue;
      }
      if (action === 'Save user settings') {
        saveToUser();
        continue;
      }
      if (action === 'Reset session defaults') {
        config = cloneConfig(DEFAULT_CONFIG);
        saveConfig();
        feedback(ctx, 'settings', 'Reset Trekker settings to defaults for this session.');
        continue;
      }

      const sections = [...new Set(buildItems().map((item) => item.section))];
      const section = await ctx.ui.select('Choose settings section', [...sections, 'Back']);
      if (!section || section === 'Back') continue;

      while (true) {
        const items = buildItems().filter((item) => item.section === section);
        const labels = items.map((item) => `${item.label}: ${item.value()}`);
        const choice = await ctx.ui.select(section, [...labels, 'Back']);
        if (!choice || choice === 'Back') break;
        const index = labels.indexOf(choice);
        if (index < 0) continue;
        const item = items[index];
        await item.edit();
        saveConfig();
        feedback(ctx, 'settings', `${item.label}: ${item.value()}\n${item.detail}`);
      }
    }

    await refreshState(ctx);
    await probeDashboard();
    updateActiveToolsForState();
    updateFooter(ctx);
    updatePlanModeUi(ctx);
  }

  function toolAllowed(mutating = false): { ok: boolean; reason?: string } {
    if (!config.enabled) return { ok: false, reason: 'pi-trekker is disabled.' };
    if (!config.tools.enabled) return { ok: false, reason: 'Trekker agent tools are disabled.' };
    if (config.requireProjectTrekker && runtime.state !== 'active')
      return { ok: false, reason: 'No active .trekker project is available.' };
    if (!runtime.root) return { ok: false, reason: 'No Trekker root available.' };
    if (
      mutating &&
      (!config.tools.mutatingTools ||
        (config.tools.readOnlyWhenPlanning && isPlanModeActive(pi, config)))
    )
      return { ok: false, reason: 'Trekker mutating tools are disabled in the current mode.' };
    return { ok: true };
  }

  async function runTool(ctx: ExtensionContext, args: string[], mutating = false) {
    const allowed = toolAllowed(mutating);
    if (!allowed.ok) return makeToolResult(allowed.reason ?? 'Trekker unavailable');
    try {
      const output = await runTrekker(pi, runtime.root!, args, ctx.signal);
      return makeToolResult(
        output || `Ran trekker ${args.join(' ')}`,
        ['trekker', ...args],
        runtime.root ?? undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        looksLocked(message)
          ? 'Trekker database is locked. Ask the user whether to retry or continue without Trekker.'
          : message,
      );
    }
  }

  async function runToolToon(ctx: ExtensionContext, args: string[], kind: 'list' | 'ready' | 'search' | 'history' | 'show', title?: string) {
    const allowed = toolAllowed(false);
    if (!allowed.ok) return makeToolResult(allowed.reason ?? 'Trekker unavailable');
    try {
      const result = await runTrekkerToon(pi, runtime.root!, args, ctx.signal);
      return makeToonToolResult(result, ['trekker', ...toon(args)], runtime.root ?? undefined, renderToon(result.parsed, kind, title));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        looksLocked(message)
          ? 'Trekker database is locked. Ask the user whether to retry or continue without Trekker.'
          : message,
      );
    }
  }

  pi.registerTool({
    name: 'trekker_search',
    label: 'Trekker Search',
    description:
      'Search Trekker tasks/comments using the CLI. Requires an active .trekker project.',
    promptSnippet: 'Search persistent Trekker task memory for prior work and duplicate tasks.',
    promptGuidelines: [
      'Use trekker_search before creating Trekker tasks or starting substantial project work.',
    ],
    parameters: Type.Object({
      query: Type.String(),
      type: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['search', params.query];
      if (params.type) args.push('--type', params.type);
      if (params.status) args.push('--status', params.status);
      if (params.limit) args.push('--limit', String(params.limit));
      runtime.lastSearchAt = Date.now();
      return runToolToon(ctx, args, 'search');
    },
  });
  pi.registerTool({
    name: 'trekker_list',
    label: 'Trekker List',
    description: 'List Trekker items using the unified list view.',
    parameters: Type.Object({
      type: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['list'];
      if (params.type) args.push('--type', params.type);
      if (params.status) args.push('--status', params.status);
      if (params.priority) args.push('--priority', params.priority);
      if (params.limit) args.push('--limit', String(params.limit));
      return runToolToon(ctx, args, 'list');
    },
  });
  pi.registerTool({
    name: 'trekker_ready',
    label: 'Trekker Ready',
    description: 'List unblocked Trekker tasks ready to work on.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      return runToolToon(ctx, ['ready'], 'ready');
    },
  });
  pi.registerTool({
    name: 'trekker_history',
    label: 'Trekker History',
    description: 'Show recent Trekker audit history.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      entity: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['history', '--limit', String(params.limit ?? config.sessionStart.historyLimit)];
      if (params.entity) args.push('--entity', params.entity);
      return runToolToon(ctx, args, 'history');
    },
  });
  pi.registerTool({
    name: 'trekker_show',
    label: 'Trekker Show',
    description: 'Show a Trekker task or epic by id.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return runToolToon(
        ctx,
        [params.id.startsWith('EPIC-') ? 'epic' : 'task', 'show', params.id],
        'show',
        params.id,
      );
    },
  });
  pi.registerTool({
    name: 'trekker_comments',
    label: 'Trekker Comments',
    description: 'List comments for a Trekker task.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return runToolToon(ctx, ['comment', 'list', params.id], 'list', `Comments for ${params.id}`);
    },
  });
  pi.registerTool({
    name: 'trekker_subtask_list',
    label: 'Trekker Subtask List',
    description: 'List Trekker subtasks for a parent task.',
    promptSnippet: 'List durable Trekker subtasks used as agent todo items for an active task.',
    promptGuidelines: ['Use trekker_subtask_list before beginning implementation of an active Trekker task.'],
    parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const taskId = params.taskId ?? runtime.activeTaskId;
      if (!taskId) return makeToolResult('No active Trekker task. Pass taskId.');
      const result = await runToolToon(ctx, ['subtask', 'list', taskId], 'list', `Subtasks for ${taskId}`);
      await refreshSubtasks(ctx, taskId);
      updateFooter(ctx);
      updateSubtaskUi(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_subtask_create',
    label: 'Trekker Subtask Create',
    description: 'Create a Trekker subtask under a parent task.',
    promptGuidelines: ['Use trekker_subtask_create only after the user approves creating durable subtasks.'],
    parameters: Type.Object({ taskId: Type.String(), title: Type.String(), description: Type.Optional(Type.String()), priority: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['subtask', 'create', params.taskId, '-t', params.title];
      if (params.description) args.push('-d', params.description);
      if (params.priority !== undefined) args.push('-p', String(params.priority));
      const result = await runTool(ctx, args, true);
      await refreshSubtasks(ctx, params.taskId);
      updateFooter(ctx);
      updateSubtaskUi(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_subtask_update',
    label: 'Trekker Subtask Update',
    description: 'Update a Trekker subtask status/title/description/priority.',
    parameters: Type.Object({ id: Type.String(), taskId: Type.Optional(Type.String()), status: Type.Optional(Type.String()), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), priority: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['subtask', 'update', params.id];
      if (params.status) args.push('-s', params.status);
      if (params.title) args.push('-t', params.title);
      if (params.description) args.push('-d', params.description);
      if (params.priority !== undefined) args.push('-p', String(params.priority));
      const result = await runTool(ctx, args, true);
      await refreshSubtasks(ctx, params.taskId ?? runtime.subtasksLoadedForTaskId ?? runtime.activeTaskId);
      updateFooter(ctx);
      updateSubtaskUi(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_subtask_start',
    label: 'Trekker Subtask Start',
    description: 'Mark a Trekker subtask in_progress and refresh subtask UI.',
    promptGuidelines: ['Mark exactly one Trekker subtask in_progress while actively working.'],
    parameters: Type.Object({ id: Type.String(), taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await runTool(ctx, ['subtask', 'update', params.id, '-s', 'in_progress'], true);
      await refreshSubtasks(ctx, params.taskId ?? runtime.subtasksLoadedForTaskId ?? runtime.activeTaskId);
      updateFooter(ctx);
      updateSubtaskUi(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_subtask_complete',
    label: 'Trekker Subtask Complete',
    description: 'Mark a Trekker subtask completed and refresh subtask UI.',
    promptGuidelines: ['Mark a Trekker subtask completed only after the corresponding implementation and validation are done.'],
    parameters: Type.Object({ id: Type.String(), taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await runTool(ctx, ['subtask', 'update', params.id, '-s', 'completed'], true);
      await refreshSubtasks(ctx, params.taskId ?? runtime.subtasksLoadedForTaskId ?? runtime.activeTaskId);
      updateFooter(ctx);
      updateSubtaskUi(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_add_comment',
    label: 'Trekker Add Comment',
    description: 'Add a comment to a Trekker task.',
    parameters: Type.Object({ id: Type.String(), content: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return runTool(
        ctx,
        ['comment', 'add', params.id, '-a', config.agentName, '-c', params.content],
        true,
      );
    },
  });
  pi.registerTool({
    name: 'trekker_create_task',
    label: 'Trekker Create Task',
    description: 'Create a Trekker task after search-first policy checks.',
    promptGuidelines: [
      'Use trekker_create_task only after trekker_search confirms no existing task covers the work.',
    ],
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      priority: Type.Optional(Type.Number()),
      epicId: Type.Optional(Type.String()),
      tags: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (
        config.workflow.requireSearchBeforeCreate === 'block' &&
        Date.now() - runtime.lastSearchAt > 10 * 60_000
      )
        return makeToolResult('Blocked: run trekker_search before creating a task.');
      const args = ['task', 'create', '-t', params.title, '-d', params.description];
      if (params.priority !== undefined) args.push('-p', String(params.priority));
      if (params.epicId) args.push('-e', params.epicId);
      if (params.tags) args.push('--tags', params.tags);
      return runTool(ctx, args, true);
    },
  });
  pi.registerTool({
    name: 'trekker_update_task',
    label: 'Trekker Update Task',
    description: 'Update Trekker task status/title/description/priority.',
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['task', 'update', params.id];
      if (params.status) args.push('-s', params.status);
      if (params.title) args.push('-t', params.title);
      if (params.description) args.push('-d', params.description);
      if (params.priority !== undefined) args.push('-p', String(params.priority));
      const result = await runTool(ctx, args, true);
      await refreshState(ctx);
      return result;
    },
  });
  pi.registerTool({
    name: 'trekker_create_epic',
    label: 'Trekker Create Epic',
    description: 'Create a Trekker epic.',
    parameters: Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const args = ['epic', 'create', '-t', params.title];
      if (params.description) args.push('-d', params.description);
      if (params.priority !== undefined) args.push('-p', String(params.priority));
      return runTool(ctx, args, true);
    },
  });
  pi.registerTool({
    name: 'trekker_add_dependency',
    label: 'Trekker Add Dependency',
    description: 'Add a dependency between Trekker tasks.',
    parameters: Type.Object({ id: Type.String(), dependsOn: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return runTool(ctx, ['dep', 'add', params.id, params.dependsOn], true);
    },
  });
  pi.registerTool({
    name: 'trekker_complete_task',
    label: 'Trekker Complete Task',
    description: 'Add a summary comment and mark a Trekker task completed.',
    promptGuidelines: [
      'Use trekker_complete_task only with a meaningful summary of changes and files touched.',
    ],
    parameters: Type.Object({ id: Type.String(), summary: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!params.summary.trim())
        return makeToolResult('Blocked: completion requires a summary comment.');
      await runTool(
        ctx,
        ['comment', 'add', params.id, '-a', config.agentName, '-c', params.summary],
        true,
      );
      const result = await runTool(ctx, ['task', 'update', params.id, '-s', 'completed'], true);
      await refreshState(ctx);
      return result;
    },
  });
}
