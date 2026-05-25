import type { TrekkerStore } from './trekker-store.js';
import { PRIORITY_ORDER } from './types.js';

function priorityLabel(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function buildSystemPromptBlock(store: TrekkerStore): string {
  const active = store.activeTasks();
  if (active.length === 0) return '';

  const lines: string[] = [
    '## Active Trekker Tasks',
    '',
    'You have the following tasks tracked in trekker. Use TaskCreate / TaskUpdate / TaskComment as you work:',
    '',
  ];

  const inProg = active.filter((t) => t.status === 'in_progress');
  const pending = active
    .filter((t) => t.status === 'pending')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  for (const t of [...inProg, ...pending]) {
    const icon = t.status === 'in_progress' ? '●' : '○';
    const pLabel = `[${priorityLabel(t.priority)}]`;
    const suffix = t.status === 'in_progress' ? '  ← in progress' : '';
    const parent = t.parentId ? ` [subtask of ${t.parentId}]` : '';
    const tags = t.tags ? ` [${t.tags}]` : '';
    lines.push(`${icon} [${t.id}] ${pLabel} ${t.content}${suffix}${parent}${tags}`);
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
