import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TrekkerTasksConfig {
  /** Auto-clear completed tasks from widget. Default: "on_list_complete" */
  autoClearCompleted?: 'never' | 'on_list_complete' | 'on_task_complete';
}

export function loadConfig(cwd: string): TrekkerTasksConfig {
  try {
    return JSON.parse(readFileSync(join(cwd, '.pi', 'trekker-tasks-config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(cwd: string, config: TrekkerTasksConfig): void {
  const path = join(cwd, '.pi', 'trekker-tasks-config.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
