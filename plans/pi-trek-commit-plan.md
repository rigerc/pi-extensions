# Plan: `@counterposition/pi-trek-commit` — Trekker Commit Hook

## Package Promise

A standalone Pi extension that detects when the agent runs `trekker ... -s completed`
(via the `bash` tool), parses the task ID from the command, and injects a user
message instructing the agent to `git commit` the completed work.

## Decisions (from user choices)

| Decision | Choice |
|----------|--------|
| Package scope | Standalone (no pi-trek dependency) |
| Commit behavior | Inject a user message (not auto-commit) |
| Detection scope | `-s completed` only (not `-s in_progress`) |
| Surface | Extension only (no skill) |

## Package Shape

```
pi-trek-commit/
├── package.json          # name: @counterposition/pi-trek-commit, version 0.1.0
├── tsconfig.json         # TypeScript config
├── src/
│   └── index.ts          # Single entry point
└── README.md             # What it does, install, limits
```

### `package.json` manifest

```json
{
  "name": "@counterposition/pi-trek-commit",
  "version": "0.1.0",
  "description": "Detects trekker -s completed commands and prompts the agent to git commit",
  "license": "MIT",
  "keywords": ["pi-package"],
  "type": "module",
  "files": ["src/", "README.md"],
  "pi": {
    "extensions": ["./src"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typescript": "^5.9.3"
  }
}
```

### Extension logic (`src/index.ts`)

1. Listen on `tool_result` event
2. Filter: only `toolName === "bash"` and success (non-error)
3. Parse `event.input.command` — the raw command string
4. Match pattern: starts with `trekker` AND contains `-s completed`
5. Extract task ID (e.g., `TREK-1`, `TREK-42`) from the command
6. Inject a user message via `pi.sendUserMessage()`:
   > "Trekker task TREK-1 marked completed. Please commit your changes with
   > `git commit -m 'Trekker: TREK-1 — <brief description>'`."
7. Optionally fetch task details via `trekker task show <id>` to get the title
   for a richer commit message suggestion (stretch — v1 can skip this)

### Command parsing strategy

```typescript
// Parse trekker CLI command like:
//   trekker task update TREK-1 -s completed
//   trekker subtask update TREK-1-SUB-1 -s completed
const cmd = (event.input as any)?.command ?? "";
const trimmed = cmd.trim();
if (!trimmed.startsWith("trekker")) return;
if (!trimmed.includes("-s completed")) return;

// Extract ID: match TREK-* or EPIC-* patterns
const idMatch = trimmed.match(/(TREK-\d+|EPIC-\d+)/i);
const taskId = idMatch ? idMatch[1].toUpperCase() : "unknown";
```

### Injected message format

Uses **Conventional Commits** format (`type(scope): description`). The agent is
expected to pick the appropriate type (`feat`, `fix`, `chore`, `docs`, `refactor`,
`test`, etc.) based on what the task actually was:

```
"⏏ Trekker task {taskId} marked completed. Remember to commit your changes
  using Conventional Commits format:

  `git add -A && git commit -m '<type>: {taskId} — <brief description>'`

  Common types: feat, fix, chore, docs, refactor, test, perf, ci, build.
  Choose the one that best describes the task."
```

## Validation Plan (from pi-package-creator skill)

### Preflight
```bash
python3 - "<package-path>/package.json" <<'PY'
# manifest preflight (see references/validation.md)
PY
```

### Install into temp agent dir
```bash
PI_CODING_AGENT_DIR="$TMP_PI_DIR" pi install ./pi-trek-commit
PI_CODING_AGENT_DIR="$TMP_PI_DIR" pi list | grep pi-trek-commit
```

### Smoke test
```bash
# Start a pi session with the extension and verify it loads
PI_CODING_AGENT_DIR="$TMP_PI_DIR" pi -p "/help" >"$ARTIFACT_DIR/smoke.log"
```

### Mutation test (scratch repo)
```bash
SCRATCH_REPO=$(mktemp -d) && git init "$SCRATCH_REPO"
cd "$SCRATCH_REPO"
# Run pi with the extension and a trekker CLI that outputs -s completed
# Verify the user message is injected and agent can act on it
```

## Implemented (v0.1.0)

- ✅ Detect `trekker task update <id> -s completed`
- ✅ Detect `trekker subtask update <id> -s completed`
- ✅ Detect `trekker epic update <id> -s completed` (#2)
- ✅ Detect `trekker epic complete <id>` (#1)
- ✅ Warn if no `trekker comment add` preceded the completion in the same turn (#3)
- ✅ Block `trekker ... -s in_progress` when git worktree is dirty
- ✅ Disable extension when trekker CLI or `.trekker/` is missing
- ✅ Inject `trekker quickstart` hint on session start
- ✅ Conventional Commits format in the injected message
- ✅ Per-turn comment tracking (resets on `turn_start`)
- ✅ Extension loads cleanly in isolated Pi agent dir
- ✅ 19/19 logic tests pass against quickstart command patterns

## Out of Scope for v1

- Auto-committing (user chose inject message, not auto-commit)
- Detecting `-s in_progress` (user chose completed-only)
- Fetching task title for richer messages (complex — would require trekker CLI available)
- Interacting with `pi-trek` tools (standalone, no dependency)
- A skill file (extension-only surface)
- Publishing to npm (local path install only, state that in README)
