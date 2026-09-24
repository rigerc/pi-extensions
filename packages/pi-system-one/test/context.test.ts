import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_CONTEXT_CHARS,
  lastAssistantText,
  lastAssistantToolCalls,
  recentContextFrom,
} from '../src/context.js';

function branch(entries: unknown[]) {
  return { getBranch: () => entries };
}

test('lastAssistantText returns the tail of the newest assistant text', () => {
  const entries = [
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'do the same' }] },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] },
    },
  ];

  const text = lastAssistantText(branch(entries));
  assert.equal(text.length, RECENT_CONTEXT_CHARS);
  assert.ok('x'.repeat(2000).endsWith(text));
});

test('lastAssistantText prefers the most recent assistant turn', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'older' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    },
  ];

  assert.equal(lastAssistantText(branch(entries)), 'final answer');
});

test('lastAssistantText ignores non-message entries and empty content', () => {
  const entries = [
    { type: 'settings', data: {} },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } },
  ];
  assert.equal(lastAssistantText(branch(entries)), '');
  assert.equal(lastAssistantText(undefined), '');
});

test('recentContextFrom never throws on a broken or absent session manager', () => {
  assert.equal(recentContextFrom(undefined), '');
  assert.equal(recentContextFrom({}), '');
  assert.equal(
    recentContextFrom({
      sessionManager: {
        getBranch: () => {
          throw new Error('session unavailable');
        },
      },
    }),
    '',
  );
});

test('lastAssistantToolCalls reads the batch being preflighted', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'older' }] } },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'writing then reading' },
          { type: 'toolCall', id: '1', name: 'write', arguments: { path: 'a.ts', content: '' } },
          { type: 'toolCall', id: '2', name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
    },
  ];

  const calls = lastAssistantToolCalls({ getBranch: () => entries });
  assert.deepEqual(
    calls.map((c) => c.name),
    ['write', 'read'],
  );
  assert.equal(calls[0].arguments.path, 'a.ts');
  assert.deepEqual(lastAssistantToolCalls(undefined), []);
});
