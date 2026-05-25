/**
 * pi-trek-commit — Trekker Worktree Discipline for Pi
 *
 * - Detects `trekker ... -s completed` / `trekker epic complete` and prompts
 *   the agent to git commit using Conventional Commits.
 * - Warns if no summary comment preceded the completion.
 * - Blocks `trekker ... -s in_progress` when the git worktree is dirty.
 * - Disables itself when trekker CLI or `.trekker/` is absent.
 * - Injects a `trekker quickstart` reference into the system prompt (first turn
 *   only, avoiding automatic execution).
 *
 * Standalone — no dependency on pi-trek. Works with any `trekker` CLI setup.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Conventional Commits types for the injected message. */
const CONVENTIONAL_TYPES = [
  "feat", "fix", "chore", "docs", "refactor",
  "test", "perf", "ci", "build", "style",
];

/** Trekker entity ID regex: TREK-N, TREK-N-SUB-N, EPIC-N. */
const ID_RE = /\b(TREK-\d+(?:-[A-Z]+-\d+)?|EPIC-\d+)\b/i;

/**
 * Parse `trekker comment add <task-id> ...` to extract the task ID.
 * Returns the ID or null if not a comment-add command.
 */
function parseTrekkerComment(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!/\btrekker\b/.test(cmd)) return null;
  if (!/\bcomment\s+add\b/.test(trimmed)) return null;

  const idMatch = trimmed.match(ID_RE);
  return idMatch ? idMatch[1].toUpperCase() : null;
}

/**
 * Parse a trekker command that marks something completed.
 * Handles:
 *   trekker task update    <id> -s completed
 *   trekker subtask update  <id> -s completed
 *   trekker epic update     <id> -s completed
 *   trekker epic complete   <id>
 *
 * Returns `{ id, entity }` or null. `entity` is "task", "subtask", or "epic".
 */
function parseTrekkerCompleted(cmd: string): { id: string; entity: string } | null {
  const trimmed = cmd.trim();
  if (!/\btrekker\b/.test(cmd)) return null;

  // ── Epic complete (dedicated command) ──────────────────────────
  if (/\bepic\s+complete\b/.test(trimmed)) {
    const idMatch = trimmed.match(ID_RE);
    if (idMatch) {
      return { id: idMatch[1].toUpperCase(), entity: "epic" };
    }
    return null;
  }

  // ── update -s completed (task / subtask / epic) ────────────────
  if (!trimmed.includes("-s completed")) return null;

  const idMatch = trimmed.match(ID_RE);
  if (!idMatch) return null;

  const id = idMatch[1].toUpperCase();
  let entity: string;
  if (/\bsubtask\b/.test(trimmed)) {
    entity = "subtask";
  } else if (/\bepic\b/.test(trimmed)) {
    entity = "epic";
  } else {
    entity = "task";
  }

  return { id, entity };
}

/**
 * Parse `trekker ... -s in_progress` to extract the task ID.
 * Returns the ID or null if not an in_progress status change.
 */
function parseTrekkerStarted(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!/\btrekker\b/.test(cmd)) return null;
  if (!trimmed.includes("-s in_progress")) return null;

  const idMatch = trimmed.match(ID_RE);
  return idMatch ? idMatch[1].toUpperCase() : null;
}

/** Build the commit-prompt user message. */
function buildCommitMessage(id: string, entity: string, hasComment: boolean): string {
  const entityLabel = entity === "epic" ? "Epic" : entity === "subtask" ? "Subtask" : "Task";
  const typesList = CONVENTIONAL_TYPES.join(", ");

  const lines: string[] = [];

  lines.push(`⏏ Trekker ${entityLabel.toLowerCase()} \`${id}\` marked completed.`);

  if (!hasComment) {
    lines.push("");
    lines.push(
      `⚠ No summary comment was added for \`${id}\` before marking it completed. ` +
      `Consider adding one first:`,
    );
    lines.push(`\`\`\``);
    lines.push(`trekker comment add ${id} -a "pi" -c "Summary: ..."`);
    lines.push(`\`\`\``);
  }

  lines.push("");
  lines.push(`Remember to commit your changes using **Conventional Commits** format:`);
  lines.push("");
  lines.push("```");
  lines.push(`git add -A && git commit -m '<type>: ${id} — <brief description>'`);
  lines.push("```");
  lines.push("");
  lines.push(`Common types: ${typesList}.`);
  lines.push("Choose the one that best describes what the task accomplished.");

  return lines.join("\n");
}

