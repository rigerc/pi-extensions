/**
 * pi-trek — Trekker Task Management Integration for Pi
 *
 * Entry point that registers all tools, lifecycle hooks, and commands.
 *
 * File Structure:
 *   src/index.ts     — Entry point (this file)
 *   src/cli.ts       — Trekker CLI wrapper (subprocess + --toon parsing)
 *   src/tools.ts     — LLM-callable tool definitions + handlers
 *   src/hooks.ts     — Guardrail / workflow hook handlers
 *   src/plan-mode.ts — Plan mode state management
 *
 * Bundled assets:
 *   skills/trekker/SKILL.md   — Agent workflow guidance
 *   prompts/session-start.md   — Context recovery template
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerAllTools } from './tools.js';
import { registerHooks } from './hooks.js';
import { isPlanModeActive, setPlanMode } from './plan-mode.js';
import {
  checkTrekkerAvailable,
  listTasks,
  readyTasks,
  updateTask,
  getEpic,
  getTask,
  listSubtasks,
  clearAvailabilityCache,
} from './cli.js';

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Register all LLM tools
  registerAllTools(pi);

  // Register all lifecycle hooks
  registerHooks(pi);

  // ── /trek — Show current in_progress & ready tasks ────────────────
  pi.registerCommand('trek', {
    description: 'Show current in_progress and ready Trekker tasks',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!checkTrekkerAvailable(ctx.cwd)) {
        ctx.ui.notify(
          'Trekker not available. Install CLI and run `trekker init` in this project.',
          'error',
        );
        return;
      }

      ctx.ui.setStatus('pi-trek', 'Fetching tasks...');
      try {
        const [activeTasks, ready] = await Promise.all([
          listTasks({ status: 'in_progress' }),
          readyTasks(),
        ]);
        ctx.ui.setStatus('pi-trek', '');

        const modeTag = isPlanModeActive() ? ' [PLAN MODE]' : '';
        const lines: string[] = [];

        if (activeTasks.length > 0) {
          lines.push(`── In Progress${modeTag} ──`);
          for (const t of activeTasks) {
            lines.push(
              `  ${t.id} P${t.priority} — ${t.title}` +
                (t.epicId ? ` (${t.epicId})` : ''),
            );
          }
          lines.push('');
        }

        if (ready.length > 0) {
          lines.push('── Ready ──');
          for (const t of ready) {
            lines.push(`  ${t.id} P${t.priority} — ${t.title}`);
          }
          lines.push('');
        }

        if (lines.length === 0) {
          lines.push(`No active or ready tasks.${modeTag}`);
        }

        lines.push('Commands: /trek-start <id>  /trek-done <id>  /trek-plan  /trek-execute <id>');

        ctx.ui.notify(lines.join('\n'), 'info');
      } catch (err: unknown) {
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `Failed to fetch tasks: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
  });

  // ── /trek-start <id> — Set a task in_progress ─────────────────────
  pi.registerCommand('trek-start', {
    description: 'Set a Trekker task to in_progress. Usage: /trek-start <task-id>',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify('Usage: /trek-start <task-id> (e.g., /trek-start TREK-1)', 'error');
        return;
      }

      if (!checkTrekkerAvailable(ctx.cwd)) {
        ctx.ui.notify('Trekker not available.', 'error');
        return;
      }

      ctx.ui.setStatus('pi-trek', `Starting ${id}...`);
      try {
        const task = await updateTask(id, { status: 'in_progress' });
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `✅ ${task.id} "${task.title}" is now in_progress.`,
          'info',
        );
      } catch (err: unknown) {
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
  });

  // ── /trek-done <id> — Mark a task completed ───────────────────────
  pi.registerCommand('trek-done', {
    description: 'Mark a Trekker task as completed. Usage: /trek-done <task-id>',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify('Usage: /trek-done <task-id> (e.g., /trek-done TREK-1)', 'error');
        return;
      }

      if (!checkTrekkerAvailable(ctx.cwd)) {
        ctx.ui.notify('Trekker not available.', 'error');
        return;
      }

      ctx.ui.setStatus('pi-trek', `Completing ${id}...`);
      try {
        const task = await updateTask(id, { status: 'completed' });
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `✅ ${task.id} "${task.title}" is completed.`,
          'info',
        );
      } catch (err: unknown) {
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
  });

  // ── /trek-plan [topic] — Toggle plan mode ─────────────────────────
  pi.registerCommand('trek-plan', {
    description:
      'Toggle plan mode on/off. In plan mode file writes are blocked — only exploration and Trekker calls allowed. Usage: /trek-plan [topic]',
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (isPlanModeActive()) {
        // Deactivate
        setPlanMode(false);
        ctx.ui.notify(
          'Plan mode OFF — file writes are now allowed.',
          'info',
        );
      } else {
        // Activate
        const topic = args?.trim() || undefined;
        setPlanMode(true, topic);
        ctx.ui.notify(
          topic
            ? `Plan mode ON — topic: "${topic}". File writes are blocked.`
            : 'Plan mode ON — file writes are blocked.',
          'warning',
        );
        const kickoff = topic
          ? `You are now in PLAN MODE. Topic: "${topic}". Begin with PHASE 1 — explore the codebase and run trekker_search to check for existing related work before drafting a plan.`
          : `You are now in PLAN MODE. Begin with PHASE 1 — explore the codebase relevant to what the user wants to build. If the topic is unclear, ask the user one focused question to clarify scope before exploring.`;
        pi.sendUserMessage(kickoff, { deliverAs: 'followUp' });
      }
    },
  });

  // ── /trek-execute <id> — Execute an epic or task ─────────────────
  pi.registerCommand('trek-execute', {
    description:
      'Start executing an epic (EPIC-X) or task (TREK-X). Shows the task tree, starts the first todo task, and sets execution context. Usage: /trek-execute <epic-id|task-id>',
    handler: async (args, ctx: ExtensionCommandContext) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify(
          'Usage: /trek-execute <epic-id|task-id> (e.g., /trek-execute EPIC-1)',
          'error',
        );
        return;
      }

      if (!checkTrekkerAvailable(ctx.cwd)) {
        ctx.ui.notify('Trekker not available.', 'error');
        return;
      }

      const isEpic = id.startsWith('EPIC-') || id.startsWith('epic-');
      ctx.ui.setStatus('pi-trek', `Loading ${id}...`);

      try {
        let treeText: string;
        let entityLabel: string;

        if (isEpic) {
          // ── Epic execution ──
          const epic = await getEpic(id);
          const allTasks = await listTasks({ epic: id });

          // Build task tree with subtasks
          const treeLines: string[] = [];
          treeLines.push(`📋 Epic: ${epic.id} — "${epic.title}" [${epic.status}] P${epic.priority}`);
          if (epic.description) treeLines.push(`   ${epic.description}`);
          treeLines.push('');

          let firstTodoTaskId: string | undefined;

          for (const task of allTasks) {
            const taskMarker = task.status === 'in_progress' ? '▶' : task.status === 'completed' ? '✅' : '○';
            treeLines.push(`  ${taskMarker} ${task.id} [${task.status}] — ${task.title}`);
            if (!firstTodoTaskId && task.status === 'todo') {
              firstTodoTaskId = task.id;
            }
            // Subtasks
            try {
              const subs = await listSubtasks(task.id);
              for (const sub of subs) {
                const subMarker = sub.status === 'in_progress' ? '▶' : sub.status === 'completed' ? '✅' : '○';
                treeLines.push(`    ${subMarker} ${sub.id} [${sub.status}] — ${sub.title}`);
                if (!firstTodoTaskId && sub.status === 'todo') {
                  firstTodoTaskId = sub.id;
                }
              }
            } catch {
              // No subtasks
            }
          }

          treeText = treeLines.join('\n');
          entityLabel = epic.id;

          // Auto-start first todo task
          if (firstTodoTaskId) {
            await updateTask(firstTodoTaskId, { status: 'in_progress' });
            treeText += `\n\n▶ Started: ${firstTodoTaskId} is now in_progress.`;
          } else {
            treeText += '\n\nNo todo tasks to start — all tasks are already in progress or completed.';
          }
        } else {
          // ── Single task execution ──
          const task = await getTask(id);
          const subs = await listSubtasks(id);

          const treeLines: string[] = [];
          const taskMarker = task.status === 'in_progress' ? '▶' : task.status === 'completed' ? '✅' : '○';
          treeLines.push(`📋 Task: ${task.id} — "${task.title}" [${task.status}] P${task.priority}`);
          if (task.description) treeLines.push(`   ${task.description}`);
          if (task.epicId) treeLines.push(`   Epic: ${task.epicId}`);
          treeLines.push('');

          if (subs.length > 0) {
            let firstTodoSubId: string | undefined;
            for (const sub of subs) {
              const subMarker = sub.status === 'in_progress' ? '▶' : sub.status === 'completed' ? '✅' : '○';
              treeLines.push(`  ${subMarker} ${sub.id} [${sub.status}] — ${sub.title}`);
              if (!firstTodoSubId && sub.status === 'todo') {
                firstTodoSubId = sub.id;
              }
            }
            treeText = treeLines.join('\n');
            entityLabel = task.id;

            if (firstTodoSubId) {
              await updateTask(firstTodoSubId, { status: 'in_progress' });
              treeText += `\n\n▶ Started: ${firstTodoSubId} is now in_progress.`;
            }
          } else {
            treeText = treeLines.join('\n');
            entityLabel = task.id;

            if (task.status === 'todo') {
              await updateTask(id, { status: 'in_progress' });
              treeText += `\n\n▶ Started: ${id} is now in_progress.`;
            }
          }
        }

        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(treeText, 'info');

        // Inject execution context via a follow-up user message
        const execGuidance = isEpic
          ? `You are now executing ${entityLabel}. Work through its tasks in order. ` +
            `For each task: mark it in_progress when you start (if not already), add a trekker_comment when you finish (documenting progress), ` +
            `then mark it completed with trekker_update_task. When all tasks are done, update the epic status to completed with trekker_update_epic.`
          : `You are now executing ${entityLabel}. ` +
            `Mark it in_progress when actively working (if not already), add a trekker_comment when you finish, ` +
            `then mark it completed with trekker_update_task. If subtasks exist, work through them top-to-bottom.`;

        pi.sendUserMessage(execGuidance, { deliverAs: 'followUp' });

      } catch (err: unknown) {
        ctx.ui.setStatus('pi-trek', '');
        ctx.ui.notify(
          `Failed to execute ${id}: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
  });

  // ── Clean up on session_shutdown ──────────────────────────────────
  pi.on('session_shutdown', async () => {
    clearAvailabilityCache();
    setPlanMode(false);
  });
}
