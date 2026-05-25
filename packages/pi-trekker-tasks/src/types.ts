// ── Types ──────────────────────────────────────────────────────────────────────

/** Trekker-native task status. */
export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'wont_fix' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'lowest';

export interface Task {
  id: string; // TREK-N or TREK-N-SUB-N or EPIC-N
  content: string; // trekker: title
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  parentId?: string; // trekker: parentTaskId
  epicId?: string;
  tags?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Status mapping ─────────────────────────────────────────────────────────────

export type TrekkerPriority = 0 | 1 | 2 | 3 | 4 | 5;

export function mapPriority(p: number): TaskPriority {
  if (p <= 0) return 'urgent';
  if (p <= 1) return 'high';
  if (p <= 3) return 'medium';
  if (p <= 4) return 'low';
  return 'lowest';
}

export function unmapPriority(p: TaskPriority): number {
  if (p === 'urgent') return 0;
  if (p === 'high') return 1;
  if (p === 'medium') return 2;
  if (p === 'low') return 4;
  return 5;
}

// ── Epic types ─────────────────────────────────────────────────────────────────

/** Trekker-native epic status. */
export type EpicStatus = 'todo' | 'in_progress' | 'completed' | 'archived';

export interface Epic {
  id: string;
  title: string;
  description?: string;
  status: EpicStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
}

// ── Visual constants ───────────────────────────────────────────────────────────

export const STATUS_ICON: Record<TaskStatus, string> = {
  todo: '○',
  in_progress: '●',
  completed: '✓',
  wont_fix: '✗',
  archived: '✗',
};

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
};
