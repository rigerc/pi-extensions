import type { NoulQuestionConfig } from './types.js';

/**
 * Both built-in routers shortlist candidates locally before System One judges them, which
 * caps recall: a skill whose description shares no token with the prompt can never be
 * chosen, however obvious it is to a semantic judge. One extra Noul per enabled path
 * asks whether the shortlist was complete; only when the model answers no does a
 * second bounded pass run over the candidates the first pass never saw. A prompt whose
 * shortlist is sufficient — the common case — still costs exactly one request.
 */

/**
 * Question id for the coverage question. It lives in a reserved `coverage__` namespace:
 * candidate ids always start with `tool__` / `skill__`, so no candidate name can ever
 * produce this id and overwrite the coverage answer.
 */
export function shortlistQuestionId(kind: 'tool' | 'skill'): string {
  return `coverage__${kind}`;
}

/**
 * Coverage question over the candidate list. `false` means "something outside this
 * list is probably needed", which is the only signal that can recover a candidate the
 * local term-overlap shortlist dropped.
 */
export function buildShortlistSufficiencyQuestion(kind: 'tool' | 'skill'): NoulQuestionConfig {
  const list = kind === 'tool' ? '`tools`' : '`available_skills`';
  const noun = kind;

  return {
    type: 'noul',
    instructions: {
      question: `Does ${list} list every ${noun} this \`task\` needs?`,
      inspect: list,
      note: `Answer yes when the task is covered by the listed ${noun}s or needs none of them. Answer no only when the task likely needs a ${noun} missing from the list, so the search should widen.`,
    },
    criteria: {
      true: {
        what: `The task is covered by the listed ${noun}s, or needs none of them`,
        examples: [
          kind === 'tool'
            ? 'Query a database when a sqlite tool is listed'
            : 'Resolve a git conflict when a conflict-resolution skill is listed',
        ],
      },
      false: {
        what: `The task likely needs a ${noun} absent from the list`,
        examples: [
          kind === 'tool'
            ? 'Query a database when only file and shell tools are listed'
            : 'Build a React UI when only backend skills are listed',
        ],
      },
    },
  };
}

/** Read a coverage answer; a missing answer is treated as "sufficient" so no retry runs. */
export function readSufficiency(probability: number | undefined, threshold: number): boolean {
  if (probability === undefined || Number.isNaN(probability)) return true;
  return probability >= threshold;
}

/**
 * Union recommendation lists from successive passes, keeping the higher probability per
 * name. A widening pass judges different candidates, so overlaps must not double up.
 */
export function mergeRecommendations<T extends { name: string; probability: number }>(
  ...groups: T[][]
): T[] {
  const byName = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) {
      const previous = byName.get(item.name);
      if (!previous || item.probability > previous.probability) byName.set(item.name, item);
    }
  }
  return [...byName.values()].sort((a, b) => b.probability - a.probability);
}
