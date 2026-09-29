import test from 'node:test';
import assert from 'node:assert/strict';
import { singularize, tokenize } from '../src/retrieval/tokenize.js';

test('tokenize splits every naming convention a capability uses', () => {
  assert.deepEqual(tokenize('ngs-bulk-rnaseq'), ['ngs', 'bulk', 'rnaseq']);
  assert.deepEqual(tokenize('claudeFable'), ['claude', 'fable']);
  assert.deepEqual(tokenize('HTTPServer'), ['http', 'server']);
  assert.deepEqual(tokenize('snake_case_name'), ['snake', 'case', 'name']);
});

test('tokenize drops a documentation extension as naming noise', () => {
  assert.deepEqual(tokenize('SKILL.md'), ['skill']);
  assert.deepEqual(tokenize('skill.yaml'), ['skill']);
  // A code extension is kept: `transformers.js` names a library, and `js` is signal.
  // The name itself is still singularised, which is applied to both sides of a search.
  assert.deepEqual(tokenize('transformers.js'), ['transformer', 'js']);
});

test('tokenize matches whole words, so a term cannot match inside another word', () => {
  // The regression that motivated the port: the previous scorer used String#includes, so
  // `we` matched inside `powered` and `are` matched inside `software`, and generic English
  // fragments decided the shortlist order.
  assert.deepEqual(tokenize('powered'), ['powered']);
  assert.deepEqual(tokenize('software'), ['software']);
  assert.equal(tokenize('powered').includes('we'), false);
  assert.equal(tokenize('software').includes('are'), false);
});

test('tokenize drops stopwords but keeps the words that carry capability signal', () => {
  assert.deepEqual(tokenize('use the tool to fix it'), ['use', 'tool', 'fix']);
  // `create`, `write`, `add` and `use` are the most common verbs in capability descriptions
  // and a general-purpose stopword list would remove them.
  assert.deepEqual(tokenize('create a file'), ['create', 'file']);
  assert.deepEqual(tokenize('write the docs'), ['write', 'docs']);
});

test('tokenize is empty for empty input and safe for non-Latin scripts', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize('đọc tệp'), ['đọc', 'tệp']);
});

test('singularize reduces the plural endings that occur in capability text', () => {
  assert.equal(singularize('plans'), 'plan');
  assert.equal(singularize('indexes'), 'index');
  assert.equal(singularize('policies'), 'policy');
  assert.equal(singularize('annotations'), 'annotation');
  assert.equal(singularize('watches'), 'watch');
});

test('singularize leaves endings that are not plurals alone', () => {
  // Guards exist because the alternative is merging two distinct terms, which is a silent
  // loss of signal rather than a visible one.
  assert.equal(singularize('access'), 'access');
  assert.equal(singularize('status'), 'status');
  assert.equal(singularize('analysis'), 'analysis');
  // Short tokens are untouched, so `css`, `ios` and `cli` survive.
  assert.equal(singularize('css'), 'css');
  assert.equal(singularize('ios'), 'ios');
});

test('singularize mangles a non-plural -s word, but symmetrically', () => {
  // This reduction is wrong in isolation. It is harmless because a query and a document take
  // the same path, so `kubernetes` in a prompt still matches `kubernetes` in a description.
  assert.equal(singularize('kubernetes'), 'kubernete');
  assert.equal(tokenize('deploy kubernetes').at(-1), tokenize('kubernetes').at(-1));
});

test('tokenize matches the singular and plural forms of the same term', () => {
  // The regression this fixes: a prompt saying `plan` against a name saying `plans` scored
  // zero overlap, so the skill fell out of the shortlist entirely.
  assert.deepEqual(tokenize('plan'), tokenize('plans'));
  assert.deepEqual(tokenize('index'), tokenize('indexes'));
  assert.deepEqual(tokenize('policy'), tokenize('policies'));
});
