// ── Types ──────────────────────────────────────────────────────────────────────

/** edb-todo-compatible status, mapped from trekker's native statuses. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted';
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

export type TrekkerStatus = 'todo' | 'in_progress' | 'completed' | 'wont_fix' | 'archived';
export type TrekkerPriority = 0 | 1 | 2 | 3 | 4 | 5;

export function mapStatus(s: TrekkerStatus): TaskStatus {
  if (s === 'todo') return 'pending';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  if (s === 'wont_fix') return 'failed';
  return 'deleted'; // archived
}

export function unmapStatus(s: TaskStatus): TrekkerStatus {
  if (s === 'pending') return 'todo';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'wont_fix';
  return 'archived'; // deleted
}

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

/** Epics use the same priority/status model as tasks (archived → deleted). */
export type EpicStatus = TaskStatus;

export interface Epic {
  id: string;
  title: string;
  description?: string;
  status: EpicStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
}

export type TrekkerEpicStatus = 'todo' | 'in_progress' | 'completed' | 'archived';

export function mapEpicStatus(s: TrekkerEpicStatus): EpicStatus {
  if (s === 'todo') return 'pending';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  return 'deleted'; // archived
}

export function unmapEpicStatus(s: EpicStatus): TrekkerEpicStatus {
  if (s === 'pending') return 'todo';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  return 'archived';
}

// ── Visual constants ───────────────────────────────────────────────────────────

export const STATUS_ICON: Record<TaskStatus, string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
  failed: '✗',
  deleted: '✗',
};

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
};
