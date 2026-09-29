import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bm25Ranker,
  evaluateShortlist,
  formatMetrics,
  substringRanker,
  type EvaluableCandidate,
} from '../src/eval/shortlist-metrics.js';

const candidates: EvaluableCandidate[] = [
  { id: 'a', text: 'alpha' },
  { id: 'b', text: 'beta' },
  { id: 'c', text: 'gamma' },
];

/** Always returns the same order, so the metric arithmetic can be checked by hand. */
const fixedOrder = () => ['a', 'b', 'c'];

test('evaluateShortlist computes recall, MRR and top1 over ranked targets', () => {
  const metrics = evaluateShortlist(
    candidates,
    [
      { prompt: 'first', target: 'a' },
      { prompt: 'second', target: 'b' },
      { prompt: 'third', target: 'c' },
    ],
    fixedOrder,
    2,
  );

  assert.equal(metrics.evaluated, 3);
  assert.equal(metrics.skipped, 0);
  assert.equal(metrics.recallAtK, 2 / 3, 'ranks 1 and 2 are within K=2, rank 3 is not');
  assert.equal(metrics.top1, 1 / 3);
  assert.ok(Math.abs(metrics.mrr - (1 + 1 / 2 + 1 / 3) / 3) < 1e-12);
  assert.deepEqual(
    metrics.ranks.map((entry) => entry.rank),
    [1, 2, 3],
  );
});

test('evaluateShortlist skips a query whose target is not installed', () => {
  // The corpus is whatever is on the machine, so a stale fixture must not be counted as a
  // ranking failure — but the skip has to be visible, or a shrinking corpus could reduce the
  // evaluation to nothing without anyone noticing.
  const metrics = evaluateShortlist(
    candidates,
    [
      { prompt: 'present', target: 'a' },
      { prompt: 'absent', target: 'not-installed' },
    ],
    fixedOrder,
    1,
  );

  assert.equal(metrics.evaluated, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.recallAtK, 1);
});

test('evaluateShortlist scores an unranked target as a miss rather than crashing', () => {
  const partial = () => ['a', 'b'];
  const metrics = evaluateShortlist(candidates, [{ prompt: 'missing', target: 'c' }], partial, 1);
  assert.equal(metrics.recallAtK, 0);
  assert.equal(metrics.ranks[0]?.rank, 3, 'an unreturned candidate ranks past the end');
});

test('evaluateShortlist reports zero metrics when nothing was evaluated', () => {
  const metrics = evaluateShortlist(candidates, [], fixedOrder, 5);
  assert.equal(metrics.evaluated, 0);
  assert.equal(metrics.recallAtK, 0);
  assert.equal(metrics.mrr, 0);
  assert.equal(metrics.top1, 0);
});

test('the substring baseline reproduces the inside-word match the port was about', () => {
  // A faithful copy of the ranker BM25 replaced, so the before/after comparison is against
  // what actually ran and not against a guess about it.
  const corpus: EvaluableCandidate[] = [
    { id: 'paddling', text: 'notes about paddling and rowing' },
    { id: 'arithmetic', text: 'add two numbers together' },
  ];

  assert.equal(substringRanker(corpus, 'add')[0], 'paddling', '`add` matched inside paddling');
  assert.equal(bm25Ranker(corpus, 'add')[0], 'arithmetic', 'BM25 matches the whole word only');
});

test('formatMetrics names the cutoff and reports skipped fixtures', () => {
  const metrics = evaluateShortlist(candidates, [{ prompt: 'x', target: 'a' }], fixedOrder, 8);
  const line = formatMetrics('after', metrics, 8);
  assert.match(line, /^after\s+recall@8=100\.0%/);
  assert.match(line, /mrr=1\.000/);
  assert.match(line, /n=1$/);

  const withSkips = evaluateShortlist(
    candidates,
    [
      { prompt: 'x', target: 'a' },
      { prompt: 'y', target: 'absent' },
    ],
    fixedOrder,
    8,
  );
  assert.match(formatMetrics('after', withSkips, 8), /skipped 1/);
});
