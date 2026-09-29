import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSystemOneOrchestrateTool } from '../src/orchestrate-tool.js';
import type { SystemOneClient } from '../src/system-one.js';

interface RecordedCall {
  name: string;
  args: any;
}

function captureTool(client: SystemOneClient): any {
  const tools: any[] = [];
  const pi = { registerTool: (definition: any) => tools.push(definition) } as any;
  registerSystemOneOrchestrateTool(pi, client);
  return tools[0];
}

function makeCtx(
  calls: RecordedCall[],
  options: { available?: boolean; fail?: boolean } = {},
): any {
  const available = options.available ?? true;
  return {
    tools: available ? [{ name: 'agent_delegate' }, { name: 'read' }] : [{ name: 'read' }],
    executeTool: async (name: string, args: any) => {
      calls.push({ name, args });
      if (options.fail) {
        return {
          isError: true,
          result: { content: [{ type: 'text', text: 'spawn rejected' }], details: {} },
          toolCall: {},
        };
      }
      return {
        isError: false,
        result: { content: [{ type: 'text', text: 'accepted' }], details: {} },
        toolCall: {},
      };
    },
  };
}

const unconfigured = { isConfigured: () => false } as unknown as SystemOneClient;

test('system_one_orchestrate fails with the herdsman hint when agent_delegate is not callable', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  const result = await tool.execute(
    'id',
    { task: 'do a thing' },
    undefined,
    undefined,
    makeCtx(calls, { available: false }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /pi-herdsman/);
  assert.equal(calls.length, 0);
});

test('system_one_orchestrate delegates one implementer for an implementation task', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  const result = await tool.execute(
    'id',
    { task: 'fix the login bug' },
    undefined,
    undefined,
    makeCtx(calls),
  );
  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'agent_delegate');
  assert.equal(calls[0].args.definition, 'implementer');
  assert.match(result.content[0].text, /implementer/);
  assert.equal(result.details.topology, 'implementation');
});

test('system_one_orchestrate fans research out to scout and researcher in parallel', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  const result = await tool.execute(
    'id',
    { task: 'investigate the auth flow' },
    undefined,
    undefined,
    makeCtx(calls),
  );
  assert.deepEqual(
    calls.map((call) => call.args.definition).sort(),
    ['researcher', 'scout'],
  );
  assert.equal(result.details.topology, 'research');
});

test('system_one_orchestrate honours an explicit topology override', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  await tool.execute(
    'id',
    { task: 'anything', topology: 'review' },
    undefined,
    undefined,
    makeCtx(calls),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.definition, 'reviewer');
});

test('system_one_orchestrate reports a rejected delegation as an error', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  const result = await tool.execute(
    'id',
    { task: 'fix the login bug' },
    undefined,
    undefined,
    makeCtx(calls, { fail: true }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /spawn rejected/);
  assert.equal(result.details.outcomes[0].accepted, false);
});

test('system_one_orchestrate dry run returns the plan without delegating', async () => {
  const tool = captureTool(unconfigured);
  const calls: RecordedCall[] = [];
  const result = await tool.execute(
    'id',
    { task: 'fix the login bug', dryRun: true },
    undefined,
    undefined,
    makeCtx(calls),
  );
  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /dry run/);
  assert.deepEqual(
    result.details.plan.map((assignment: any) => assignment.definition),
    ['implementer'],
  );
});

test('system_one_orchestrate uses a System One topology answer when configured', async () => {
  const client = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: { topology: { type: 'choice', value: 'review', confidence: 0.9 } },
      model: 'jev-latest',
      elapsedMs: 1,
    }),
  } as unknown as SystemOneClient;
  const tool = captureTool(client);
  const calls: RecordedCall[] = [];
  await tool.execute(
    'id',
    { task: 'look at the parser' },
    undefined,
    undefined,
    makeCtx(calls),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.definition, 'reviewer');
});
