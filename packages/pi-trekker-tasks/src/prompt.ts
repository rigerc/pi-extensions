import type { TrekkerStore } from './trekker-store.js';
import { PRIORITY_ORDER } from './types.js';

function priorityLabel(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export async function buildSystemPromptBlock(store: TrekkerStore): Promise<string> {
  const active = store.activeTasks();
  if (active.length === 0) return '';

  const lines: string[] = [
    '## Active Trekker Tasks',
    '',
    'You have the following tasks tracked in trekker. Search before creating, set tasks to in_progress before work, add checkpoint/summary comments, and use TaskComplete when done:',
    '',
  ];

  const inProg = active.filter((t) => t.status === 'in_progress');
  const todo = active
    .filter((t) => t.status === 'todo')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  for (const t of [...inProg, ...todo]) {
    const icon = t.status === 'in_progress' ? '●' : '○';
    const pLabel = `[${priorityLabel(t.priority)}]`;
    const suffix = t.status === 'in_progress' ? '  ← in progress' : '';
    const parent = t.parentId ? ` [subtask of ${t.parentId}]` : '';
    const tags = t.tags ? ` [${t.tags}]` : '';
    lines.push(`${icon} [${t.id}] ${pLabel} ${t.content}${suffix}${parent}${tags}`);
  }

  for (const t of inProg.slice(0, 3)) {
    try {
      const comments = await store.listComments(t.id);
      const recent = comments.slice(-3);
      if (recent.length > 0) {
        lines.push('', `Recent comments for ${t.id}:`);
        for (const c of recent) {
          lines.push(`- ${c.content.replace(/\s+/g, ' ').slice(0, 180)}`);
        }
      }
    } catch {
      // Prompt context is best-effort; task tools still expose full comments.
    }
  }

  try {
    const ready = (await store.ready()).slice(0, 5);
    if (ready.length > 0) {
      lines.push('', 'Ready tasks:');
      for (const t of ready) {
        lines.push(`○ [${t.id}] [${priorityLabel(t.priority)}] ${t.content}`);
      }
    }
  } catch {
    // Ignore prompt enrichment failures.
  }

  try {
    const history = await store.history({ limit: 3 });
    if (history) {
      lines.push('', 'Recent Trekker history:', history);
    }
  } catch {
    // Ignore prompt enrichment failures.
  }

  const all = store.list();
  const doneCount = all.filter((t) => t.status === 'completed').length;
  if (doneCount > 0) {
    lines.push('', `${doneCount}/${all.length} tasks completed.`);
  }

  return lines.join('\n');
}

export function formatListForLLM(store: TrekkerStore): string {
  const tasks = store.list();
  if (tasks.length === 0) return 'No tasks found.';
  return tasks
    .map((t) => {
      const icon = t.status === 'in_progress' ? '●' : t.status === 'completed' ? '✓' : '○';
      return `${icon} [${priorityLabel(t.priority)}] [${t.id}] ${t.content}`;
    })
    .join('\n');
}