interface TrekTaskRow { id: string; title: string; priority: number; status: string; isEpic?: boolean; }

/**
 * Parse trekker --toon list output into task rows.
 *
 * Handles two formats emitted by different trekker commands:
 *
 * CSV format (`trekker task list --toon`):
 *   items[N]{id,title,priority,status,...}:
 *     TREK-1,"title",1,in_progress,...
 *
 * YAML-list format (`trekker ready --toon`):
 *   items[N]:
 *     - id: TREK-1
 *       title: Some title
 *       priority: 1
 *       status: todo
 */
function parseToonTaskList(stdout: string): TrekTaskRow[] {
  const lines = stdout.split("\n");
  const rows: TrekTaskRow[] = [];

  // ── detect format by finding the list header ──────────────────────
  let csvFields: string[] | null = null;
  let yamlMode = false;
  let cur: Partial<TrekTaskRow> | null = null;

  const flush = () => {
    if (cur?.id) rows.push({ id: cur.id, title: cur.title ?? "", priority: cur.priority ?? 2, status: cur.status ?? "" });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // CSV header: items[N]{id,title,...}:
    const csvHeader = line.match(/^\s*\w+\[\d+\]\{(.+?)\}:\s*$/);
    if (csvHeader) {
      flush();
      csvFields = csvHeader[1].split(",").map((f) => f.trim());
      yamlMode = false;
      continue;
    }

    // YAML header: items[N]:  (no {fields})
    if (/^\s*\w+\[\d+\]:\s*$/.test(line)) {
      flush();
      csvFields = null;
      yamlMode = true;
      continue;
    }

    // ── CSV rows ──────────────────────────────────────────────────────
    if (csvFields) {
      const trimmed = line.trimStart();
      if (!trimmed || line.length === trimmed.length) { csvFields = null; continue; }
      const values: string[] = [];
      let tok = ""; let inQ = false;
      for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '"') { if (inQ && trimmed[i + 1] === '"') { tok += '"'; i++; } else { inQ = !inQ; } }
        else if (ch === "," && !inQ) { values.push(tok); tok = ""; }
        else { tok += ch; }
      }
      values.push(tok);
      const rec: Record<string, string> = {};
      csvFields.forEach((f, i) => { rec[f] = (values[i] ?? "").trim(); });
      rows.push({ id: rec["id"] ?? "", title: rec["title"] ?? "", priority: parseInt(rec["priority"] ?? "2", 10), status: rec["status"] ?? "" });
      continue;
    }

    // ── YAML-list rows ────────────────────────────────────────────────
    if (yamlMode) {
      // New item: "  - id: TREK-X"
      const itemStart = line.match(/^\s+-\s+id:\s+(\S+)/);
      if (itemStart) { flush(); cur = { id: itemStart[1] }; continue; }
      if (!cur) continue;
      // Key-value inside item: "    key: value"
      const kv = line.match(/^\s+(\w+):\s+(.*)/);
      if (!kv) continue;
      const [, key, val] = kv;
      const v = val.trim().replace(/^"|"$/g, "");
      if (key === "title") cur.title = v;
      else if (key === "priority") cur.priority = parseInt(v, 10) || 2;
      else if (key === "status") cur.status = v;
    }
  }

  flush();
  return rows;
}

/** Parse a single-entity TOON output (flat key: value pairs) into a TrekTaskRow. */
function parseToonSingleTask(stdout: string): TrekTaskRow | null {
  const fields: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const kv = raw.trim().match(/^(\w+):\s+(.*)/);
    if (!kv) continue;
    fields[kv[1]] = kv[2].trim().replace(/^"|"$/g, "");
  }
  if (!fields["id"]) return null;
  return {
    id: fields["id"],
    title: fields["title"] ?? "",
    priority: parseInt(fields["priority"] ?? "2", 10) || 2,
    status: fields["status"] ?? "todo",
  };
}

/**
 * Parse any `trekker (task|subtask|epic) update <id> -s <status>` command.
 * Returns { id, status } or null.
 */
