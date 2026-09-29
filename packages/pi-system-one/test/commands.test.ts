import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerSystemOneCommands } from '../src/commands.js';
import type { SystemOneClient } from '../src/system-one.js';
import type { ToolRouter } from '../src/router.js';
import type { SkillRouter } from '../src/skills.js';
import type { AutoSystemOne } from '../src/auto.js';
import type { SettingsService } from '../src/settings.js';
import { makeSettingsHarness } from './settings-harness.js';

function harness(
  designed: unknown,
  answers: Record<string, any> = {},
  clientOverrides: Record<string, any> = {},
  settings?: SettingsService,
  cwd?: string,
) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const commands = new Map<string, any>();
  let activeTools = ['read'];
  const allTools = [
    { name: 'read' },
    { name: 'bash' },
    { name: 'system_one_find_tools' },
    { name: 'system_one_find_skill' },
    { name: 'system_one_evaluate' },
  ];
  const pi: any = {
    registerCommand: (name: string, options: any) => {
      commands.set(name, options);
      if (name === 'system-one') handler = options.handler;
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => allTools,
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
  };

  const systemOneClient = {
    isConfigured: () => true,
    getProviderInfo: async () => ({
      provider: 'typesafe',
      label: 'TypeSafe',
      model: 'jev-latest',
      api: 'typesafe-system-one',
      auth: 'ok',
      source: 'settings',
    }),
    stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
    evaluate: async (request: any) => ({
      answers,
      model: 'jev-latest',
      elapsedMs: 7,
      _requested: Object.keys(request.questions),
    }),
    ...clientOverrides,
  } as unknown as SystemOneClient;

  const auto = {
    enabled: false,
    setEnabled(value: boolean) {
      this.enabled = value;
    },
  };

  registerSystemOneCommands(
    pi,
    systemOneClient,
    {} as ToolRouter,
    {} as SkillRouter,
    auto as unknown as AutoSystemOne,
    undefined,
    undefined,
    undefined,
    undefined,
    settings,
  );

  const notify = (message: string, level?: string) => {
    calls.push({ message, level });
  };
  const calls: Array<{ message: string; level?: string }> = [];

  const ctx: any = {
    ui: { notify },
    cwd: cwd ?? process.cwd(),
    model: { provider: 'openai', id: 'gpt-x' },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => ({
        content: [
          {
            type: 'text',
            text: typeof designed === 'string' ? designed : JSON.stringify(designed),
          },
        ],
      }),
    },
    signal: undefined,
  };

  return {
    run: (args: string) => handler!(args, ctx),
    calls,
    active: () => [...activeTools],
    auto,
    commands,
  };
}

test('/system-one test <prompt> designs the evaluation with the model, then runs it on System One', async () => {
  const { run, calls } = harness(
    {
      state: 'diff removes a null check before the token compare',
      questions: {
        is_risky: { type: 'bool', instructions: 'Is this risky?' },
        verdict: { type: 'choice', instructions: 'Merge?', criteria: { yes: '', no: '' } },
      },
    },
    { is_risky: { type: 'bool', value: 0.81 }, verdict: { type: 'choice', value: 'no' } },
  );

  await run('test removed null check in auth');

  const messages = calls.map((c) => c.message).join('\n');
  assert.match(messages, /Designing a System One evaluation for: "removed null check in auth"/);
  assert.match(messages, /Designed 2 question\(s\): is_risky, verdict/);
  assert.match(messages, /is_risky: 0.81 \(81% yes\)/);
  assert.match(messages, /verdict: no/);
  assert.equal(calls.at(-1)?.level, 'info');
});

