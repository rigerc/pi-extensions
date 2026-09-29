/**
 * Shared shortlist construction: rank candidates against a prompt, best first.
 *
 * Both routers shortlist locally before any model call, so this ordering is the recall
 * ceiling for routing — a candidate absent from the shortlist cannot be chosen at any
 * confidence. One implementation serves tools and skills so a change to ranking cannot
 * drift between the two paths; the only difference is the text each path scores.
 */

import { rankBm25 } from './bm25.js';

export interface RankedCandidate<T> {
  candidate: T;
  /** BM25 score. Zero means the text shares no term with the query. */
  score: number;
}

/** Name plus description: the text a capability is retrieved on. */
export function candidateText(candidate: { name: string; description?: string }): string {
  return `${candidate.name} ${candidate.description ?? ''}`.trim();
}

/**
 * Rank `candidates` against `query`, best first.
 *
 * `textOf` is required rather than defaulted because the tool path scores additional
 * fields (its prompt snippet) that the skill path has no equivalent for; making the
 * difference explicit is what stops one path silently losing signal.
 *
 * Candidates that share no term with the query are kept, scored zero, in their original
 * order. A shortlist is then never empty for a query the corpus has no vocabulary for, and
 * the model still gets a chance to judge — or to answer `none`.
 */
export function rankCandidates<T>(
  candidates: readonly T[],
  query: string,
  textOf: (candidate: T) => string,
): RankedCandidate<T>[] {
  if (candidates.length === 0) return [];

  // Index ids, not names: two candidates may legitimately share a name across kinds, and
  // BM25 tie-breaks on id. Ids are zero-padded so that lexicographic id order equals input
  // order — without the padding, an all-zero-score shortlist for a 12-candidate corpus would
  // come back as 0, 1, 10, 11, 2, 3 … which silently lets corpus size decide what the model
  // sees and makes a shortlist unreproducible across corpus sizes.
  const width = String(candidates.length).length;
  const docs = candidates.map((candidate, index) => ({
    id: String(index).padStart(width, '0'),
    text: textOf(candidate),
  }));

  return rankBm25(docs, query).map((hit) => ({
    candidate: candidates[Number(hit.id)] as T,
    score: hit.score,
  }));
}