function parseTrekkerStatusUpdate(cmd: string): { id: string; status: string } | null {
  const trimmed = cmd.trim();
  if (!/\btrekker\b/.test(cmd)) return null;
  // trekker epic complete <id>
  if (/\bepic\s+complete\b/.test(trimmed)) {
    const idMatch = trimmed.match(ID_RE);
    return idMatch ? { id: idMatch[1].toUpperCase(), status: "completed" } : null;
  }
  if (!/\b(task|subtask|epic)\s+update\b/.test(trimmed)) return null;
  const idMatch = trimmed.match(ID_RE);
  const statusMatch = trimmed.match(/-s\s+(\w+)/);
  if (!idMatch || !statusMatch) return null;
  return { id: idMatch[1].toUpperCase(), status: statusMatch[1] };
}

/** Build the ingest-workflow message sent to the agent. */
function buildIngestMessage(input: string): string {
  return [
    "Activate the `trekker` skill and ingest the following into Trekker tasks.",
    "",
    "## Input",
    "```",
    input.trim(),
    "```",
    "",
    "## Planning Workflow",
    "",
    "### Step 1: Search for Related Work",
    "```bash",
    "# ALWAYS search first - previous work may exist",
    'trekker search "<what you\'re about to do>"',
    "```",
    "",
    "### Step 2: Create Epic (if substantial)",
    "For features with multiple tasks:",
    "```bash",
    'trekker epic create -t "Feature: <title>" \\',
    '  -d "<brief description of the feature>"',
    "```",
    "",
    "### Step 3: Break Down into Tasks",
    "Create atomic, completable tasks:",
    "```bash",
    "# Each task should be independently completable",
    'trekker task create -t "<task title>" \\',
    '  -d "<what to implement>" \\',
    "  -e EPIC-1 -p 1",
    "```",
    "",
    "### Step 4: Set Dependencies",
    "Make execution order explicit:",
    "```bash",
    "# Task B depends on Task A",
    "trekker dep add TREK-2 TREK-1",
    "```",
  ].join("\n");
}

/** Build the implement-workflow message sent to the agent. */
function buildImplementMessage(id?: string): string {
  if (!id) {
    return [
      "Use the `trekker` skill to find and implement the next ready task.",
      "",
      "### Step 1: List Ready Tasks",
      "```bash",
      "trekker task list --status ready",
      "```",
      "Pick the highest-priority unblocked task, then follow the steps below.",
      "",
      ...implementSteps(),
    ].join("\n");
  }

  const isEpic = /^EPIC-/i.test(id);
  const entityCmd = isEpic ? "epic" : "task";

  return [
    `Use the \`trekker\` skill to implement \`${id.toUpperCase()}\`.`,
    "",
    "### Step 1: Load Details",
    "```bash",
    `trekker ${entityCmd} get ${id.toUpperCase()}`,
    ...(isEpic ? [`trekker task list -e ${id.toUpperCase()}`] : []),
    "```",
    "",
    ...implementSteps(id.toUpperCase(), isEpic),
  ].join("\n");
}