test('/system-one install-herdsman writes a project definition and refuses to overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-one-herdsman-'));
  try {
    const { run, calls } = harness({}, {}, {}, undefined, dir);

    await run('install-herdsman --project');
    const target = path.join(dir, '.pi', 'agents', 'system-one-judge.md');
    assert.ok(fs.existsSync(target), 'definition is written');
    const written = fs.readFileSync(target, 'utf8');
    assert.match(written, /name: system-one-judge/);
    assert.match(written, /tools: \["system_one_evaluate"\]/);
    assert.match(written, /extensions: \[".*extensions\/index\.ts"\]/);
    assert.match(calls.at(-1)?.message ?? '', /Wrote pi-herdsman definition/);

    await run('install-herdsman --project');
    assert.match(calls.at(-1)?.message ?? '', /already exists/);
    assert.equal(calls.at(-1)?.level, 'warning');

    await run('install-herdsman --project --force --thinking high');
    assert.match(fs.readFileSync(target, 'utf8'), /thinking: high/);
    assert.equal(calls.at(-1)?.level, 'info');

    await run('install-herdsman --project --thinking bananas');
    assert.match(calls.at(-1)?.message ?? '', /must be one of/);
    assert.equal(calls.at(-1)?.level, 'warning');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registers /system-one without the old /jev alias', async () => {
  const { commands, calls } = harness({});
  assert.match(commands.get('system-one')?.description, /Manage System One classifier integration/);
  assert.equal(commands.has('jev'), false);

  await commands.get('system-one').handler('help', {
    ui: { notify: (message: string, level?: string) => calls.push({ message, level }) },
  });
  assert.match(calls.at(-1)!.message, /System One commands/);
});

test('/system-one test without a prompt keeps the fixed smoke test and skips the model', async () => {
  const { run, calls } = harness(
    {},
    {
      is_billing: { type: 'bool', value: 0.9 },
      category: { type: 'choice', value: 'billing' },
    },
  );

  await run('test');
  const messages = calls.map((c) => c.message).join('\n');
  assert.match(messages, /System One Test Successful/);
  assert.match(messages, /is_billing: 0.9 \(90% yes\)/);
  assert.doesNotMatch(messages, /Designing a System One evaluation/);
});

test('/system-one test <prompt> reports design failures without calling System One', async () => {
  const { run, calls } = harness('I refuse to answer in JSON.');
  await run('test something vague');

  const messages = calls.map((c) => c.message).join('\n');
  assert.match(messages, /Could not design evaluation:/);
  assert.equal(calls.at(-1)?.level, 'error');
});

test('/system-one eval and /system-one evaluate are accepted aliases', async () => {
  const { run, calls } = harness(
    {
      state: 'x',
      questions: { ok: { type: 'bool', instructions: 'Fine?' } },
    },
    { ok: { type: 'bool', value: 1 } },
  );

  await run('eval is this fine');
  assert.match(calls.map((c) => c.message).join('\n'), /Designed 1 question\(s\): ok/);

  calls.length = 0;
  await run('evaluate is this fine');
  assert.match(calls.map((c) => c.message).join('\n'), /Designed 1 question\(s\): ok/);
});

test('subcommands match exactly, so lookalike words are rejected', async () => {
  const { run, calls } = harness({});

  await run('autofoo on');
  assert.match(calls.at(-1)!.message, /Unknown command \/system-one autofoo/);
  assert.equal(calls.at(-1)!.level, 'warning');

  calls.length = 0;
  await run('skillsfoo react');
  assert.match(calls.at(-1)!.message, /Unknown command \/system-one skillsfoo/);

  calls.length = 0;
  await run('auto maybe');
  assert.match(calls.at(-1)!.message, /Unknown \/system-one auto argument "maybe"/);
  assert.equal(calls.at(-1)!.level, 'warning');
});

test('/system-one auto toggles only when no argument is given', async () => {
  const { run, calls, auto } = harness({});

  await run('auto');
  assert.match(calls.at(-1)!.message, /auto mode enabled/);
  assert.equal(auto.enabled, true);

  await run('auto');
  assert.match(calls.at(-1)!.message, /auto mode disabled/);
  assert.equal(auto.enabled, false);

  await run('auto off');
  assert.match(calls.at(-1)!.message, /auto mode disabled/);
  assert.equal(auto.enabled, false);
});

