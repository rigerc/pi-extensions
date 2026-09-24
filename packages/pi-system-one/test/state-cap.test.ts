import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STATE_CHARS, MAX_STATE_FIELD_CHARS, capState } from '../src/system-one.js';

test('capState leaves a state that already fits untouched', () => {
  const state = { output: 'small output', criteria: 'no new any', truncated: false };
  const capped = capState(state);

  assert.deepEqual(capped.value, state);
  assert.equal(capped.truncatedChars, 0);
});

test('capState cuts an oversized field and marks the cut in place', () => {
  const capped = capState({ output: 'x'.repeat(MAX_STATE_FIELD_CHARS + 500) });
  const output = (capped.value as Record<string, string>).output;

  assert.ok(capped.truncatedChars >= 500);
  assert.match(output, /…\[truncated \d+ chars\]$/);
  assert.ok(output.length <= MAX_STATE_FIELD_CHARS, `field cap exceeded: ${output.length}`);
});

test('capState shrinks the whole payload when the fields alone are still too large', () => {
  const state = {
    a: 'a'.repeat(1000),
    b: 'b'.repeat(1000),
    c: 'c'.repeat(1000),
    criteria: 'keep me',
  };

  const capped = capState(state, 1200);
  const serialized = JSON.stringify(capped.value);

  assert.ok(capped.truncatedChars > 0);
  assert.ok(serialized.length < 2000, `payload should shrink, got ${serialized.length}`);
  assert.equal(
    (capped.value as Record<string, string>).criteria,
    'keep me',
    'small fields survive',
  );
});

test('capState does not disturb a state under the field cap', () => {
  const state = { task: 'x'.repeat(MAX_STATE_FIELD_CHARS), note: 'y' };
  assert.equal(capState(state).truncatedChars, 0);
});

test('capState caps a string state and reports what it dropped', () => {
  const text = 'z'.repeat(MAX_STATE_CHARS + 25);
  const capped = capState(text);

  assert.equal(typeof capped.value, 'string');
  assert.ok(capped.truncatedChars > 0);
  assert.match(capped.value as string, /\[truncated \d+ chars\]/);
  assert.ok((capped.value as string).length <= MAX_STATE_CHARS);
});

test('capState structurally truncates a state with no shrinkable strings', () => {
  const capped = capState({ values: Array(100_000).fill(123456) });
  const serialized = JSON.stringify(capped.value);

  assert.ok(capped.truncatedItems > 0, 'whole elements are dropped');
  assert.ok(serialized.length <= MAX_STATE_CHARS, `payload should fit, got ${serialized.length}`);
});

test('capState structurally truncates an object with many keys', () => {
  const state = Object.fromEntries(
    Array.from({ length: 20_000 }, (_, i) => [`key_${i}`, { n: i, ok: true }]),
  );
  const capped = capState(state);

  assert.ok(capped.truncatedItems > 0);
  assert.ok(JSON.stringify(capped.value).length <= MAX_STATE_CHARS);
});

test('capState guarantees the serialized size across oversized shapes', () => {
  const states = [
    { deep: [[[[Array(50_000).fill('x'.repeat(50))]]]] },
    { nested: { a: Array(30_000).fill({ b: Array(5).fill(1) }) } },
    { mixed: Array.from({ length: 40_000 }, (_, i) => (i % 2 === 0 ? i : `s${i}`)) },
  ];

  for (const state of states) {
    const capped = capState(state);
    assert.ok(
      JSON.stringify(capped.value).length <= MAX_STATE_CHARS,
      'postcondition: serialized state never exceeds the cap',
    );
  }
});

test('capState reports non-serializable state instead of throwing', () => {
  const capped = capState({ big: BigInt(1) } as unknown as Record<string, unknown>);
  assert.match(JSON.stringify(capped.value), /not JSON-serializable/);
  assert.equal(capped.truncatedChars, 0);
});
