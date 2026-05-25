/**
 * pi-trek Plan Mode
 *
 * Plan mode is a toggle that constrains the agent to exploration and Trekker
 * operations only — no file writes or edits. The agent explores the codebase,
 * writes a structured plan, gets user approval, creates Trekker entities
 * (epic → tasks → subtasks), then exits plan mode.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _active = false;
let _topic: string | undefined;

/**
 * Check whether plan mode is currently active.
 */
export function isPlanModeActive(): boolean {
  return _active;
}

/**
 * Get the optional topic that was passed when entering plan mode.
 */
export function getPlanModeTopic(): string | undefined {
  return _topic;
}

/**
 * Toggle plan mode on/off. Returns the new state.
 * When activating, optionally store a topic for context.
 */
export function setPlanMode(active: boolean, topic?: string): boolean {
  _active = active;
  _topic = active ? topic : undefined;
  return _active;
}

/**
 * Return the context block to inject into LLM messages when plan mode is active.
 */
export function planModeContextBlock(): string {
  if (!_active) return '';
  const topicLine = _topic ? `Topic: "${_topic}"` : 'No topic specified — infer from context or ask the user.';
  return [
    '╔═══════════════════════════════════════════════════════════╗',
    '║  PLAN MODE — ACTIVE  (file writes are BLOCKED)            ║',
    '╚═══════════════════════════════════════════════════════════╝',
    '',
    topicLine,
    '',
    'You MUST follow this exact workflow. Do not skip steps.',
    '',
    '━━━ PHASE 1 — EXPLORE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Before writing anything:',
    '  • Run trekker_search to check if a related epic or tasks already exist.',
    '  • Read the relevant source files, configs, and tests.',
    '  • Understand the current state: what exists, what is missing, what needs changing.',
    '  • Do NOT ask the user questions yet — gather facts first.',
    '',
    '━━━ PHASE 2 — DRAFT PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Write your plan in the conversation using this exact format:',
    '',
    '  ## Plan: <title>',
    '  <1-2 sentence summary of what this accomplishes and why>',
    '',
    '  ### Epic',
    '  Title: <concise epic title>',
    '  Priority: <critical|high|medium|low>',
    '',
    '  ### Tasks',
    '  Each task = a self-contained unit of work (1-4 hours). List them in dependency order.',
    '',
    '  1. <Task title>',
    '     What: <what will be implemented>',
    '     Why: <why this is needed>',
    '     Where: <which files or components>',
    '     Subtasks:',
    '       - <subtask title>',
    '       - <subtask title>',
    '',
    '  2. <Task title>',
    '     ...',
    '',
    '━━━ PHASE 3 — GET APPROVAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'After writing the plan, ask the user EXACTLY this question:',
    '',
    '  Does this plan look right? You can:',
    '   • Say [proceed] to create Trekker tasks now',
    '   • Say [interview] and I will ask clarifying questions first',
    '   • Edit the plan inline and say [proceed]',
    '   • Say [cancel] to exit plan mode without creating tasks',
    '',
    'If the user says **interview**:',
    '  1. Ask up to 3 focused clarifying questions (one message, numbered list).',
    '  2. Revise the plan based on their answers.',
    '  3. Show the updated plan and ask the approval question again.',
    '',
    '━━━ PHASE 4 — CREATE TREKKER ENTITIES ━━━━━━━━━━━━━━━━━━━━━',
    'Only after the user approves — create entities in this exact order:',
    '',
    '  Step 1: trekker_create_epic',
    '          → title, description (summary from plan), priority',
    '          → SAVE the returned epic id (e.g., EPIC-5)',
    '',
    '  Step 2: For each task in the plan, call trekker_create_task',
    '          → title, description (What/Why/Where from plan), epic_id=<saved id>',
    '          → SAVE each returned task id',
    '',
    '  Step 3: For each subtask, call trekker_create_task',
    '          → title, parent_id=<saved parent task id>, epic_id=<saved epic id>',
    '',
    '  After all calls succeed, confirm to the user:',
    '    Created <EPIC-N> with <N> tasks. Run /trek-plan to exit plan mode,',
    '    then /trek-execute <EPIC-N> to start implementing.',
    '',
    '  If the user says **cancel**: tell them to run /trek-plan to exit plan mode.',
    '',
    '━━━ CONSTRAINTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '  ✗ No file edits or writes (hard blocked by the extension)',
    '  ✗ No git commits, no package installs',
    '  ✓ Read-only bash (cat, ls, grep, find, git log/diff/status) is fine',
    '  ✓ All trekker_* tools are fine',
    '  ✓ Asking the user questions is fine',
    '',
    '╔═══════════════════════════════════════════════════════════╗',
    '║  What phase are you in? Start with PHASE 1 if unsure.    ║',
    '╚═══════════════════════════════════════════════════════════╝',
  ].join('\n');
}
