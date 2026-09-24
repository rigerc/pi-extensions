import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSystemOneAgentTask, SystemOneAgentHandler } from '../src/agent.js';
import { SystemOneClient } from '../src/system-one.js';

test('executeSystemOneAgentTask runs noul check for simple prompt', async () => {
  const mockClient = new SystemOneClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (req) => {
    assert.ok(req.questions['judgment']);
    assert.equal(req.questions['judgment'].type, 'noul');
    return {
      answers: {
        judgment: {
          type: 'noul',
          value: 0.88,
        },
      },
      model: 'jev-latest',
      elapsedMs: 30,
    };
  };

  const res = await executeSystemOneAgentTask(
    { task: 'Is this pull request safe to deploy?', state: 'git diff content' },
    mockClient,
  );
  assert.equal(res.success, true);
  assert.equal(res.primaryValue, 0.88);
});

test('executeSystemOneAgentTask runs choice check when specified', async () => {
  const mockClient = new SystemOneClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (req) => {
    assert.equal(req.questions['judgment'].type, 'choice');
    return {
      answers: {
        judgment: {
          type: 'choice',
          value: 'bugfix',
        },
      },
      model: 'jev-latest',
      elapsedMs: 25,
    };
  };

  const res = await executeSystemOneAgentTask(
    {
      type: 'choice',
      instructions: 'Classify issue type',
      criteria: { bugfix: 'Bug report', feature: 'New feature request' },
      state: 'Fix null pointer in auth handler',
    },
    mockClient,
  );
  assert.equal(res.success, true);
  assert.equal(res.primaryValue, 'bugfix');
});

test('SystemOneAgentHandler uses system-one canonically and accepts legacy agent ids', async () => {
  const listeners: Record<string, Function[]> = {};
  const emitted: Record<string, any[]> = {};

  const mockPi: any = {
    events: {
      on: (event: string, fn: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
        return () => {};
      },
      emit: (event: string, payload: any) => {
        emitted[event] = emitted[event] || [];
        emitted[event].push(payload);
      },
    },
  };

  const mockClient = new SystemOneClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: {
      judgment: {
        type: 'choice',
        value: 'approved',
      },
    },
    model: 'jev-latest',
    elapsedMs: 20,
  });

  const handler = new SystemOneAgentHandler(mockPi, mockClient);
  handler.install();

  const rpcHandler = listeners['subagents:rpc:v1:request']?.[0];
  assert.ok(rpcHandler);

  await rpcHandler({
    version: 1,
    requestId: 'req-123',
    params: {
      agent: 'system-one',
      type: 'choice',
      criteria: { approved: 'Pass', rejected: 'Fail' },
      task: 'Review changes',
    },
  });

  const reply = emitted['subagents:rpc:v1:reply:req-123']?.[0];
  assert.ok(reply);
  assert.equal(reply.success, true);
  assert.equal(reply.data.result.primaryValue, 'approved');
  assert.match(reply.data.id, /^system-one-/);

  for (const [index, legacyAgent] of ['jev', 'typesafe-jev'].entries()) {
    const requestId = `legacy-${index}`;
    await rpcHandler({
      version: 1,
      requestId,
      params: { agent: legacyAgent, task: 'Legacy workflow' },
    });
    assert.equal(emitted[`subagents:rpc:v1:reply:${requestId}`]?.[0]?.success, true);
  }
});
