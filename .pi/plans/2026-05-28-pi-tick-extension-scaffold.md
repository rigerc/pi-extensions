---
title: "pi-tick Extension — Scaffold & Tick.db API"
status: draft
created: "2026-05-28T21:52:17.240Z"
type: feature
---

---
title: "pi-tick Extension — Scaffold & Tick.db API"
status: draft
created: "2026-05-28"
type: feature
---

# pi-tick Extension — Scaffold & Tick.db API

## Overview

Create a `@rigerc/pi-tick` Pi extension at `packages/pi-tick/` that reads the
existing `docs/context/tick/` Go project's SQLite schema (`.tick/tick.db`) and
exposes typed CRUD commands and tools inside Pi. The core API layer is
**auto-generated** from the canonical migration SQL files so the TypeScript
surface stays in sync with the database schema without manual duplication.

## Current State

- The `docs/context/tick/` directory houses a Go-based task management tool
  (`github.com/rigerc/tick`) with a full SQLite schema (7 tables + FTS5).
- Database schema is defined in migration SQL files at
  `internal/infra/db/migrations/000001_initial.sql` and `000002_add_refs_project_id.sql`.
- The Go CLI and web server share a single connection (`SetMaxOpenConns(1)`)
  with WAL mode + `busy_timeout = 5000`.
- A REST/Chi API server already exists (`internal/web/`) serving all CRUD at
  `localhost:4782` when `tick web` is running.
- Entity models (`Task`, `Epic`, `Comment`, `Tag`, `Dependency`, `Ref`) are
  defined as Go structs with typed fields.
- The monorepo has two existing Pi packages (pi-skillshare, pi-model-picker)
  with a consistent pattern: `package.json` → `tsconfig.json` → `src/index.ts`.

## Desired End State

- `packages/pi-tick/` is a valid Pi package installable via `pi install`.
- A codegen script reads the migration SQL (or REST API routes) and generates a
  typed client.
- The extension registers slash commands (`/tick-list`, `/tick-create`, etc.)
  and Pi tools for the LLM.
- Users manage tasks through Pi; the DB stays consistent even when the Go CLI
  writes concurrently.

## Out of Scope