test('/system-one status reports the classifier, its api and auth, and excludes own tools from the routable count', async () => {
  const { run, calls } = harness({});
  await run('status');

  const status = calls.at(-1)!.message;
  assert.match(status, /Provider configured: Yes/);
  assert.match(status, /Selected classifier: typesafe\/jev-latest/);
  assert.match(status, /Provider: TypeSafe \(typesafe-system-one\)/);
  assert.match(status, /Authentication: ok/);
  assert.match(status, /Selection source: settings/);
  assert.match(status, /Cost \(session\): n\/a/);
  assert.doesNotMatch(status, /API key|apiKey|base URL|Laya health/i);
  // active: read. bash is routable; the three jev tools are ours and must not count.
  assert.match(status, /Active tools: 1 \/ Available: 5 \(1 routable\)/);
});

test('/system-one status reports the active provider, session cost and cross-provider fallback', async () => {
  const { run, calls } = harness(
    {},
    {},
    {
      getProviderInfo: async () => ({
        provider: 'openrouter',
        label: 'OpenRouter',
        model: 'jev-latest',
        api: 'typesafe-system-one',
        auth: 'stored',
        source: 'env',
      }),
      stats: {
        requestsCount: 3,
        totalTokens: 1234,
        totalCostUsd: 0.0042,
        provider: 'openrouter',
        model: 'jev-latest',
        fallback: { from: 'typesafe', to: 'openrouter', reason: '401 unauthorized' },
      },
    },
  );

  await run('status');
  const status = calls.at(-1)!.message;
  assert.match(status, /Provider configured: Yes/);
  assert.match(status, /Selected classifier: openrouter\/jev-latest/);
  assert.match(status, /Provider: OpenRouter \(typesafe-system-one\)/);
  assert.match(status, /Authentication: stored/);
  assert.match(status, /Selection source: env/);
  assert.match(status, /Total tokens used: 1234/);
  assert.match(status, /Cost \(session\): \$0\.004200/);
  assert.match(status, /Last response: openrouter \/ jev-latest/);
  assert.match(status, /Fallback \(last request\): typesafe → openrouter \(401 unauthorized\)/);
});

test('/system-one status shows a local llama.cpp classifier and its wire api', async () => {
  const { run, calls } = harness(
    {},
    {},
    {
      getProviderInfo: async () => ({
        provider: 'llama-cpp',
        label: 'llama.cpp (local)',
        model: 'qwen3-4b',
        api: 'llama-cpp-classify',
        auth: 'ok',
        source: 'settings',
      }),
    },
  );

  await run('status');
  const status = calls.at(-1)!.message;
  assert.match(status, /Selected classifier: llama-cpp\/qwen3-4b/);
  assert.match(status, /Provider: llama\.cpp \(local\) \(llama-cpp-classify\)/);
  assert.match(status, /Authentication: ok/);
  assert.match(status, /Selection source: settings/);
});

test('/system-one status prints the actionable message when no classifier is available', async () => {
  const { run, calls } = harness(
    {},
    {},
    {
      isConfigured: () => false,
      getProviderInfo: async () => null,
    },
  );

  await run('status');
  const status = calls.at(-1)!.message;
  assert.match(status, /Provider configured: No/);
  assert.match(status, /No System One classifier is available/);
  assert.match(status, /\/login typesafe/);
  assert.match(status, /\/llama/);
});

test('/system-one health is no longer a command', async () => {
  const { run, calls } = harness({});
  await run('health');
  assert.equal(calls.at(-1)!.level, 'warning');
  assert.match(calls.at(-1)!.message, /Unknown command \/system-one health/);
});

test('/system-one status reports effective legacy configuration once', async () => {
  const sh = makeSettingsHarness({ env: { PI_JEV_PROVIDER: 'openrouter' } });
  try {
    sh.service.init();
    const { run, calls } = harness({}, {}, {}, sh.service);
    await run('status');
    const status = calls.at(-1)!.message;
    assert.match(status, /Legacy inputs .*\$PI_JEV_PROVIDER/);
    assert.equal(status.match(/Legacy inputs/g)?.length, 1);
  } finally {
    sh.cleanup();
  }
});

test("/system-one enable and /system-one disable only touch this extension's tools", async () => {
  const { run, calls, active } = harness({});

  await run('enable');
  assert.deepEqual(
    active().sort(),
    ['system_one_evaluate', 'system_one_find_skill', 'system_one_find_tools', 'read'].sort(),
  );
  assert.match(
    calls.at(-1)!.message,
    /System One tools \(system_one_find_tools, system_one_find_skill, system_one_evaluate\) enabled/,
  );

  await run('disable');
  assert.deepEqual(active(), ['read']);
});

