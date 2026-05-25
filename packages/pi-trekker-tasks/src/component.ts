import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TrekkerTasksConfig } from "./config.js";
import { saveConfig } from "./config.js";
import { priorityColor, priorityLabel, renderTaskListResult } from "./state.js";
import type { Task, Epic } from "./types.js";
import { PRIORITY_ORDER } from "./types.js";
import type { TrekkerStore } from "./trekker-store.js";

// ── /trekker-tasks viewer ─────────────────────────────────────────────────────

export class TrekkerTasksViewComponent {
  private cursorIndex = 0;
  private showCompleted = true;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private flatTasks: Task[] = [];
  /** Epic headers are visual separators only — not navigable. */
  private readonly epicHeaders: Epic[];

  constructor(
    private readonly tasks: Task[],
    private readonly theme: any,
    private readonly onClose: () => void,
    epics?: Epic[],
  ) {
    this.epicHeaders = epics ?? [];
    this.rebuildFlatTasks();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      if (this.cursorIndex > 0) this.cursorIndex--;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      if (this.cursorIndex < this.flatTasks.length - 1) this.cursorIndex++;
      this.invalidate();
      return;
    }
    if (data === "c") {
      this.showCompleted = !this.showCompleted;
      this.rebuildFlatTasks();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.flatTasks.length - 1));
      this.invalidate();
      return;
    }
    if (matchesKey(data, "home") || data === "g") {
      this.cursorIndex = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "end") || data === "G") {
      this.cursorIndex = Math.max(0, this.flatTasks.length - 1);
      this.invalidate();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    const titleText = " Trekker Tasks ";
    const sideLen = Math.max(0, width - titleText.length - 3);
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", th.bold(titleText)) +
          th.fg("borderMuted", "─".repeat(sideLen)),
        width,
      ),
    );
    lines.push("");

    if (this.tasks.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No tasks. Create one with TaskCreate or trekker task create.")}`,
          width,
        ),
      );
    } else {
      const completedCount = this.tasks.filter((t) => t.status === "completed").length;
      const total = this.tasks.length;
      const barWidth = Math.min(20, width - 22);
      const filled = total > 0 ? Math.round((completedCount / total) * barWidth) : 0;
      const bar = `[${th.fg("success", "█".repeat(filled))}${th.fg("dim", "░".repeat(barWidth - filled))}]`;
      const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
      lines.push(
        truncateToWidth(
          `  ${bar}  ${th.fg("muted", `${completedCount}/${total}`)} ${th.fg("dim", `(${pct}%)`)}`,
          width,
        ),
      );
      lines.push("");

      this.renderGrouped(this.tasks, lines, width);
    }

    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(width)), width));
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ navigate  •  c toggle completed  •  esc close")}`, width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderTask(task: Task, width: number, flatIdx: number): string[] {
    const th = this.theme;
    const isFocused = flatIdx === this.cursorIndex;

    const icon =
      task.status === "completed"
        ? th.fg("success", "✓")
        : task.status === "in_progress"
          ? th.fg("accent", "●")
          : th.fg("dim", "○");

    const pColor = priorityColor(task.priority);
    const pLabel = th.fg(pColor, priorityLabel(task.priority));

    const contentText =
      task.status === "completed"
        ? th.fg("dim", th.strikethrough(task.content))
        : task.status === "in_progress"
          ? th.fg("text", th.bold(task.content))
          : th.fg("muted", task.content);

    const idHint = th.fg("dim", ` [${task.id}]`);
    const epicHint = task.epicId ? th.fg("dim", ` [${task.epicId}]`) : "";
    const cursor = isFocused ? th.fg("accent", "❯") : " ";

    return [truncateToWidth(`  ${cursor} ${icon} ${pLabel}  ${contentText}${idHint}${epicHint}`, width)];
  }

  /** Render tasks grouped by epic. Within each epic, sort by status then priority. */
  private renderGrouped(tasks: Task[], lines: string[], width: number): void {
    const th = this.theme;

    // Group tasks by epicId
    const tasksByEpic = new Map<string, Task[]>();
    const noEpicTasks: Task[] = [];
    for (const t of tasks) {
      if (t.epicId) {
        const group = tasksByEpic.get(t.epicId) ?? [];
        group.push(t);
        tasksByEpic.set(t.epicId, group);
      } else {
        noEpicTasks.push(t);
      }
    }

    // Order epics by status: in_progress → pending → completed → deleted
    const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, failed: 3, deleted: 4 };
    const orderedEpics = [...this.epicHeaders].sort(
      (a, b) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0),
    );

    let flatIdx = 0;

    // Render each epic group
    for (const epic of orderedEpics) {
      const epicTasks = tasksByEpic.get(epic.id);
      if (!epicTasks?.length) continue;

      const sorted = this.sortTasks(epicTasks);
      const epicIcon =
        epic.status === "completed"
          ? th.fg("success", "✓")
          : epic.status === "in_progress"
            ? th.fg("accent", "●")
            : th.fg("dim", "○");
      lines.push(
        truncateToWidth(
          `  ${epicIcon} ${th.bold(th.fg("accent", epic.title))} ${th.fg("dim", `(${sorted.length})`)}`,
          width,
        ),
      );
      for (const t of sorted) { lines.push(...this.renderTask(t, width, flatIdx++)); }
      lines.push("");
    }

    // Render unassigned tasks
    if (noEpicTasks.length > 0) {
      const sorted = this.sortTasks(noEpicTasks);
      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", th.bold("Unassigned"))} ${th.fg("dim", `(${sorted.length})`)}`,
          width,
        ),
      );
      for (const t of sorted) { lines.push(...this.renderTask(t, width, flatIdx++)); }
      lines.push("");
    }
  }

  /** Sort tasks by status (in_progress → pending → completed), then by priority. */
  private sortTasks(tasks: Task[]): Task[] {
    const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, failed: 3, deleted: 4 };
    return [...tasks].sort((a, b) => {
      const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      if (so !== 0) return so;
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    });
  }

  private rebuildFlatTasks(): void {
    // Only tasks (not epic headers) are navigable
    const sorted = this.sortTasks(
      this.showCompleted
        ? this.tasks
        : this.tasks.filter((t) => t.status !== "completed"),
    );
    this.flatTasks = sorted;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  static renderTaskResult(tasks: Task[], expanded: boolean, theme: any, epics?: Epic[]): any {
    return renderTaskListResult(tasks, expanded, theme, epics);
  }
}

