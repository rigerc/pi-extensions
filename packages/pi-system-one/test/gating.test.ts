import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoDispatch } from '../extensions/index.js';

test('shouldAutoDispatch matches multi-agent prompts and ignores ordinary ones', () => {
  assert.equal(shouldAutoDispatch('refactor the auth module'), true);
  assert.equal(shouldAutoDispatch('do a security review of the API'), true);
  assert.equal(shouldAutoDispatch('plan a complex migration to ESM'), true);
  assert.equal(shouldAutoDispatch('fix the typo in the README'), false);
  assert.equal(shouldAutoDispatch(''), false);
});
