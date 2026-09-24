import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { SystemOneCompactor } from '../src/compact.js';
import type { SystemOneClient } from '../src/system-one.js';

type Preparation = SessionBeforeCompactEvent['preparation'];
type Message = Preparation['messagesToSummarize'][number];

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
}

function tool(text: string): Message {
  return {
    role: 'toolResult',
    toolCallId: 'x',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  };
}

function event(
  messages: Message[],
  preparation: Partial<Preparation> = {},
): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: 'kept',
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      ...preparation,
    },
    branchEntries: [],
    customInstructions: 'Fix auth bug',
    signal: new AbortController().signal,
    reason: 'manual',
    willRetry: false,
  } as SessionBeforeCompactEvent;
}

function fakeClient(answer = 0.9) {
  const calls: any[] = [];
  return {
    client: {
      isConfigured: () => true,
      evaluate: async (request: unknown) => {
        calls.push(request);
        return {
          answers: Object.fromEntries(
            Object.keys((request as any).questions).map((id) => [id, { value: answer }]),
          ),
        };
      },
    } as unknown as SystemOneClient,
    calls,
  };
}

test("SystemOneCompactor judges Pi's prepared messages rather than the first branch entries", async () => {
  const { client, calls } = fakeClient();
  const input = event([user('Fix auth bug'), tool('token compare failed at auth.ts:12')]);
  input.branchEntries = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    parentId: i ? String(i - 1) : null,
    timestamp: new Date(0).toISOString(),
    type: 'message',
    message: user(`unrelated branch message ${i}`),
  }));
  const result = await new SystemOneCompactor(client, true).compact(input, {} as any);

  assert.equal(calls.length, 1);
  assert.equal(result.kept, 2);
  assert.match(result.summary, /auth.ts:12/);
  assert.doesNotMatch(result.summary, /unrelated branch message/);
  assert.deepEqual(Object.keys(calls[0].questions), ['keep_1']);
});

test('SystemOneCompactor falls back instead of dropping messages beyond its entry budget', async () => {
  const { client, calls } = fakeClient(1);
  const result = await new SystemOneCompactor(client, true).compact(
    event(Array.from({ length: 50 }, (_, i) => user(`important constraint ${i}`))),
    {} as any,
  );
  assert.equal(result.summary, '');
  assert.equal(result.skipped, 'incomplete');
  assert.equal(result.considered, 50);
  assert.equal(calls.length, 0);
});

test('SystemOneCompactor preserves full retained content beyond 900 characters', async () => {
  const { client } = fakeClient();
  const text = 'x'.repeat(1200) + '\n  EXACT_TAIL';
  const result = await new SystemOneCompactor(client, true).compact(event([tool(text)]), {} as any);
  assert.ok(result.summary.includes(JSON.stringify(tool(text))));
});

test('SystemOneCompactor preserves prior summary, split-turn intent, and assistant messages', async () => {
  const { client, calls } = fakeClient(0.1);
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Preserve this assistant decision' }],
  } as Message;
  const result = await new SystemOneCompactor(client, true).compact(
    event([tool('obsolete listing'), assistant], {
      previousSummary: 'Existing task decisions',
      turnPrefixMessages: [user('Keep this split-turn constraint')],
      isSplitTurn: true,
    }),
    {} as any,
  );
  assert.match(result.summary, /Existing task decisions/);
  assert.match(result.summary, /Preserve this assistant decision/);
  assert.match(result.summary, /Keep this split-turn constraint/);
  assert.doesNotMatch(result.summary, /obsolete listing/);
  assert.equal(result.kept, 2);
  assert.equal(calls[0].state.previous_summary, 'Existing task decisions');
  assert.deepEqual(Object.keys(calls[0].questions), ['keep_0']);
});

test('SystemOneCompactor falls back if per-field or total state caps would cut evidence', async () => {
  for (const messages of [
    [tool('x'.repeat(13000))],
    Array.from({ length: 8 }, () => tool('x'.repeat(10000))),
  ]) {
    const { client, calls } = fakeClient();
    const result = await new SystemOneCompactor(client, true).compact(event(messages), {} as any);
    assert.equal(result.summary, '');
    assert.equal(result.skipped, 'incomplete');
    assert.equal(calls.length, 0);
  }
});

test('SystemOneCompactor falls back if the previous summary cannot fit', async () => {
  const { client, calls } = fakeClient();
  const result = await new SystemOneCompactor(client, true).compact(
    event([tool('result')], {
      previousSummary: 'x'.repeat(13000),
    }),
    {} as any,
  );
  assert.equal(result.summary, '');
  assert.equal(result.skipped, 'incomplete');
  assert.equal(calls.length, 0);
});

test('SystemOneCompactor falls back on missing or invalid judgments', async () => {
  for (const value of [undefined, NaN, 2, '0.9']) {
    const client = {
      isConfigured: () => true,
      evaluate: async () => ({ answers: value === undefined ? {} : { keep_0: { value } } }),
    } as unknown as SystemOneClient;
    const result = await new SystemOneCompactor(client, true).compact(
      event([tool('critical result')]),
      {} as any,
    );
    assert.equal(result.summary, '');
    assert.equal(result.skipped, 'incomplete');
  }
});

test('SystemOneCompactor falls back on evaluation errors', async () => {
  const client = {
    isConfigured: () => true,
    evaluate: async () => {
      throw new Error('offline');
    },
  } as unknown as SystemOneClient;
  const result = await new SystemOneCompactor(client, true).compact(
    event([tool('critical result')]),
    {} as any,
  );
  assert.equal(result.summary, '');
  assert.equal(result.skipped, 'error');
});

test('SystemOneCompactor fails open when Jev is unavailable', async () => {
  const client = { isConfigured: () => false } as unknown as SystemOneClient;
  const result = await new SystemOneCompactor(client, true).compact(
    event([tool('result')]),
    {} as any,
  );
  assert.equal(result.skipped, 'unconfigured');
  assert.equal(result.summary, '');
});

test('SystemOneCompactor does nothing while disabled', async () => {
  const client = { isConfigured: () => true } as unknown as SystemOneClient;
  const result = await new SystemOneCompactor(client, false).compact(
    event([tool('result')]),
    {} as any,
  );
  assert.equal(result.skipped, 'disabled');
});
