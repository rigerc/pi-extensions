import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTING_THRESHOLDS, evaluatePromptHeuristics } from '../src/thresholds.js';

test('routing thresholds keep abstention, winner and runner-up decisions separate', () => {
  // A single cutoff for all three was the bug: a value high enough to suppress noise also
  // rejected correct winners, and the two could not be tuned independently.
  assert.ok(DEFAULT_ROUTING_THRESHOLDS.noneThreshold < DEFAULT_ROUTING_THRESHOLDS.runnerUpThreshold);
  assert.ok(DEFAULT_ROUTING_THRESHOLDS.minWinnerProbability < DEFAULT_ROUTING_THRESHOLDS.noneThreshold);
});

test('evaluatePromptHeuristics rejects prompts that carry no routing signal', () => {
  assert.deepEqual(evaluatePromptHeuristics(''), { skip: true, reason: 'empty' });
  assert.deepEqual(evaluatePromptHeuristics('   '), { skip: true, reason: 'empty' });
  assert.deepEqual(evaluatePromptHeuristics('/system-one status'), {
    skip: true,
    reason: 'slash-command',
  });
  assert.deepEqual(evaluatePromptHeuristics('fix it'), { skip: true, reason: 'too-short' });
  // Whole-prompt stall phrases, long enough to survive the length check first.
  assert.deepEqual(evaluatePromptHeuristics('looks good to me'), { skip: true, reason: 'stall' });
  assert.deepEqual(evaluatePromptHeuristics('  Good morning  '), { skip: true, reason: 'stall' });
});

test('evaluatePromptHeuristics routes a stall word that is part of a real task', () => {
  // Matched as a whole prompt, never as a substring: this is a task, not a social turn.
  assert.equal(evaluatePromptHeuristics('thanks, now fix the parser').skip, false);
  assert.equal(evaluatePromptHeuristics('inspect docker logs').skip, false);
  assert.equal(evaluatePromptHeuristics('ok, refactor the router').skip, false);
});

test('evaluatePromptHeuristics honours a caller minimum length', () => {
  assert.equal(evaluatePromptHeuristics('fix it', { minPromptChars: 3 }).skip, false);
  assert.equal(evaluatePromptHeuristics('fix it', { minPromptChars: 100 }).skip, true);
});
