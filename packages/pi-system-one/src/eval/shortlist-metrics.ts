/**
 * Offline shortlist evaluation.
 *
 * The shortlist is the recall ceiling for routing: a candidate it drops cannot be chosen at
 * any confidence, however obvious it is to a semantic judge. Building it costs no model
 * request, which makes ranking the one part of the pipeline that can be swept entirely
 * offline — no API key, no tokens, no latency. A change to ranking should therefore be
 * measured before it ships rather than argued about.
 *
 * Recall@K is the headline number for exactly that reason: everything above the shortlist
 * can only pick from what ranking offered.
 */

import { rankBm25 } from '../retrieval/bm25.js';

export interface EvaluableCandidate {
  id: string;
  /** The text ranking scores, usually a name plus a description. */
  text: string;
}

export interface EvalQuery {
  prompt: string;
  /** Candidate id that a correct shortlist must contain. */
  target: string;
}

/** Returns every candidate id, best first. */
export interface Ranker {
  (candidates: readonly EvaluableCandidate[], prompt: string): string[];
}

export interface RankedQuery {
  prompt: string;
  target: string;
  /** 1-based position of the target. `candidates.length + 1` when unranked. */
  rank: number;
}

export interface ShortlistMetrics {
  /** Queries whose target was in the corpus, and were therefore scored. */
  evaluated: number;
  /** Queries dropped because the corpus has no such target. */
  skipped: number;
  /** Fraction of evaluated queries whose target is within the first `k`. */
  recallAtK: number;
  /** Mean reciprocal rank over evaluated queries. */
  mrr: number;
  /** Fraction of evaluated queries whose target ranks first. */
  top1: number;
  /** Per-query rank, so an outlier can be inspected rather than only counted. */
  ranks: RankedQuery[];
}

/**
 * Score a ranker over a corpus and a query set.
 *
 * A query whose target is absent from the corpus is skipped, not counted as a miss: the
 * corpus is whatever is installed, so a stale query would otherwise look like a ranking
 * failure. The skipped count is reported so a shrinking corpus cannot quietly reduce the
 * evaluation to nothing.
 */
export function evaluateShortlist(
  candidates: readonly EvaluableCandidate[],
  queries: readonly EvalQuery[],
  ranker: Ranker,
  k: number,
): ShortlistMetrics {
  const ids = new Set(candidates.map((candidate) => candidate.id));
  const ranks: RankedQuery[] = [];
  let skipped = 0;
  let hits = 0;
  let top1 = 0;
  let reciprocal = 0;

  for (const query of queries) {
    if (!ids.has(query.target)) {
      skipped += 1;
      continue;
    }

    const order = ranker(candidates, query.prompt);
    const index = order.indexOf(query.target);
    const rank = index === -1 ? order.length + 1 : index + 1;

    if (rank <= k) hits += 1;
    if (rank === 1) top1 += 1;
    reciprocal += 1 / rank;
    ranks.push({ prompt: query.prompt, target: query.target, rank });
  }

  const evaluated = ranks.length;
  return {
    evaluated,
    skipped,
    recallAtK: evaluated === 0 ? 0 : hits / evaluated,
    mrr: evaluated === 0 ? 0 : reciprocal / evaluated,
    top1: evaluated === 0 ? 0 : top1 / evaluated,
    ranks,
  };
}

/** The production ranker: BM25 over each candidate's text. */
export const bm25Ranker: Ranker = (candidates, prompt) => {
  const docs = candidates.map((candidate) => ({ id: candidate.id, text: candidate.text }));
  return rankBm25(docs, prompt).map((hit) => hit.id);
};

/**
 * The ranker BM25 replaced, kept so a change is compared against what it displaced.
 *
 * Counts query terms found as substrings, with no inverse document frequency and no length
 * normalisation, so it scores description length as much as relevance. Reproduced as it
 * behaved, including its tie-break on input order — without a faithful copy the before/after
 * comparison would be against a guess.
 */
export const substringRanker: Ranker = (candidates, prompt) => {
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return candidates
    .map((candidate, index) => {
      const text = candidate.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score += 1;
      }
      return { id: candidate.id, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.id);
};

/** Format a metric triple for a table or a log line. */
export function formatMetrics(label: string, metrics: ShortlistMetrics, k: number): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    label.padEnd(10),
    `recall@${k}=${percent(metrics.recallAtK)}`,
    `mrr=${metrics.mrr.toFixed(3)}`,
    `top1=${percent(metrics.top1)}`,
    `n=${metrics.evaluated}${metrics.skipped > 0 ? ` (skipped ${metrics.skipped})` : ''}`,
  ].join('  ');
}
