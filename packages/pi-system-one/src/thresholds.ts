/**
 * Routing thresholds and the prompt heuristics that skip the network entirely.
 *
 * One number cannot serve four different decisions. Whether to abstain at all, how
 * confident a winning candidate must be, how relevant a runner-up must be, and whether a
 * shortlist was complete are separate questions with separate costs. The previous
 * behaviour used a single cutoff for all of them, which made the abstain decision and the
 * runner-up decision move together, so neither could be tuned without disturbing the
 * other.
 *
 * The starting values below come from the Skillful capability router's evaluated set
 * (`tmp/jev-skillful`, `core/router/thresholds.ts`), which swept them against a fixture
 * corpus. They are a defensible starting point, not a calibration for Pi's own prompts,
 * and the `noneThreshold` result there was explicitly close to run-to-run noise.
 */

/** Activation cutoff for the tool router. */
export const SYSTEM_ONE_THRESHOLD = 0.65;

/** The classifier apis whose probabilities should not be trusted like a hosted service's. */
export const PROMPT_CLASSIFIER_APIS: ReadonlySet<string> = new Set(['llama-cpp-classify']);

/** Whether probabilities from this api need the local-model discount before use. */
export function isPromptClassifier(api: string | null | undefined): boolean {
  return PROMPT_CLASSIFIER_APIS.has(api?.trim() ?? '');
}

/**
 * Confidence factor applied to a prompt-rendered classifier's probabilities.
 *
 * This scales the evidence, not the cut-off: a probability the local model would need to
 * reach 0.65 to pass is treated as the 0.52 a less certain judge would have given it.
 * Hosted classifiers are unaffected.
 */
export const PROMPT_CLASSIFIER_DISCOUNT = 0.8;

/**
 * Scale one judged probability for the classifier that produced it.
 *
 * A `choice` answer's `confidence` carries the same overconfidence risk as its
 * probabilities, so callers pass either through here.
 */
export function adjustProbability(probability: number, api: string | null | undefined): number {
  if (!isPromptClassifier(api)) return probability;
  return Math.max(0, Math.min(1, probability * PROMPT_CLASSIFIER_DISCOUNT));
}

export interface RoutingThresholds {
  /**
   * If `none` wins the primary choice, or its probability reaches this, nothing is
   * suggested. This is the abstain cutoff, and it is deliberately below the cutoff a
   * winner must clear: "should anything be loaded" and "is this winner certain enough"
   * are different questions.
   */
  noneThreshold: number;
  /**
   * Floor on the winning option's probability, separate from `noneThreshold`.
   *
   * Kept low because a `choice` over a dozen options routinely gives a clearly-best
   * answer well under half the probability. A floor near the tool-activation cutoff
   * would reject correct picks as `below-threshold`.
   */
  minWinnerProbability: number;
  /** Minimum judged probability for a candidate to be offered as a runner-up. */
  runnerUpThreshold: number;
  /** Upper bound on runner-ups. The primary is not counted. */
  maxRunnersUp: number;
  /** A coverage answer at or above this means the shortlist was judged complete. */
  coverageThreshold: number;
  /** Prompts shorter than this are never routed by the automatic path. */
  minPromptChars: number;
}

export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds = {
  noneThreshold: 0.4,
  minWinnerProbability: 0.25,
  runnerUpThreshold: 0.6,
  maxRunnersUp: 2,
  coverageThreshold: 0.5,
  minPromptChars: 12,
};

/**
 * Prompts that are complete messages on their own.
 *
 * Matched against the whole prompt after normalisation, never as a substring: `thanks`
 * is a social turn, while `thanks, now fix the parser` is a task and must be routed.
 */
const STALL_PROMPTS: ReadonlySet<string> = new Set([
  'thanks',
  'thank you',
  'thanks!',
  'ty',
  'thx',
  'ok',
  'okay',
  'k',
  'cool',
  'nice',
  'great',
  'perfect',
  'awesome',
  'lgtm',
  'looks good',
  'looks good to me',
  'hi',
  'hello',
  'hey',
  'yo',
  'good morning',
  'good night',
  'bye',
  'cheers',
  'nope',
  'yep',
  'yeah',
  'yes',
  'no',
  'sure',
  'got it',
  'understood',
  'continue',
  'go on',
  'next',
  'done',
  'stop',
  'carry on',
  'keep going',
  'proceed',
]);

export type PromptSkipReason = 'empty' | 'slash-command' | 'too-short' | 'stall';

export interface PromptHeuristicResultSkipped {
  skip: true;
  reason: PromptSkipReason;
}

export type PromptHeuristicResult = PromptHeuristicResultSkipped | { skip: false };

/** Lowercase, collapse whitespace, strip surrounding punctuation used for emphasis. */
function normalisePrompt(prompt: string): string {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[!.…\s]+|[!.…\s]+$/g, '');
}

/**
 * Decide whether a prompt is worth routing, without any network call.
 *
 * Four checks, in order: a slash command is the user asking for a capability by name and
 * is already resolved; an empty prompt has nothing to judge; a very short prompt carries
 * too little signal for a lexical shortlist; a stall prompt is a complete social turn.
 *
 * This applies to the automatic per-prompt path only. An explicit
 * `system_one_find_skill` call is a deliberate request, so it is never skipped here.
 */
export function evaluatePromptHeuristics(
  prompt: string,
  thresholds: Pick<RoutingThresholds, 'minPromptChars'> = DEFAULT_ROUTING_THRESHOLDS,
): PromptHeuristicResult {
  const trimmed = prompt?.trim() ?? '';

  if (trimmed.length === 0) {
    return { skip: true, reason: 'empty' };
  }
  if (trimmed.startsWith('/')) {
    return { skip: true, reason: 'slash-command' };
  }
  if (trimmed.length < thresholds.minPromptChars) {
    return { skip: true, reason: 'too-short' };
  }
  if (STALL_PROMPTS.has(normalisePrompt(trimmed))) {
    return { skip: true, reason: 'stall' };
  }
  return { skip: false };
}
