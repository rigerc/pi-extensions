import test from 'node:test';
import assert from 'node:assert/strict';
import { rankBm25 } from '../src/retrieval/bm25.js';

const docs = [
  { id: 'postgres', text: 'render-postgres Provision a managed Postgres database' },
  { id: 'cron', text: 'render-cron-jobs Schedule a recurring background job' },
  { id: 'sentry', text: 'sentry Capture and alert on production exceptions' },
];

test('rankBm25 puts the document that owns the query term first', () => {
  const ranked = rankBm25(docs, 'provision a managed database');
  assert.equal(ranked[0]?.id, 'postgres');
});

test('rankBm25 uses inverse document frequency, so a rare term beats a common one', () => {
  // `render` appears in two of three documents and `postgres` in one. Ranking on term
  // presence alone would tie them; IDF is what makes the distinctive term decide.
  const ranked = rankBm25(docs, 'render postgres');
  assert.equal(ranked[0]?.id, 'postgres');
});

test('rankBm25 keeps zero-score documents and returns every candidate', () => {
  // Dropping them would silently shrink the shortlist and turn a vocabulary miss into an
  // empty shortlist, which the router would then have nothing to judge.
  const ranked = rankBm25(docs, 'kubernetes helm chart');
  assert.equal(ranked.length, docs.length);
  assert.ok(ranked.every((hit) => hit.score === 0));
  // Deterministic: ties break on id, not on input order or on chance.
  assert.deepEqual(
    ranked.map((hit) => hit.id),
    ['cron', 'postgres', 'sentry'],
  );
});

test('rankBm25 is order-independent for equal scores but stable across runs', () => {
  const input = [
    { id: 'b', text: 'alpha' },
    { id: 'a', text: 'alpha' },
  ];
  const first = rankBm25(input, 'alpha').map((hit) => hit.id);
  const second = rankBm25(input, 'alpha').map((hit) => hit.id);
  assert.deepEqual(first, ['a', 'b']);
  assert.deepEqual(first, second);
});

test('rankBm25 normalises document length', () => {
  const verbose = {
    id: 'verbose',
    text: `deploy ${'filler '.repeat(60)}`,
  };
  const focused = { id: 'focused', text: 'deploy a static site' };
  const ranked = rankBm25([verbose, focused], 'deploy a static site');
  assert.equal(ranked[0]?.id, 'focused', 'a long padded document must not outrank a precise one');
});

test('rankBm25 handles empty corpora and empty queries without throwing', () => {
  assert.deepEqual(rankBm25([], 'anything'), []);
  assert.equal(rankBm25(docs, '').length, docs.length);
  assert.equal(rankBm25(docs, 'the and of').length, docs.length);
});
