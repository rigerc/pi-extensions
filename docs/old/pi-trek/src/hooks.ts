/**
 * pi-trek Lifecycle Hooks
 *
 * - session_start: Notify about in_progress tasks
 * - context: Inject active task summary + plan mode context block
 * - tool_call: Guardrails (plan-mode write blocking, no-task nudges)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  listTasks,
  readyTasks,
  checkTrekkerAvailable,
  clearAvailabilityCache,
} from './cli.js';
import { isPlanModeActive, planModeContextBlock } from './plan-mode.js';

// Flag to track if trekker was checked this session
let _trekkerAvailable = false;

/**
 * Register all hooks on the pi extension API.
 */
export function registerHooks(pi: ExtensionAPI): void {
  // ── session_start — Check availability & notify about in_progress tasks ──
  pi.on('session_start', async (_event, ctx) => {
    // Re-check availability each session start
    clearAvailabilityCache();
    _trekkerAvailable = checkTrekkerAvailable(ctx.cwd);

    if (!_trekkerAvailable) {
      ctx.ui.notify(
        'pi-trek: Trekker not available (CLI or .trekker/ missing). Install trekker CLI and run `trekker init`.',
        'warning',
      );
      return;
    }

    // Fetch in_progress tasks (fresh — no caching)
    try {
      const activeTasks = await listTasks({ status: 'in_progress' });
      if (activeTasks.length > 0) {
        const lines = activeTasks.map(
          (t) => `  ${t.id} — ${t.title}${t.epicId ? ` [${t.epicId}]` : ''}`,
        );
        ctx.ui.notify(
          `Active Trekker tasks:\n${lines.join('\n')}`,
          'info',
        );
      }
    } catch {
      // Silently skip — may be first init
    }
  });

  // ── context — Inject active tasks + plan mode context ──────────────
  pi.on('context', async (event, ctx) => {
    if (!_trekkerAvailable) return;

    const blocks: string[] = [];

    // Plan mode context block (injected first, before task summary)
    if (isPlanModeActive()) {
      blocks.push(planModeContextBlock());
    }

    // Active task summary
    try {
      const activeTasks = await listTasks({ status: 'in_progress' });
      if (activeTasks.length > 0) {
        const taskList = activeTasks
          .map((t) => `- ${t.id} (${t.title}) [P${t.priority}]`)
          .join('\n');
        blocks.push(`Active Trekker tasks:\n${taskList}`);
      }
    } catch {
      // Silently skip
    }

    if (blocks.length === 0) return;

    // Prepend the context block so the agent sees it first
    event.messages.unshift({
      role: 'user',
      content: [{ type: 'text', text: blocks.join('\n\n') }],
      timestamp: Date.now(),
    });
  });

  // ── tool_call — Guardrails ──────────────────────────────────────────
  pi.on('tool_call', async (event, ctx) => {
    if (!_trekkerAvailable) return;

    // Guard 1: Plan mode — hard block on file writes
    if (isPlanModeActive()) {
      if (event.toolName === 'edit' || event.toolName === 'write') {
        return {
          block: true,
          reason:
            'Plan mode is active — file writes are blocked. Finish planning and create Trekker tasks first, or exit plan mode with /trek-plan.',
        };
      }
      if (event.toolName === 'bash' && _isWriteCommand(event)) {
        return {
          block: true,
          reason:
            'Plan mode is active — write commands are blocked. Finish planning and create Trekker tasks first, or exit plan mode with /trek-plan.',
        };
      }
      // Allow all other tools in plan mode (read-only bash, trekker tools, etc.)
      return;
    }

    // Guard 2: Before destructive file ops, suggest picking a task
    if (
      (event.toolName === 'bash' || event.toolName === 'edit' || event.toolName === 'write') &&
      !_isReadOnlyCommand(event)
    ) {
      try {
        const activeTasks = await listTasks({ status: 'in_progress' });
        if (activeTasks.length === 0) {
          // No active task — soft nudge
          const ready = await readyTasks();
          if (ready.length > 0) {
            ctx.ui.notify(
              `💡 No task is currently in_progress. Consider picking a task with trekker_update_task first. Ready: ${ready.slice(0, 3).map((t) => `${t.id} (${t.title})`).join(', ')}`,
              'warning',
            );
          } else {
            ctx.ui.notify(
              '💡 No task is in_progress. Use trekker_ready or trekker_create_task to start tracking work.',
              'warning',
            );
          }
        }
      } catch {
        // Silently skip
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: write-detection heuristic for Bash
// ---------------------------------------------------------------------------

/** Commands that are read-only and allowed in plan mode. */
const READ_ONLY_PREFIXES = [
  'cat ', 'ls ', 'head ', 'tail ', 'which ', 'type ',
  'find ', 'grep ', 'rg ', 'ag ', 'ack ', 'tree ',
  'wc ', 'du ', 'df ', 'file ', 'stat ', 'readlink ',
  'git log', 'git diff', 'git status', 'git show', 'git branch',
  'git stash list', 'git reflog', 'git blame',
  'echo', 'pwd', 'date', 'env ',
];

const READ_ONLY_EXACT = [
  'ls', 'pwd', 'date', 'whoami', 'id', 'uname',
  'git status', 'git diff', 'git log',
];

/**
 * Check if a bash command is read-only (ok in plan mode).
 */
function _isReadOnlyCommand(event: { toolName: string; input?: Record<string, unknown> }): boolean {
  if (event.toolName === 'bash') {
    const cmd = ((event.input as any)?.command ?? '') as string;
    const trimmed = cmd.trim();
    for (const exact of READ_ONLY_EXACT) {
      if (trimmed === exact) return true;
    }
    for (const prefix of READ_ONLY_PREFIXES) {
      if (trimmed.startsWith(prefix)) return true;
    }
    // Also allow any command containing "trekker"
    if (trimmed.includes('trekker')) return true;
  }
  return false;
}

/**
 * Check if a bash command is a write/destructive command (blocked in plan mode).
 * Only called for bash — edit/write tools are always blocked.
 */
function _isWriteCommand(event: { toolName: string; input?: Record<string, unknown> }): boolean {
  if (event.toolName === 'bash') {
    const cmd = ((event.input as any)?.command ?? '') as string;
    const trimmed = cmd.trim();

    // If read-only, not a write command
    if (_isReadOnlyCommand({ toolName: 'bash', input: event.input })) return false;

    // Detect write operations
    const writePatterns = [
      '>',      // redirect (write to file)
      '>>',     // append
      'tee',    // write from pipe
      'mkdir', 'touch', 'rmdir',
      'rm ', 'rm -', 'rm /',
      'mv ', 'cp ', 'cp -',
      'chmod', 'chown',
      'git commit', 'git push', 'git add',
      'git merge', 'git rebase', 'git reset',
      'git cherry-pick', 'git stash push',
      'git branch -d', 'git branch -D',
      'git tag',
      'npm install', 'npm i ', 'npm ci',
      'pip install', 'pip3 install',
      'bun install', 'bun add',
      'pnpm install', 'pnpm add',
      'yarn add', 'yarn install',
      'cargo install', 'cargo add',
      'go install', 'go mod',
      'npx ',   // might execute arbitrary code
      'sudo ',  // system changes
      'make',   // typically builds
      'docker ', 'podman ',
      'systemctl', 'service ',
      'ln -s', 'ln ',
      'dd ',
      'tar -', 'unzip ', 'gzip ', 'gunzip ',
    ];

    for (const pattern of writePatterns) {
      if (trimmed.includes(pattern)) return true;
    }
  }
  return false;
}
