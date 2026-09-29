import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { runGateCli, type GateRuntimeFactory } from '../bin/system-one-gate-runner.js';
import { fakeRegistry } from './support/registry.js';

/** Env vars the client reads when nothing is explicitly configured. */
const CLASSIFIER_ENV = [
  'PI_SYSTEM_ONE_PROVIDER',
  'PI_SYSTEM_ONE_MODEL',
  'PI_JEV_PROVIDER',
  'PI_JEV_MODEL',
] as const;

/** Keep the developer's own classifier selection from steering an injected-factory run. */
function clearClassifierEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of CLASSIFIER_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A fake runtime with the registry slice ModelRegistry delegates to, plus a dispose
 * the runner should call. Cast because the real runtime owns much more.
 */
function disposableRuntime(registry: unknown): { runtime: ModelRuntime; disposed: () => number } {
  let disposed = 0;
  const runtime = {
    ...(registry as Record<string, unknown>),
    dispose: () => {
      disposed += 1;
    },
  } as unknown as ModelRuntime;
  return { runtime, disposed: () => disposed };
}

test('gate CLI runs from another directory and ships its TypeScript loader', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-one-cli-'));
  try {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.equal(manifest.name, '@rigerc/pi-system-one');
    assert.ok(manifest.dependencies.tsx, 'the loader is needed in production installs');
    assert.equal(manifest.bin['pi-system-one-gate'], './bin/system-one-gate.js');
    assert.equal(manifest.bin['system-one-gate'], './bin/system-one-gate.js');
    assert.equal(manifest.bin['pi-jev-gate'], './bin/system-one-gate.js');
    assert.equal(manifest.bin['jev-gate'], './bin/system-one-gate.js');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../bin/system-one-gate.js', import.meta.url)), '--help'],
      { cwd, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: system-one-gate/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('gate CLI bootstraps the injected runtime and evaluates through it', async () => {
  const restoreEnv = clearClassifierEnv();
  try {
    const fake = fakeRegistry({
      classify: () => ({ answers: { gate_passed: { type: 'bool', probability: 0.9 } } }),
    });
    const { runtime, disposed } = disposableRuntime(fake.registry);
    const createRuntime: GateRuntimeFactory = async () => runtime;

    const result = await runGateCli(
      { criteria: 'Must pass', state: 'const x = 1;', threshold: 0.7 },
      createRuntime,
    );

    assert.equal(result.passed, true);
    assert.equal(result.evaluated, true);
    assert.equal(result.probability, 0.9);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].context.state.output, 'const x = 1;');
    assert.equal(disposed(), 1, 'the runtime is torn down after a successful run');
  } finally {
    restoreEnv();
  }
});

test('gate CLI reports an actionable error and still tears the runtime down', async () => {
  const restoreEnv = clearClassifierEnv();
  try {
    const fake = fakeRegistry({ models: [] });
    const { runtime, disposed } = disposableRuntime(fake.registry);
    const createRuntime: GateRuntimeFactory = async () => runtime;

    await assert.rejects(
      runGateCli({ criteria: 'Must pass', state: 'x' }, createRuntime),
      /No System One classifier is available/,
    );

    assert.equal(fake.calls.length, 0);
    assert.equal(disposed(), 1, 'the runtime is torn down when the gate cannot run');
  } finally {
    restoreEnv();
  }
});
