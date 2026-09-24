import { parseGateArgs, evaluateGate } from '../src/gate.js';
import { SystemOneClient } from '../src/system-one.js';

async function main() {
  const args = process.argv.slice(2);
  const options = parseGateArgs(args);

  try {
    const client = new SystemOneClient();
    const result = await evaluateGate(options, client);

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

main();