- No real-time Sync/SSE from the extension (future).
- No multi-project dashboard support (v1 operates on a single tick project).
- No FTS5 search through the extension; simple SQL LIKE-based search in v1
  (Go's FTS5 search stays on the server side).

---

## DB Access: Two Approaches

There are two valid ways for the extension to reach tick data, each with
different concurrency characteristics. Decide now before building.

### Approach A: Direct SQLite (current plan)

The extension opens `tick.db` directly with `better-sqlite3`.

**Pros:**
- Zero setup beyond having a tick.db file
- Fast (no HTTP overhead)
- Works fully offline
- Simple architecture

**Cons:**
- Concurrent access with Go CLI needs careful handling
- Cannot use Go-side FTS5 search (would need to replicate the index logic)
- Must re-implement ID counter logic
- `better-sqlite3` requires native compilation (C++ addon)

### Approach B: REST API Client (alternative)

The extension sends HTTP requests to the Go `tick web` server at
`http://127.0.0.1:4782/api/...`. The client is auto-generated from the Chi
router definition.

**Pros:**
- Go side owns the DB — no concurrency issues at all
- Full FTS5 search available through the API
- Access to SSE events, multi-project, dashboard config
- No native compilation needed (just `fetch` or undici)

**Cons:**
- Requires `tick web` to be running (daemon dependency)
- HTTP latency on every operation
- User must start the web server manually (or extension auto-starts it)
- Port conflicts / daemon lifecycle management

### Recommendation

**Start with Approach A (direct SQLite)** for the simpler setup, but implement
a thin DB adapter interface so the extension can be swapped to Approach B later
without rewriting commands. The concurrency mitigations in WAL mode are
well-understood and the tick project already uses them.

---

## Concurrency Model: Direct SQLite (Approach A)

### How SQLite WAL mode works

Both the Go CLI and Pi extension's `better-sqlite3` use the **same SQLite
library** and coordinate through the file system. In WAL mode:

| Operation | Lock Type | Blocks | Blocked By |
|-----------|-----------|--------|------------|
| Read (no write) | SHARED | Nothing (multiple readers OK) | A writer at COMMIT time would briefly pause readers |
| Write (first DML) | RESERVED | Other writers | Other RESERVED holders |
| Commit | EXHAUSTIVE (briefly) | Everything | Everything |
| Checkpoint | Various | Depends on mode | Depends on mode |

### Scenario analysis

#### 1. Go CLI writes ↔ Pi extension reads
**Safe.** In WAL mode, the reader gets a snapshot from the WAL that's
consistent as of when the read began. The writer appends to the WAL. Readers
never block writers; writers don't block readers' snapshots.

#### 2. Pi extension writes ↔ Go CLI reads
**Safe.** Same as above — symmetric.

#### 3. Both write simultaneously
**Rare but possible.** SQLite's file-level locking ensures only one writer at
a time. With `busy_timeout = 5000`, the second writer waits up to 5 seconds
for the first to finish. If the first takes longer, `SQLITE_BUSY` is returned.

*In practice*: the Go side uses `defer tx.Rollback()` and wraps each mutation
in a short transaction. The Pi extension will do the same. The write window is
tens of milliseconds — collisions are very unlikely under normal usage.

#### 4. ID counter race
**The real risk.** Both `id_counters.counter` must be updated atomically:
```sql
INSERT INTO id_counters (entity_type, counter) VALUES ('task', 1)
  ON CONFLICT(entity_type) DO UPDATE SET counter = counter + 1
```
If process A reads the counter, then process B reads + increments before A's
transaction commits, A could get the same ID. **Mitigation**: the UPDATE
itself acquires a RESERVED lock. In WAL mode, this blocks the other writer's
UPDATE until the transaction commits. As long as both sides use **explicit
transactions**, this is safe.

### Mitigation strategy (for the extension)

| Concern | Mitigation |
|---------|------------|
| Lock contention | `PRAGMA busy_timeout = 5000` — retry for 5s instead of failing immediately |
| WAL safety | `PRAGMA journal_mode = WAL` — matches the Go side |
| Write atomicity | Wrap all writes in `better-sqlite3`'s `db.transaction()` API |
| Read consistency | Use `readUncommitted = false` (default) — reads see committed data only |
| Stale reads | Document that the Go CLI's uncommitted writes are invisible to the extension |
| ID counter race | Counter increment + read happen inside the same explicit transaction |
| Foreign key integrity | `PRAGMA foreign_keys = ON` — matches Go side |

### What Go tick does (for reference)

```go
// infra/db/sqlite.go
db.SetMaxOpenConns(1)  // single connection serializes all Go goroutines

// core/task/service.go
tx, err := db.BeginTx(ctx, nil)  // deferred transaction (SHARED until first write)
defer tx.Rollback()
// ... writes ...
return tx.Commit()  // acquires EXCLUSIVE briefly
```

### Retry wrapper (for the extension's TickClient)

```typescript
function withRetry<T>(fn: () => T, maxRetries = 5): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      lastError = err;
      if (
        err instanceof Error &&
        (err.message.includes('SQLITE_BUSY') || err.message.includes('locked'))
      ) {
        // Wait geometrically: 100ms, 200ms, 400ms...
        const wait = 100 * Math.pow(2, attempt);
        Atomics.wait(new Int32(new SharedArrayBuffer(4)), 0, 0, wait);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
```

---

## DB Path Resolution

The extension follows the **exact same convention** as the Go CLI:

### Resolution order (in `src/db.ts`)

1. **Explicit override** — `--db-path` flag from the user
2. **Project-local** — `path.join(process.cwd(), '.tick', 'tick.db')` (the default)
3. **Global fallback** — `path.join(os.homedir(), '.tick', 'tick.db')`

### Validation

After opening, the extension validates:
- DB file exists (stat check before opening)
- WAL mode is active (`PRAGMA journal_mode` returns `wal`)
- Required tables exist (`SELECT name FROM sqlite_master WHERE type='table'` — checks for
  `projects`, `tasks`, `epics`, `comments`, `tags`, `dependencies`)
- Project record exists (`SELECT id FROM projects LIMIT 1`)
- Migration version is 2+ (`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`)

If migration version < 2, print a warning to run `tick init` or `tick web`
(which auto-migrates on first open).

### Connection setup

```typescript
import Database from 'better-sqlite3';

export function openTickDb(dbPath?: string): Database.Database {
  const resolved = resolveTickDbPath(dbPath);  // uses priority order above
  const db = new Database(resolved);

  // Mirror Go side's pragmas exactly
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Validate schema
  validateSchema(db, resolved);

  return db;
}
```

---

## Approach

### Architecture (Approach A — Direct SQLite)

```
┌─────────────────────────────────────────┐
│  pi-tick extension (TypeScript)         │
│  ┌─────────────────────────────────────┐│
│  │ src/index.ts                        ││
│  │   └─ pi.registerCommand("/tick...") ││
│  │   └─ pi.registerTool("tick_...")    ││
│  ├─────────────────────────────────────┤│
│  │ src/commands.ts  — command handlers  ││
│  │ src/tools.ts     — Pi tool defs      ││
│  │ src/db.ts        — SQLite connect    ││
│  │ src/retry.ts     — SQLITE_BUSY retry ││
│  ├─────────────────────────────────────┤│
│  │ src/gen/ (auto-generated)            ││
│  │   └─ types.ts    (TS interfaces)     ││
│  │   └─ schemas.ts  (TypeBox schemas)   ││
│  │   └─ client.ts   (TickClient CRUD)   ││
│  └─────────────────────────────────────┘│
├─────────────────────────────────────────┤
│  scripts/tick-codegen.ts                │
│  (reads migration SQL → gen TS)         │
└─────────────────────────────────────────┘
         │ reads/writes (WAL mode, busy_timeout=5000)
         ▼
┌───────────────────────────────────────┐
│  .tick/tick.db                        │  ← same file accessed by
│  (SQLite, WAL journal, foreign_keys)  │      `tick task create ...`
└───────────────────────────────────────┘      `tick web --port 4782`
                                                concurrent reads OK
                                                concurrent writes rare + retried
```

---

## Phase 1: Codegen Script (`scripts/tick-codegen.ts`)

### Changes

- **`scripts/tick-codegen.ts`** — A standalone TypeScript script (runnable with
  `npx tsx`) that:
  1. Reads `docs/context/tick/internal/infra/db/migrations/000001_initial.sql`
     and `000002_add_refs_project_id.sql`.
  2. Parses `CREATE TABLE` statements to extract column names, types, default
     values, nullability, and foreign keys.
  3. Generates three files into `packages/pi-tick/src/gen/`:
     - `types.ts` — TypeScript interfaces (e.g. `Task`, `Epic`, `Comment`, `Tag`,
       `Dependency`, `Project`, `EntityTag`, `HistoryEvent`, `Ref`) with proper
       types (`string`, `number`, `boolean | null`). Include create/update input
       types (`CreateTaskInput`, `UpdateTaskInput`, etc.) matching the Go
       `CreateInput`/`UpdateInput` patterns.
     - `schemas.ts` — TypeBox `Type.Object(...)` schemas for each entity and
       its input DTOs.
     - `client.ts` — A `TickClient` class with methods:
       - `getTask(id)`, `listTasks(opts)`, `createTask(input)`, `updateTask(id, input)`, `deleteTask(id)`
       - `getEpic(id)`, `listEpics(projectID)`, `createEpic(input)`, `updateEpic(id, input)`, `deleteEpic(id)`
       - `getComments(entityType, entityID)`, `addComment(entityType, entityID, input)`
       - `getDependencies(taskID)`, `addDependency(taskID, dependsOnID)`, `deleteDependency(id)`
       - `getTags()`, `setEntityTags(entityType, entityID, tagIDs)`
       - `getProject()` + `ensureProject(name)`
       - `getHistory(entityType?, entityID?)`
       - All methods use `better-sqlite3` prepared statements wrapped in the
         `withRetry()` helper for `SQLITE_BUSY` resilience.
       - All write methods use explicit `db.transaction()` wrappers.

### Codegen parsing approach

- Regex-based `CREATE TABLE` parser targeting the known migration file format.
- For each table, extract: column name, column type (`TEXT`, `INTEGER`, etc.),
  nullable (`NOT NULL` vs implied nullable), default value, primary key flag,
  foreign key references.
- Map SQLite column types to TypeScript: `TEXT` → `string`, `INTEGER` → `number`.
- Add `| null` for nullable columns.
- Generate update DTOs as `Partial<CreateInput>` with all fields optional
  (matching the Go pattern of `*string`, `*int`, etc. for nil-able update fields).

### New dependencies

- **`better-sqlite3`** (runtime) — SQLite driver — pinned to `^11.7.0`.
- **`@types/better-sqlite3`** (dev) — TypeScript types.
- **`typebox`** (runtime, peer with pi) — for tool parameter schemas.
- **`@earendil-works/pi-coding-agent`** (peer) — extension API types.
- **`@earendil-works/pi-tui`** (peer) — for any TUI helpers (optional).

### Verification

- [ ] Run `npx tsx scripts/tick-codegen.ts` — generates 3 files.
- [ ] Generated `types.ts` compiles with `tsc --noEmit`.
- [ ] Generated `schemas.ts` has valid TypeBox objects.
- [ ] Generated `client.ts` has all expected methods with proper types.
- [ ] Spot-check generated types against the Go entity structs.

⏸️ **PAUSE** — Review generated code before Phase 2

---

## Phase 2: DB Connection & TickClient

### Changes

- **`packages/pi-tick/src/db.ts`** — SQLite connection:
  ```typescript
  import Database from 'better-sqlite3';

  export function resolveTickDbPath(override?: string): string {
    if (override) return path.resolve(override);
    const cwdDb = path.join(process.cwd(), '.tick', 'tick.db');
    if (fs.existsSync(cwdDb)) return cwdDb;
    const homeDb = path.join(os.homedir(), '.tick', 'tick.db');
    if (fs.existsSync(homeDb)) return homeDb;
    return cwdDb; // fail with helpful message pointing at tick init
  }

  export function openTickDb(dbPath?: string): Database.Database { ... }
  export function validateSchema(db: Database.Database, path: string): void { ... }
  ```

- **`packages/pi-tick/src/retry.ts`** — `withRetry()` helper for `SQLITE_BUSY`
  with geometric backoff (100ms, 200ms, 400ms, 800ms, 1600ms → ~3s total wait).

- **`packages/pi-tick/src/gen/client.ts`** (generated, refined):
  - `TickClient` constructor takes a connected `Database.Database`.
  - Prepared statements cached per-connection (lazy, on first use).
  - Write methods wrapped in `db.transaction(...)` + `withRetry(...)`.
  - ID generation: read `id_counters` in the same transaction as the INSERT,
    format as `{PREFIX}-{N}` (mirrors Go's `ids.Next`).
  - Each method catches `SQLITE_BUSY` and retries with backoff.

### Verification

- [ ] `openTickDb()` resolves the correct path in all three scenarios (explicit,
  CWD, home).
- [ ] `validateSchema()` passes against a real tick.db, fails with helpful
  message against non-tick DBs.
- [ ] `TickClient.listTasks()` returns typed results from a populated tick.db.
- [ ] `TickClient.createTask()` inserts into a tick.db while Go `tick` CLI is
  also running — no `SQLITE_BUSY` errors under normal usage.
- [ ] `TickClient.getTask('nonexistent')` returns `null` gracefully.
- [ ] Unit test: `withRetry` retries on `SQLITE_BUSY`, throws on other errors.

⏸️ **PAUSE** — Verify DB connectivity before Phase 3

---

## Phase 3: Pi Extension Surface

### Changes

- **`packages/pi-tick/src/index.ts`** — Main entry:
  - Lazy-initializes TickClient on first use.
  - Registers slash commands:
    - `/tick` — Show context: DB path, project name, open task counts, recent tasks.
    - `/tick-list [--status=] [--epic=] [--limit=N]` — List tasks with filters.
    - `/tick-create <title> [--desc=] [--priority=N] [--epic=]` — Create task.
    - `/tick-update <id> [--title=] [--status=] [--priority=N]` — Update task.
    - `/tick-delete <id>` — Delete a task.
  - Registers Pi tools for LLM use:
    - `tick_list_tasks` — List/filter tasks.
    - `tick_get_task` — Get task details by ID.
    - `tick_create_task` — Create a new task.
    - `tick_update_task` — Update task.
    - `tick_delete_task` — Delete a task.
  - Registers `on("session_start")` to note tick availability in context.

- **`packages/pi-tick/src/commands.ts`** — Command handlers:
  - Parse flags, call TickClient, format output (table or plain text).
  - Show DB path and project info on `/tick` dashboard.

- **`packages/pi-tick/src/tools.ts`** — Tool registrations:
  ```typescript
  pi.registerTool({
    name: 'tick_create_task',
    label: 'Create Task',
    description: 'Create a new task in tick',
    parameters: Type.Object({
      title: Type.String({ description: 'Task title' }),
      description: Type.Optional(Type.String({ description: 'Task description' })),
      priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      epicId: Type.Optional(Type.String({ description: 'Epic ID' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const task = client.createTask({ title: params.title, ... });
      return { content: [{ type: 'text', text: `Created ${task.id}: ${task.title}` }] };
    },
  });
  ```

### Verification

- [ ] `tsc -b packages/pi-tick` passes.
- [ ] `pi -e ./packages/pi-tick/src/index.ts /tick` works against a real tick.db.
- [ ] `/tick-list` shows existing tasks.
- [ ] `/tick-create "Test from pi"` creates a task visible to `tick task list`.

⏸️ **PAUSE** — Verify extension works before Phase 4

---

## Phase 4: Package Manifest & Monorepo Integration

### Changes

- **`packages/pi-tick/package.json`**:
  ```json
  {
    "name": "@rigerc/pi-tick",
    "version": "0.1.0",
    "description": "Task management for Pi — read and write tick.db from within Pi",
    "keywords": ["pi-package", "pi-extension"],
    "license": "MIT",
    "type": "module",
    "files": ["src/", "README.md", "LICENSE", "CHANGELOG.md"],
    "pi": { "extensions": ["./src/index.ts"] },
    "publishConfig": { "access": "public" },
    "repository": {
      "type": "git",
      "url": "git+https://github.com/rigerc/pi-extensions.git",
      "directory": "packages/pi-tick"
    },
    "dependencies": {
      "better-sqlite3": "^11.7.0",
      "typebox": "*"
    },
    "peerDependencies": {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*"
    },
    "devDependencies": {
      "@types/better-sqlite3": "^7.6.x"
    }
  }
  ```

- **`packages/pi-tick/tsconfig.json`** — Extends `../../tsconfig.base.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
    "include": ["src/**/*"]
  }
  ```

- **`package.json` (root)** — Update `scripts.check`:
  `tsc -b packages/pi-skillshare packages/pi-model-picker packages/pi-tick`
  Add: `"tick-codegen": "npx tsx scripts/tick-codegen.ts"`
  Add: `"tick-codegen:watch": "npx tsx watch scripts/tick-codegen.ts"`

- **`packages/pi-tick/README.md`** — Explains:
  - What it does (read/write tick.db from Pi)
  - Pre-requisites (tick CLI with `tick init` run in the project)
  - Install: `pi install ./packages/pi-tick`
  - Commands and tools
  - Concurrency note: "The Go tick CLI and Pi extension share the same SQLite
    database via WAL mode. Concurrent reads are always safe. Concurrent writes
    are serialized by SQLite's file-level locking with a 5-second busy timeout.
    For consistency, avoid running `tick web` while the extension is writing."
  - How to regenerate types: `npm run tick-codegen`
  - Known limits

- **`packages/pi-tick/CHANGELOG.md`** — `0.1.0` initial.
- **`packages/pi-tick/LICENSE`** — MIT.
- **`packages/pi-tick/.gitignore`** — Node.js artifacts.

### Verification

- [ ] `npm run check` compiles all three packages.
- [ ] `pi install ./packages/pi-tick` succeeds in temp Pi agent dir.
- [ ] `pi list` in temp dir shows `@rigerc/pi-tick`.
- [ ] Pyhonic manifest preflight passes (from validation.md).

⏸️ **PAUSE** — Full validation before Phase 5

---

## Phase 5: Validation & Dogfooding

Follow `references/validation.md` strictly:

1. **Structural preflight** — Python manifest checker on `package.json`.
2. **Temp install** — `PI_CODING_AGENT_DIR=$(mktemp -d)` → `pi install $PACKAGE_PATH`.
3. **List check** — `pi list` shows `@rigerc/pi-tick`.
4. **Smoke test** — Against a known tick.db:
   - `pi -p "/tick-list"` returns a table.
   - `pi -p "/tick-create Test from pi"` creates a task.
   - Verify new task appears in `tick task list` (Go CLI sees it).
5. **Concurrency test** — While `tick web` is running, run `/tick-list` and
   `/tick-create` — no errors.
6. **Cleanup** — `rm -rf "$TMP_PI_DIR"`.

### Verification

- [ ] All 5 validation steps pass.
- [ ] Artifacts captured in `$ARTIFACT_DIR`.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **`better-sqlite3` native compilation** | Fails to install on some platforms | Pin known-good version; test on macOS + Linux; document Node.js version requirement |
| **Concurrent write from Go CLI** | `SQLITE_BUSY` transient error | 5s busy_timeout + geometric retry (up to ~3s); document that simultaneous writes should be avoided |
| **ID counter race** | Duplicate task/epic IDs | Counter increment + read in same explicit transaction (RESERVED lock blocks other writer) |
| **Schema drift** | Stale generated types | `npm run tick-codegen` after migrations; can be automated in CI |
| **tick.db not found** | Commands fail unhelpfully | Multi-path search + clear error message "Run 'tick init' first" |
| **WAL checkpoint from Go side** | Temporary file lock during checkpoint | WAL checkpoint is typically non-blocking for readers; busy_timeout covers rare contention |
| **Go web server opens the DB** | Two processes holding the DB concurrently | WAL mode supports this (Go modernc + Node better-sqlite3 both use standard SQLite VFS); tested in practice |
| **Missing runtime peer deps** | Install succeeds, extension fails at runtime | Declared peerDependencies with `*`; test in clean Pi agent dir |

## Testing Strategy

- **Codegen tests** — `scripts/__tests__/codegen.test.ts`: parse migration SQL,
  verify generated output matches expected.
- **DB integration tests** — `packages/pi-tick/src/__tests__/client.test.ts`:
  create in-memory SQLite DB with migrations, run CRUD through TickClient.
- **Concurrency tests** — `packages/pi-tick/src/__tests__/concurrency.test.ts`:
  simulate concurrent writes with a helper that opens a second connection and
  holds a write lock; verify the extension retries and succeeds.
- **Manual smoke** — Phase 5 validation against a real tick.db + Go CLI.

## File Inventory

| Path | Purpose |
|------|---------|
| `packages/pi-tick/package.json` | Package manifest |
| `packages/pi-tick/tsconfig.json` | TypeScript config |
| `packages/pi-tick/README.md` | Package docs |
| `packages/pi-tick/CHANGELOG.md` | Release notes |
| `packages/pi-tick/LICENSE` | MIT license |
| `packages/pi-tick/.gitignore` | Node artifacts |
| `packages/pi-tick/src/index.ts` | Extension entry point |
| `packages/pi-tick/src/db.ts` | SQLite connection + path resolution |
| `packages/pi-tick/src/retry.ts` | `withRetry()` for `SQLITE_BUSY` |
| `packages/pi-tick/src/commands.ts` | Slash command handlers |
| `packages/pi-tick/src/tools.ts` | Custom Pi tool registrations |
| `packages/pi-tick/src/gen/types.ts` | **Auto-generated** TS interfaces |
| `packages/pi-tick/src/gen/schemas.ts` | **Auto-generated** TypeBox schemas |
| `packages/pi-tick/src/gen/client.ts` | **Auto-generated** TickClient CRUD |
| `packages/pi-tick/src/__tests__/client.test.ts` | TickClient integration tests |
| `packages/pi-tick/src/__tests__/concurrency.test.ts` | Concurrent access tests |
| `scripts/tick-codegen.ts` | Codegen script |
| `scripts/__tests__/codegen.test.ts` | Codegen parser tests |
| Root `package.json` update | `check` + `tick-codegen` script entries |

## References

- Tick Go source: `docs/context/tick/`
- Database schema: `docs/context/tick/internal/infra/db/migrations/000001_initial.sql`
- Go SQLite open + pragmas: `docs/context/tick/internal/infra/db/sqlite.go`
- Go ID generation: `docs/context/tick/internal/infra/ids/generator.go`
- Go entity types: `docs/context/tick/internal/core/{task,epic,project,tag,comment,dependency}/entity.go`
- Go web API router (for future Approach B): `docs/context/tick/internal/web/router.go`
- Existing package patterns: `packages/pi-skillshare/`, `packages/pi-model-picker/`
- Pi extension docs: `/home/bond/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi package surface design: `.agents/skills/pi-package-creator/references/surface-design.md`
- Validation flow: `.agents/skills/pi-package-creator/references/validation.md`