// ── Epic status helpers ───────────────────────────────────────────────────────

function epicIcon(status: string): string {
  if (status === "completed") return "✔";
  if (status === "in_progress") return "◼";
  return "◻";
}

// ── Settings panel ────────────────────────────────────────────────────────────

async function openSettings(
  ui: any,
  cfg: TrekkerTasksConfig,
  cwd: string,
): Promise<void> {
  await ui.custom((_tui: any, theme: any, _kb: any, done: (r: undefined) => void) => {
    const items: SettingItem[] = [
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: stay visible. on_list_complete: hide when all done. " +
          "on_task_complete: each task hides shortly after completing. " +
          "Tasks are only hidden from the widget, not deleted from trekker.",
        currentValue: cfg.autoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete"],
      },
    ];

    const list = new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      (id, newValue) => {
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TrekkerTasksConfig["autoClearCompleted"];
          saveConfig(cwd, cfg);
        }
      },
      () => done(undefined),
    );

    class SettingsPanel extends Container {
      handleInput(data: string) { list.handleInput(data); }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Trekker Tasks Settings")), 0, 0));
    root.addChild(new Spacer(1));
    root.addChild(list);
    return root;
  });
}

// ── /trekker-tasks command ────────────────────────────────────────────────────

export async function openTrekkerTasksMenu(
  ui: any,
  store: TrekkerStore,
  cfg: TrekkerTasksConfig,
  cwd: string,
  onTaskUpdate: () => void,
): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const tasks = store.list();
    const epics = await store.listEpics();
    const completedCount = tasks.filter((t) => t.status === "completed").length;

    const epicLabel = epics.length > 0 ? `, ${epics.length} epic${epics.length > 1 ? "s" : ""}` : "";
    const choices: string[] = [`View tasks (${tasks.length}${epicLabel})`];
    if (completedCount > 0) choices.push(`Hide completed from widget (${completedCount})`);
    choices.push("⚙ Settings");

    const choice = await ui.select("Trekker Tasks", choices);
    if (!choice) return;

    if (choice.startsWith("View")) {
      return viewTasks();
    } else if (choice.startsWith("Hide completed")) {
      store.clearCompleted();
      onTaskUpdate();
      return mainMenu();
    } else if (choice.startsWith("⚙")) {
      await openSettings(ui, cfg, cwd);
      return mainMenu();
    }
  };

  const taskIcon = (status: string) => {
    if (status === "completed") return "✔";
    if (status === "in_progress") return "◼";
    return "◻";
  };

  const viewTasks = async (): Promise<void> => {
    const tasks = store.list();
    const epics = await store.listEpics();

    if (tasks.length === 0 && epics.length === 0) {
      await ui.select("No tasks", ["← Back"]);
      return mainMenu();
    }

    const choices: string[] = [];

    // Add epics as group headers
    for (const e of epics) {
      const taskCount = tasks.filter((t) => t.epicId === e.id).length;
      choices.push(`━━ ${epicIcon(e.status)} ${e.id} ${e.title} (${taskCount} tasks)`);
      // Add tasks under this epic
      for (const t of tasks.filter((t) => t.epicId === e.id)) {
        choices.push(`  ${taskIcon(t.status)} ${t.id} [${t.status}] ${t.content}`);
      }
      choices.push(""); // separator
    }

    // Add unassigned tasks
    const unassigned = tasks.filter((t) => !t.epicId);
    if (unassigned.length > 0) {
      choices.push(`━━ ◻ Unassigned (${unassigned.length})`);
      for (const t of unassigned) {
        choices.push(`  ${taskIcon(t.status)} ${t.id} [${t.status}] ${t.content}`);
      }
    }

    choices.push("← Back");

    const selected = await ui.select("Tasks", choices);
    if (!selected || selected === "← Back" || selected === "") return mainMenu();

    const match = selected.match(/\b(TREK-\d+(?:-[A-Z]+-\d+)?|EPIC-\d+)\b/i);
    if (match) return viewTaskDetail(match[1].toUpperCase());
    return viewTasks();
  };

  const viewTaskDetail = async (taskId: string): Promise<void> => {
    const task = store.get(taskId);
    if (!task) return viewTasks();

    const actions: string[] = [];
    if (task.status === "pending") actions.push("▸ Start (in_progress)");
    if (task.status === "in_progress") actions.push("✓ Complete");
    actions.push("← Back");

    const detail =
      `${task.id} [${task.status}] ${task.content}` +
      (task.description ? `\n${task.description}` : "") +
      (task.epicId ? `\nEpic: ${task.epicId}` : "");

    const action = await ui.select(detail, actions);

    if (action === "▸ Start (in_progress)") {
      await store.update(taskId, { status: "in_progress" });
      onTaskUpdate();
      return viewTasks();
    } else if (action === "✓ Complete") {
      await store.update(taskId, { status: "completed" });
      onTaskUpdate();
      return viewTasks();
    }
    return viewTasks();
  };

  await mainMenu();
}
