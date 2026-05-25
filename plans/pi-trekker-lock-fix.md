# Plan: Fix `pi-trekker-tasks` SQLite Database Lock Errors

## Context

The `pi-trekker-tasks` extension registers 11 LLM-callable tools (TaskCreate, TaskList, TaskUpdate, etc.) that all shell out to the `trekker` CLI via `execFile` in `cli.ts`. The trekker CLI uses a SQLite database (`.trekker/trekker.db`).

When the LLM fires multiple trekker operations **concurrently in a single turn** (e.g., creating a task then immediately listing tasks, or rapid subagent calls), the parallel `execFile` calls hit SQLite simultaneously. SQLite's locking mechanism produces `SQLITE_BUSY` / `database is locked` errors because there's **no serialization** between concurrent calls.

This also affects the `trekker-store.ts` methods (`create`, `update`, `addDep`, `removeDep`, etc.) which each call `cli.ts` functions and then `refresh()`.

## Approach

Add an **in-process async mutex** to `cli.ts` that serializes all `trekkerCmdRaw` calls, combined with **automatic retry on lock errors** with exponential backoff. This requires zero new npm dependencies — just a lightweight async mutex and a lock-error detection helper.

### Why in-process mutex instead of PATH wrapper?

The existing plan (`docs/plans/pi-trek-lock.md`) proposes a PATH wrapper with `flock`. That's more comprehensive (covers bash subshells) but is a larger change. For `pi-trekker-tasks`, the mutex + retry approach:
- Solves the immediate problem (concurrent tool calls in a single turn)
- Catches bash-invoked lock errors via retry
- Zero new dependencies
- Minimal code change

## Files to Modify

### `pi-trekker-tasks/src/cli.ts`

Changes:
1. **Add async mutex** — a simple `Promise`-based queue that ensures only one `trekker` invocation runs at a time
2. **Add lock error detection** — helper to detect `SQLITE_BUSY` / `database is locked` in stderr
3. **Add retry wrapper** — retries failed calls up to 3 times with exponential backoff (50ms, 100ms, 200ms)
4. **Wrap `trekkerCmdRaw`** — serialize + retry all calls through the mutex

## Implementation Details

### 1. Async Mutex

```ts
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {}); // always resolve
    return result;
  }
}
```

### 2. Lock Error Detection

```ts
function isSqliteLockError(err: Error, stderr?: string): boolean {
  const combined = `${err.message}\n${stderr ?? ''}`.toLowerCase();
  return (
    combined.includes('database is locked') ||
    combined.includes('sqlite_busy') ||
    combined.includes('sql logic error') && combined.includes('locked')
  );
}
```

### 3. Retry Wrapper

```ts
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;

async function retryWithBackoff(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteLockError(err as Error) || attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}
```

### 4. Modified `trekkerCmdRaw`

The `execFile` call becomes:

```ts
async function trekkerCmdRaw(...args: string[]): Promise<ToonOutput> {
  const allArgs = [...args, '--toon'];
  return mutex.acquire(async () => {
    return retryWithBackoff(async () => {
      return new Promise((resolve, reject) => {
        execFile('trekker', allArgs, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          // ... existing logic
        });
      });
    });
  });
}
```

## Steps

- [ ] Add `AsyncMutex` class to `cli.ts`
- [ ] Add `isSqliteLockError` helper function
- [ ] Add `retryWithBackoff` utility with configurable max retries (3) and base delay (50ms)
- [ ] Wrap `trekkerCmdRaw` to acquire mutex and apply retry on lock errors
- [ ] Verify the fix compiles with `npx tsc --noEmit` in `pi-trekker-tasks/`
- [ ] Verify existing tool behavior is unchanged (no breaking changes to public API)

## Verification

1. **Compile check**: `cd pi-trekker-tasks && npx tsc --noEmit` should pass cleanly
2. **Manual test**: Run multiple trekker tools concurrently (e.g., TaskCreate + TaskList in the same turn) — should no longer produce lock errors
3. **No breaking changes**: All tool signatures and return types remain identical — only internal execution changes
