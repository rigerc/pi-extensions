import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { evaluateGate, parseGateArgs } from '../src/gate.js';
import type { GateOptions, GateResult } from '../src/gate.js';
import { SystemOneClient } from '../src/system-one.js';

/**
 * Builds the model runtime a standalone gate run needs. Injectable so tests can run
 * the whole bootstrap without touching the developer's real `auth.json`.
 */
export type GateRuntimeFactory = () => Promise<ModelRuntime>;

/**
 * A cold machine has no cached catalog, so let `create()` refresh it over the
 * network. Credentials still resolve from pi's own `auth.json` and each provider's
 * env var; this CLI never reads or stores a key itself.
 */
export function createGateRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ allowModelNetwork: true });
}

/**
 * pi's `ModelRuntime` exposes no `dispose()`/`close()` in 0.99, so release only when
 * a runtime provides one. Keeping the hook means a future pi or a test fake can still
 * observe teardown.
 */
async function disposeRuntime(runtime: ModelRuntime): Promise<void> {
  const disposable = runtime as { dispose?: () => void | Promise<void> };
  await disposable.dispose?.();
}

/**
 * Run the gate against its own classifier registry, releasing the runtime in a
 * `finally` even when the gate throws.
 */
export async function runGateCli(
  options: GateOptions,
  createRuntime: GateRuntimeFactory = createGateRuntime,
): Promise<GateResult> {
  const runtime = await createRuntime();
  try {
    const client = new SystemOneClient();
    client.attach(new ModelRegistry(runtime));
    return await evaluateGate(options, client);
  } finally {
    await disposeRuntime(runtime);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseGateArgs(args);

  try {
    const result = await runGateCli(options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const evaluated = result.evaluated !== false && result.probability !== null;
      const probStr = evaluated ? (result.probability! * 100).toFixed(1) + '%' : 'n/a';
      const threshStr = (result.threshold * 100).toFixed(1) + '%';
      if (result.truncated) {
        console.warn(
          '[system-one-gate] NOTE: evidence is incomplete (content was truncated or could not be read).',
        );
      }
      if (result.passed) {
        if (evaluated) {
          console.log(
            `[system-one-gate] PASS: P=${probStr} >= ${threshStr} (${result.elapsedMs}ms)`,
          );
        } else {
          console.warn(
            `[system-one-gate] PASS (not evaluated, fail-open): ${result.error ?? 'no evaluation'}`,
          );
        }
        console.log(`Criteria: "${result.criteria}"`);
      } else {
        console.error(
          `[system-one-gate] FAIL: P=${probStr} < ${threshStr} (${result.elapsedMs}ms)`,
        );
        console.error(`Criteria: "${result.criteria}"`);
      }
    }

    process.exit(result.passed ? 0 : 1);
  } catch (err: any) {
    if (options.failOpen) {
      console.warn(`[system-one-gate] WARN (fail-open): ${err?.message || err}`);
      process.exit(0);
    }
    if (options.json) {
      console.error(JSON.stringify({ error: err?.message || String(err), passed: false }, null, 2));
    } else {
      console.error(`[system-one-gate] ERROR: ${err?.message || err}`);
    }
    process.exit(2);
  }
}

// Only start a run when this module is the CLI entry point (directly or through the
// `bin/system-one-gate.js` loader), so tests can import `runGateCli` and inject a fake.
const entry = process.argv[1] ?? '';
if (/(?:^|[\\/])system-one-gate(?:-runner)?\.(?:ts|js)$/.test(entry)) {
  void main();
}