function implementSteps(id?: string, isEpic = false): string[] {
  const taskId = id && !isEpic ? id : "<TREK-ID>";
  const epicId = id && isEpic ? id : "<EPIC-ID>";

  return [
    "### Step 2: Check Dependencies",
    "Ensure all blocking tasks are completed before starting.",
    "",
    "### Step 3: Mark In Progress",
    "```bash",
    `trekker task update ${taskId} -s in_progress`,
    "```",
    "Only one task `in_progress` at a time.",
    "",
    "### Step 4: Implement",
    "Do the work. If unexpected work surfaces, add subtasks:",
    "```bash",
    `trekker subtask create -t "<title>" -k ${taskId} -d "<description>"`,
    "```",
    "",
    "### Step 5: Checkpoint Comment",
    "```bash",
    `trekker comment add ${taskId} -a "pi" -c "Implemented: ..."`,
    "```",
    "",
    "### Step 6: Mark Completed",
    "```bash",
    `trekker task update ${taskId} -s completed`,
    "```",
    "A commit prompt will follow automatically.",
    ...(isEpic
      ? [
          "",
          "### Step 7: Repeat for Each Task",
          "Work through all tasks top-to-bottom, then close the epic:",
          "```bash",
          `trekker epic update ${epicId} -s completed`,
          "```",
        ]
      : []),
  ];
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── Extension-wide state ──────────────────────────────────────────────
  let enabled = false;
  let cwd = "";
  let uiCtx: ExtensionUIContext | null = null;
  // Task IDs that received a comment this turn
  let commentedThisTurn = new Set<string>();
  // Track whether we've already injected the trekker quickstart hint
  let trekkerHintInjected = false;

  // ── Session task state + widget ───────────────────────────────────────

  let sessionTasks: TrekTaskRow[] = [];
  let sessionRootId: string | null = null;
  let dbWatcher: FSWatcher | null = null;
  let dbDebounce: ReturnType<typeof setTimeout> | null = null;

  const TASK_BOX: Record<string, string> = {
    completed:   "[x]",
    in_progress: "[~]",
    wont_fix:    "[-]",
    archived:    "[-]",
  };

  function renderSessionWidget(): void {
    if (!uiCtx || !sessionTasks.length) return;
    const epics = sessionTasks.filter((t) => t.isEpic);
    const tasks = sessionTasks.filter((t) => !t.isEpic);
    const lines = [...epics, ...tasks].map((t) => {
      const box = TASK_BOX[t.status] ?? "[ ]";
      const indent = t.isEpic ? "" : "  ";
      return `${indent}${box} ${t.id.padEnd(12)}${t.title.slice(0, 60)}`;
    });
    uiCtx.setWidget("trekker-tasks", lines);
  }

  async function refreshSessionWidget(): Promise<void> {
    if (!sessionRootId) return;
    sessionTasks = await loadSessionTasks(sessionRootId);
    const allDone = sessionTasks.length > 0 && sessionTasks.every(
      (t) => t.status === "completed" || t.status === "wont_fix" || t.status === "archived",
    );
    if (allDone) {
      uiCtx?.setWidget("trekker-tasks", undefined);
      sessionTasks = [];
      sessionRootId = null;
    } else {
      renderSessionWidget();
    }
  }

  function startDbWatcher(): void {
    const dbPath = join(cwd, ".trekker", "trekker.db");
    if (!existsSync(dbPath) || dbWatcher) return;
    dbWatcher = watch(dbPath, () => {
      if (dbDebounce) clearTimeout(dbDebounce);
      dbDebounce = setTimeout(() => void refreshSessionWidget(), 150);
    });
  }

  function stopDbWatcher(): void {
    if (dbDebounce) { clearTimeout(dbDebounce); dbDebounce = null; }
    if (dbWatcher) { dbWatcher.close(); dbWatcher = null; }
  }

  async function fetchTrekTasks(status: string): Promise<TrekTaskRow[]> {
    try {
      const args = status === "ready"
        ? ["ready", "--toon"]
        : ["task", "list", "-s", status, "--toon"];
      const result = await pi.exec("trekker", args);
      if (result.code !== 0) return [];
      return parseToonTaskList(result.stdout);
    } catch { return []; }
  }

  async function fetchEpics(status: string): Promise<TrekTaskRow[]> {
    try {
      const result = await pi.exec("trekker", ["epic", "list", "-s", status, "--toon"]);
      if (result.code !== 0) return [];
      return parseToonTaskList(result.stdout).map((e) => ({ ...e, isEpic: true }));
    } catch { return []; }
  }

  async function fetchSelectableTasks(): Promise<{ id: string; label: string }[]> {
    const [epicProgress, epicTodo, taskProgress, taskReady] = await Promise.all([
      fetchEpics("in_progress"),
      fetchEpics("todo"),
      fetchTrekTasks("in_progress"),
      fetchTrekTasks("ready"),
    ]);
    const epics = [...epicProgress, ...epicTodo];
    const tasks = [...taskProgress, ...taskReady];
    return [
      ...epics.map((e) => ({ id: e.id, label: `◈ ${e.id}  ${e.title.slice(0, 53)}  [P${e.priority}]` })),
      ...tasks.map((t) => ({ id: t.id, label: `  ${t.id}  ${t.title.slice(0, 53)}  [P${t.priority}]` })),
    ];
  }

  async function loadSessionTasks(id: string): Promise<TrekTaskRow[]> {
    const isEpic = /^EPIC-/i.test(id);
    try {
      if (isEpic) {
        const [epicRes, tasksRes] = await Promise.all([
          pi.exec("trekker", ["epic", "show", id, "--toon"]),
          pi.exec("trekker", ["task", "list", "-e", id, "--toon"]),
        ]);
        const epic = epicRes.code === 0 ? parseToonSingleTask(epicRes.stdout) : null;
        const tasks = tasksRes.code === 0 ? parseToonTaskList(tasksRes.stdout) : [];
        return [
          ...(epic ? [{ ...epic, id: id.toUpperCase(), isEpic: true }] : []),
          ...tasks,
        ];
      }
      const result = await pi.exec("trekker", ["task", "show", id, "--toon"]);
      if (result.code !== 0) return [];
      const task = parseToonSingleTask(result.stdout);
      if (!task) return [];
      // Also fetch the parent epic if this task belongs to one
      const epicId = result.stdout.match(/^\s*epicId:\s+(\S+)/m)?.[1];
      if (!epicId || epicId === "null") return [task];
      const epicRes = await pi.exec("trekker", ["epic", "show", epicId, "--toon"]);
      const epic = epicRes.code === 0 ? parseToonSingleTask(epicRes.stdout) : null;
      return [
        ...(epic ? [{ ...epic, id: epicId.toUpperCase(), isEpic: true }] : []),
        task,
      ];
    } catch { return []; }
  }

  // ── session_start — availability check + optional init + quickstart ─
  pi.on("session_start", async (event, ctx) => {
    cwd = ctx.cwd;

    const hasDb = existsSync(join(cwd, ".trekker", "trekker.db"));

    // Happy path: trekker is already set up
    if (hasDb) {
      enabled = true;
      uiCtx = ctx.ui;
      startDbWatcher();
      return;
    }

    // No .trekker/ — check if trekker CLI is on PATH.
    // Uses `command -v` (POSIX). Note: pi.exec returns `.code`, not `.exitCode`.
    let cliAvailable = false;
    try {
      const cliCheck = await pi.exec("sh", ["-c", "command -v trekker"]);
      cliAvailable = cliCheck.code === 0 && cliCheck.stdout.trim().length > 0;
    } catch {
      cliAvailable = false;
    }

    if (!cliAvailable) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-trek-commit: trekker CLI not found on PATH, and no .trekker/ folder exists. Extension disabled.",
          "warning",
        );
      }
      enabled = false;
      return;
    }

    // CLI is available but no .trekker/ — offer to init interactively
    if (ctx.hasUI) {
      const wantsInit = await ctx.ui.confirm(
        "Initialize Trekker?",
        "No .trekker/ folder found in this project. " +
        "Run `trekker init` to set up persistent task tracking?",
      );

      if (wantsInit) {
        try {
          await pi.exec("trekker", ["init"]);
          ctx.ui.notify("Trekker initialized.", "info");
          enabled = true;
          uiCtx = ctx.ui;
          startDbWatcher();


        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`pi-trek-commit: trekker init failed: ${msg}`, "error");
          enabled = false;
        }
      } else {
        ctx.ui.notify(
          "pi-trek-commit: .trekker/ not initialized. Extension disabled.",
          "warning",
        );
        enabled = false;
      }
    } else {
      // Non-interactive — can't prompt, just notify and disable
      ctx.ui.notify(
        "pi-trek-commit: trekker CLI found but no .trekker/ folder exists (non-interactive session, cannot prompt for init). Extension disabled.",
        "warning",
      );
      enabled = false;
    }
  });

  // ── session_shutdown — clean up db watcher ────────────────────────
  pi.on("session_shutdown", () => {
    stopDbWatcher();
  });

  // ── before_agent_start — inject trekker reference into system prompt ─
  // Uses the system prompt instead of sendUserMessage so the agent sees
  // trekker as available background knowledge rather than an action to
  // execute immediately.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || trekkerHintInjected) return;
    trekkerHintInjected = true;

    const trekkerHint =
      "\n\n## Trekker Task Management (available)\n" +
      "Trekker CLI is available for persistent issue tracking. " +
      "Tasks are stored in `.trekker/trekker.db` and survive context resets. " +
      "The `trekker` skill has full usage guidance. " +
      "Run `trekker quickstart` to see the complete command reference.\n";

    return { systemPrompt: event.systemPrompt + trekkerHint };
  });

  // ── turn_start — reset per-turn comment tracking ───────────────────
  pi.on("turn_start", () => {
    commentedThisTurn = new Set<string>();
  });

  // ── tool_call — block -s in_progress on dirty worktree ────────────
  pi.on("tool_call", async (event) => {
    if (!enabled) return;
    if (event.toolName !== "bash") return;

    const cmd: string = (event.input as any)?.command ?? "";
    if (!cmd) return;

    const taskId = parseTrekkerStarted(cmd);
    if (!taskId) return;
    if (!/^EPIC-/i.test(taskId)) return;

    // Check for uncommitted changes
    try {
      const gitStatus = await pi.exec("git", ["status", "--porcelain"]);
      if (gitStatus.stdout.trim()) {
        const dirtyFiles = gitStatus.stdout.trim().split("\n").slice(0, 15).join("\n");
        const more = gitStatus.stdout.trim().split("\n").length > 15
          ? `\n  ... and ${gitStatus.stdout.trim().split("\n").length - 15} more`
          : "";

        return {
          block: true,
          reason:
            `Cannot start \`${taskId}\` — the working tree has uncommitted changes. ` +
            `Commit or stash them first to keep a clean worktree per task.\n\n` +
            `Dirty files:\n${dirtyFiles}${more}\n\n` +
            `Suggestion: run \`git add -A && git commit -m "<type>: <description>"\` ` +
            `for the previous task, or \`git stash\` to temporarily shelve changes.`,
        };
      }
    } catch {
      // If git status fails (e.g. not a git repo), allow the command
    }
  });

  // ── tool_result — track comments + detect completions ─────────────
  pi.on("tool_result", async (event) => {
    if (!enabled) return;
    if (event.toolName !== "bash") return;

    const cmd: string = (event.input as any)?.command ?? "";
    if (!cmd) return;

    // ── Track comment additions (only on success) ───────────────
    if (!event.isError) {
      const commentTarget = parseTrekkerComment(cmd);
      if (commentTarget) {
        commentedThisTurn.add(commentTarget);
        return;
      }
    }

    // ── Detect completions for commit prompt (only on success) ──
    if (event.isError) return;
    const completed = parseTrekkerCompleted(cmd);
    if (!completed) return;

    const hasComment = commentedThisTurn.has(completed.id);
    const message = buildCommitMessage(completed.id, completed.entity, hasComment);
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  });

  // ── /trekker-ingest — convert a query or file into Trekker tasks ──
  pi.registerCommand("trekker-ingest", {
    description: "Ingest a query or file into Trekker tasks using the trekker skill",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!enabled) {
        ctx.ui.notify("pi-trek-commit: trekker not available — cannot ingest.", "error");
        return;
      }
      const trimmed = args?.trim() ?? "";
      if (!trimmed) {
        ctx.ui.notify("Usage: /trekker-ingest <query or file path>", "warning");
        return;
      }
      let input = trimmed;
      if (existsSync(trimmed)) {
        input = readFileSync(trimmed, "utf-8");
      }
      pi.sendUserMessage(buildIngestMessage(input), { deliverAs: "followUp" });
    },
  });

  // ── /trekker-implement — implement a task or epic ──────────────────
  pi.registerCommand("trekker-implement", {
    description: "Implement a Trekker task or epic using the trekker skill",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!enabled) {
        ctx.ui.notify("pi-trek-commit: trekker not available — cannot implement.", "error");
        return;
      }
      const id = args?.trim() || undefined;
      if (!id) {
        ctx.ui.setStatus("pi-trek", "Loading tasks...");
        const tasks = await fetchSelectableTasks();
        ctx.ui.setStatus("pi-trek");
        if (!tasks.length) {
          ctx.ui.notify("No ready or in_progress tasks found.", "warning");
          return;
        }
        const options = tasks.map((t) => t.label);
        const chosen = await ctx.ui.select("Select task to implement", options);
        if (!chosen) return;
        const chosenId = tasks.find((t) => t.label === chosen)?.id;
        if (!chosenId) return;
        sessionRootId = chosenId;
        sessionTasks = await loadSessionTasks(chosenId);
        renderSessionWidget();
        pi.sendUserMessage(buildImplementMessage(chosenId), { deliverAs: "followUp" });
        return;
      }
      sessionRootId = id;
      sessionTasks = await loadSessionTasks(id);
      renderSessionWidget();
      pi.sendUserMessage(buildImplementMessage(id), { deliverAs: "followUp" });
    },
  });
}