test('/system-one auto on saves the user file and reports session provenance', async () => {
  const sh = makeSettingsHarness();
  try {
    sh.service.init();
    const { run, calls } = harness({}, {}, {}, sh.service);

    await run('auto on');
    assert.match(calls.at(-1)!.message, /auto mode enabled/);
    assert.equal(sh.service.values.autoToolRouting, true, 'settings layer is updated');
    assert.equal(sh.service.values.autoSkillRouting, true, 'the master switch turns on both paths');
    assert.deepEqual(
      sh.entries.at(-1)!.data,
      { autoToolRouting: true, autoSkillRouting: true },
      'session entry persisted',
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(sh.pathFor('user'), 'utf8')), {
      version: 1,
      autoToolRouting: true,
      autoSkillRouting: true,
    });
    assert.ok(!fs.existsSync(sh.pathFor('project')));

    calls.length = 0;
    await run('status');
    const status = calls.at(-1)!.message;
    assert.match(status, /Auto tool routing: on \(session\)/);
    assert.match(status, /Auto skill routing: on \(session\)/);
    assert.match(status, /Auto-model: off \(default\)/);
  } finally {
    sh.cleanup();
  }
});

test('/system-one mode command does not claim success when the user file write fails', async () => {
  const sh = makeSettingsHarness();
  try {
    sh.service.init();
    fs.mkdirSync(sh.pathFor('user'), { recursive: true });
    const { run, calls } = harness({}, {}, {}, sh.service);
    await assert.rejects(run('auto on'));
    assert.equal(sh.service.values.autoToolRouting, false);
    assert.equal(sh.entries.length, 0);
    assert.ok(!calls.some((call) => /auto mode enabled/.test(call.message)));
  } finally {
    sh.cleanup();
  }
});

test('/system-one auto-tools toggles only the tool path', async () => {
  const sh = makeSettingsHarness();
  try {
    sh.service.init();
    const { run, calls } = harness({}, {}, {}, sh.service);

    await run('auto-tools on');
    assert.equal(sh.service.values.autoToolRouting, true);
    assert.equal(sh.service.values.autoSkillRouting, false, 'the skill path is untouched');
    assert.deepEqual(sh.entries.at(-1)!.data, { autoToolRouting: true });

    calls.length = 0;
    await run('status');
    const status = calls.at(-1)!.message;
    assert.match(status, /Auto tool routing: on \(session\)/);
    assert.match(status, /Auto skill routing: off \(default\)/);
  } finally {
    sh.cleanup();
  }
});

test('/system-one auto-skills toggles only the skill path and flips when given no argument', async () => {
  const sh = makeSettingsHarness();
  try {
    sh.service.init();
    const { run, calls } = harness({}, {}, {}, sh.service);

    await run('auto-skills');
    assert.equal(sh.service.values.autoSkillRouting, true, 'no argument flips it on');
    assert.equal(sh.service.values.autoToolRouting, false);

    await run('auto-skills');
    assert.equal(sh.service.values.autoSkillRouting, false, 'no argument flips it back off');
    assert.match(calls.at(-1)!.message, /auto skill routing disabled/);
  } finally {
    sh.cleanup();
  }
});

test('/system-one disable writes through to the settings layer', async () => {
  const sh = makeSettingsHarness();
  try {
    sh.service.init();
    sh.service.set('systemOneTools', true);
    const { run, calls } = harness({}, {}, {}, sh.service);

    await run('disable');
    assert.equal(sh.service.values.systemOneTools, false);
    assert.deepEqual(sh.entries.at(-1)!.data, { systemOneTools: false });
    assert.match(calls.at(-1)!.message, /System One tools disabled/);
  } finally {
    sh.cleanup();
  }
});

test('/system-one help lists usage at info level instead of warning', async () => {
  const { run, calls } = harness({});
  await run('help');

  assert.match(calls.at(-1)!.message, /\/system-one auto \[on\|off\]/);
  assert.equal(calls.at(-1)!.level, 'info');
});
