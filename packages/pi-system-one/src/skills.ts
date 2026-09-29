import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { SystemOneClient } from './system-one.js';
import type { BoolQuestionConfig, ChoiceQuestionConfig } from './types.js';
import { recentContextFrom } from './context.js';
import {
  buildShortlistSufficiencyQuestion,
  mergeRecommendations,
  readSufficiency,
  shortlistQuestionId,
} from './escalation.js';
import { DEFAULT_ROUTING_THRESHOLDS, type RoutingThresholds } from './thresholds.js';
import { candidateText, rankCandidates } from './retrieval/shortlist.js';

/**
 * Activation cutoff for the tool router.
 *
 * Re-exported here because this module owned it before skill routing gained its own
 * thresholds, and several call sites still import it from `./skills.js`.
 */
export { SYSTEM_ONE_THRESHOLD } from './thresholds.js';

/** Question-ID prefix so a merged tool+skill request can split the answers apart. */
export const SKILL_QUESTION_PREFIX = 'skill__';

/** Local shortlist size sent to System One; keeps one request inside the context budget. */
export const SKILL_CANDIDATE_LIMIT = 12;

/** Option name that means "no listed skill fits". */
export const NONE_OPTION = 'none';

/** Question id for the primary decision. Ids are never sent to the model as ids. */
export const SKILL_PRIMARY_QUESTION_ID = 'skill_primary';

export interface SkillMetadata {
  name: string;
  description: string;
  location?: string;
}

export interface SkillRecommendation {
  name: string;
  description: string;
  location?: string;
  probability: number;
}

/** Why nothing was suggested, when nothing was. */
export type SkillAbstainReason = 'none-won' | 'below-threshold' | 'no-answer';

/**
 * The outcome of one skill judgment: at most one primary plus bounded runner-ups.
 *
 * The cap is the point. Independent per-candidate questions have no way to arbitrate
 * between candidates, so without a cap every thematically adjacent skill clears the
 * threshold and the injection reproduces the "list everything" pattern that makes a
 * corpus unreadable.
 */
export interface SkillSelection {
  primary: SkillRecommendation | null;
  runnersUp: SkillRecommendation[];
  /** Probability the model assigned to `none`, when it reported a distribution. */
  noneP: number;
  abstained: boolean;
  abstainReason?: SkillAbstainReason;
}

export interface SkillRouterResult {
  query: string;
  candidates: string[];
  /** The single best skill, or null when routing abstained. */
  primary: SkillRecommendation | null;
  /** At most `maxRunnersUp` alternatives, best first. */
  runnersUp: SkillRecommendation[];
  abstained: boolean;
  abstainReason?: SkillAbstainReason;
  noneP: number;
  fallbackUsed: boolean;
  /** True when the first shortlist was judged incomplete and a second pass widened it. */
  escalated: boolean;
  elapsedMs: number;
}

/**
 * One bool question per candidate over a shared state. Each question names its candidate by
 * state path (`available_skills[i]`) instead of interpolating the name into prose,
 * and states what yes and no mean so the boundary case is not left to the model.
 */
export function buildSkillRelevanceQuestions(
  candidates: SkillMetadata[],
  task: string,
  recentContext?: string,
): Record<string, BoolQuestionConfig> {
  const questions: Record<string, BoolQuestionConfig> = {};
  candidates.forEach((candidate, index) => {
    questions[`${SKILL_QUESTION_PREFIX}${candidate.name}`] = {
      type: 'bool',
      instructions: {
        question: 'Does `available_skills[i]` provide guidance this `task` needs?',
        inspect: `available_skills[${index}]`,
        note: "Judge relevance to the task's domain and workflow, not whether the skill is generally useful. Judge only this skill. `recent_context` holds the tail of the previous turn and may clarify an abbreviated `task`.",
      },
      criteria: {
        true: {
          what: 'The skill supplies specialized steps or domain guidance the task calls for',
          examples: ['Resolving a git rebase conflict during a merge'],
        },
        false: {
          what: "The task does not need this skill's guidance",
          examples: ['Auditing accessibility for a backend-only change'],
        },
      },
    };
  });
  return questions;
}

/**
 * Choice option ids for a candidate list.
 *
 * Names are used directly, because a name is the most readable option key. If a candidate
 * is literally named `none` — the reserved abstain key — every option falls back to its
 * index instead, so the abstain option can never be shadowed by a skill.
 */
function skillOptionIds(candidates: SkillMetadata[]): string[] {
  const indexed = candidates.some((candidate) => candidate.name === NONE_OPTION);
  return candidates.map((candidate, index) => (indexed ? `s${index}` : candidate.name));
}

function toRecommendation(skill: SkillMetadata, probability: number): SkillRecommendation {
  return {
    name: skill.name,
    description: skill.description,
    location: skill.location,
    probability,
  };
}

function toProbability(raw: unknown): number {
  const value = Number(raw);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * The primary decision: one `choice` over the shortlist plus `none`.
 *
 * `none` is inserted first on purpose. The criteria map is sent to the model in key order,
 * and a trailing "none of the above" option is a known way to bias a model toward the
 * options that preceded it. Putting abstention inside the same question that picks a skill
 * — rather than in a separate classifier with its own failure mode — is what makes "load
 * nothing" a first-class outcome instead of a threshold that has to be tuned blind.
 */
export function buildSkillPrimaryQuestion(candidates: SkillMetadata[]): ChoiceQuestionConfig {
  const criteria: Record<string, string | null> = {
    [NONE_OPTION]:
      'No listed skill is needed. Choose this for small talk, for a task already answerable from the context the agent has, for a short local edit, and for anything the listed skills would not concretely change how the task is done.',
  };

  const optionIds = skillOptionIds(candidates);
  candidates.forEach((candidate, index) => {
    // The label carries the name as well as the description. A name is often the strongest
    // signal available — `threejs-skills` says what it is — while a fallback description
    // like "Skill for X" says nothing, and omitting the name leaves the model choosing
    // between opaque ids.
    const description = candidate.description.trim();
    criteria[optionIds[index]] =
      description.length > 0 ? `${candidate.name} — ${description}` : candidate.name;
  });

  return {
    type: 'choice',
    instructions: {
      question: 'Which single skill, if any, should be loaded before answering this `task`?',
      note: 'Choose the skill that would most change how the task is done. Prefer `none` when the task is small, local, or already answerable from the context the agent has.',
    },
    criteria,
  };
}

/** The primary `choice` answer, in the shape the client returns it. */
export interface SkillChoiceAnswer {
  value: unknown;
  distribution?: Record<string, number>;
}

/** Resolve a choice option id back to a candidate. An unknown id resolves to null. */
function resolveWinner(
  optionId: string,
  candidates: SkillMetadata[],
): { skill: SkillMetadata; optionId: string } | null {
  const index = skillOptionIds(candidates).indexOf(optionId);
  if (index === -1) return null;
  return { skill: candidates[index], optionId };
}

/**
 * Turn a primary `choice` plus per-candidate probabilities into a bounded decision.
 *
 * The `choice` owns abstention and the primary pick; the per-candidate values only rank
 * runner-ups. A per-candidate value above the runner-up threshold is not evidence that the
 * skill should be loaded — it is evidence that, *if* something is loaded, this is the next
 * best alternative. Treating it as a load decision is what let three thematically adjacent
 * skills be injected for one prompt.
 */
export function selectSkills(
  choice: SkillChoiceAnswer | undefined,
  probabilities: Record<string, number>,
  candidates: SkillMetadata[],
  thresholds: RoutingThresholds = DEFAULT_ROUTING_THRESHOLDS,
): SkillSelection {
  const noneP = toProbability(choice?.distribution?.[NONE_OPTION]);
  const abstain = (reason: SkillAbstainReason): SkillSelection => ({
    primary: null,
    runnersUp: [],
    noneP,
    abstained: true,
    abstainReason: reason,
  });

  // A question the model did not answer is not a "none" verdict — it is no evidence at all.
  // Both suggest nothing, but the reason is surfaced in the tool output.
  if (choice === undefined || typeof choice.value !== 'string' || choice.value.length === 0) {
    return abstain('no-answer');
  }
  if (choice.value === NONE_OPTION) {
    return abstain('none-won');
  }

  const winner = resolveWinner(choice.value, candidates);
  if (winner === null) {
    return abstain('no-answer');
  }

  if (noneP >= thresholds.noneThreshold) {
    // The model may name a skill while judging `none` almost as likely. At that point the
    // honest answer is that nothing is clearly needed, so nothing is suggested.
    return abstain('none-won');
  }

  const winnerP = choice.distribution?.[winner.optionId];
  const probability =
    winnerP === undefined ? (probabilities[winner.skill.name] ?? 0) : toProbability(winnerP);

  if (probability < thresholds.minWinnerProbability) {
    return abstain('below-threshold');
  }

  const runnersUp = candidates
    .filter((candidate) => candidate.name !== winner.skill.name)
    .map((candidate) => toRecommendation(candidate, probabilities[candidate.name] ?? 0))
    .filter((candidate) => candidate.probability >= thresholds.runnerUpThreshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, thresholds.maxRunnersUp);

  return {
    primary: toRecommendation(winner.skill, probability),
    runnersUp,
    noneP,
    abstained: false,
  };
}

/**
 * Combine the selections of two widening passes.
 *
 * A widening pass judges candidates the first pass never saw, so the two passes produce two
 * independent primary picks. The more probable one wins; the loser is demoted into the
 * runner-up pool rather than dropped, because it was still the best answer available for
 * the part of the corpus the second pass covered.
 */
export function mergeSkillSelections(
  first: SkillSelection,
  second: SkillSelection,
  thresholds: RoutingThresholds = DEFAULT_ROUTING_THRESHOLDS,
): SkillSelection {
  const primaries = [first.primary, second.primary].filter(
    (primary): primary is SkillRecommendation => primary !== null,
  );
  primaries.sort((a, b) => b.probability - a.probability);
  const primary = primaries[0] ?? null;

  const runnersUp = mergeRecommendations(first.runnersUp, second.runnersUp, primaries.slice(1))
    .filter((candidate) => candidate.name !== primary?.name)
    .filter((candidate) => candidate.probability >= thresholds.runnerUpThreshold)
    .slice(0, thresholds.maxRunnersUp);

  const noneP = Math.max(first.noneP, second.noneP);
  if (primary !== null) {
    return { primary, runnersUp, noneP, abstained: false };
  }
  return {
    primary: null,
    runnersUp,
    noneP,
    abstained: true,
    abstainReason: first.abstainReason ?? second.abstainReason ?? 'no-answer',
  };
}

export class SkillRouter {
  private pi: ExtensionAPI;
  private systemOneClient: SystemOneClient;

  constructor(pi: ExtensionAPI, systemOneClient: SystemOneClient) {
    this.pi = pi;
    this.systemOneClient = systemOneClient;
  }

  public getAvailableSkills(ctx?: ExtensionContext | ExtensionCommandContext): SkillMetadata[] {
    const skillsMap = new Map<string, SkillMetadata>();

    // 1. Check systemPromptOptions if available in command context
    if (ctx && 'getSystemPromptOptions' in ctx) {
      try {
        const opts = (ctx as ExtensionCommandContext).getSystemPromptOptions();
        if (opts.skills && Array.isArray(opts.skills)) {
          for (const s of opts.skills as any[]) {
            if (s.name && s.description) {
              skillsMap.set(s.name, {
                name: s.name,
                description: s.description,
                location: s.filePath || s.location || s.path,
              });
            }
          }
        }
      } catch {
        // Fall back to commands/prompts inspection
      }
    }

    // 2. Discover from pi.getCommands() which lists skills as source: "skill"
    const commands = this.pi.getCommands();
    for (const cmd of commands) {
      if (cmd.source !== 'skill') continue;
      // Pi command names already include `skill:`; metadata uses the bare name.
      const name = cmd.name.replace(/^skill:/, '');
      if (!skillsMap.has(name)) {
        skillsMap.set(name, {
          name,
          description: cmd.description || `Skill for ${name}`,
          location: cmd.sourceInfo?.path,
        });
      }
    }

    return Array.from(skillsMap.values());
  }

  /**
   * Exclude names already judged by an earlier pass, so a widening pass adds only new ones.
   *
   * Ranking is BM25 over the name and description (see `src/retrieval/`). This ordering is
   * the recall ceiling for skill routing: a skill outside the shortlist cannot be chosen at
   * any confidence, so it is the part of the path most worth getting right.
   */
  public shortlist(
    skills: SkillMetadata[],
    query: string,
    limit = 10,
    exclude?: ReadonlySet<string>,
  ): SkillMetadata[] {
    const pool =
      exclude && exclude.size > 0 ? skills.filter((skill) => !exclude.has(skill.name)) : skills;
    return rankCandidates(pool, query, candidateText)
      .slice(0, limit)
      .map((ranked) => ranked.candidate);
  }

  /**
   * One System One pass over a candidate set: a primary Choice over the shortlist plus
   * `none`, one relevance bool question per skill to rank runner-ups, and a coverage bool
   * question that reports whether the local shortlist missed something.
   */
  private async judgePass(
    query: string,
    recentContext: string,
    candidates: SkillMetadata[],
    thresholds: RoutingThresholds,
    signal?: AbortSignal,
  ): Promise<{ selection: SkillSelection; sufficient: boolean }> {
    const coverageId = shortlistQuestionId('skill');
    const res = await this.systemOneClient.evaluate(
      {
        state: { task: query, recent_context: recentContext, available_skills: candidates },
        questions: {
          [SKILL_PRIMARY_QUESTION_ID]: buildSkillPrimaryQuestion(candidates),
          ...buildSkillRelevanceQuestions(candidates, query, recentContext),
          [coverageId]: buildShortlistSufficiencyQuestion('skill'),
        },
      },
      signal,
    );

    const probabilities: Record<string, number> = {};
    for (const c of candidates) {
      probabilities[c.name] = Number(res.answers[`${SKILL_QUESTION_PREFIX}${c.name}`]?.value ?? 0);
    }

    const choice = res.answers[SKILL_PRIMARY_QUESTION_ID];
    const coverage = Number(res.answers[coverageId]?.value);
    return {
      selection: selectSkills(
        choice === undefined
          ? undefined
          : { value: choice.value, distribution: choice.distribution },
        probabilities,
        candidates,
        thresholds,
      ),
      sufficient: readSufficiency(
        Number.isNaN(coverage) ? undefined : coverage,
        thresholds.coverageThreshold,
      ),
    };
  }

  /**
   * Keyword-only candidates at zero confidence; used when System One cannot judge.
   *
   * The primary is the best lexical match and the next few become runner-ups, all at
   * probability zero. A lexical hit is a hint, not a judgment, so reporting a confident
   * number here would invent one; `fallbackUsed` on the result is what tells the caller the
   * difference.
   */
  private keywordFallback(
    query: string,
    candidates: SkillMetadata[],
    thresholds: RoutingThresholds,
  ): SkillSelection {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const matches = candidates
      .filter((c) => terms.some((t) => `${c.name} ${c.description}`.toLowerCase().includes(t)))
      .map((c) => toRecommendation(c, 0));

    const [primary = null, ...rest] = matches;
    if (primary === null) {
      return {
        primary: null,
        runnersUp: [],
        noneP: 0,
        abstained: true,
        abstainReason: 'no-answer',
      };
    }
    return {
      primary,
      runnersUp: rest.slice(0, thresholds.maxRunnersUp),
      noneP: 0,
      abstained: false,
    };
  }

  public async findSkills(
    query: string,
    thresholds: Partial<RoutingThresholds> = {},
    ctx?: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SkillRouterResult> {
    const limits: RoutingThresholds = { ...DEFAULT_ROUTING_THRESHOLDS, ...thresholds };
    const startTime = Date.now();
    const allSkills = this.getAvailableSkills(ctx);
    const recentContext = recentContextFrom(ctx);
    const firstCandidates = this.shortlist(allSkills, query, SKILL_CANDIDATE_LIMIT);
    const candidateNames = firstCandidates.map((c) => c.name);

    const build = (
      selection: SkillSelection,
      extra: { candidates?: string[]; fallbackUsed?: boolean; escalated?: boolean } = {},
    ): SkillRouterResult => ({
      query,
      candidates: extra.candidates ?? candidateNames,
      primary: selection.primary,
      runnersUp: selection.runnersUp,
      abstained: selection.abstained,
      abstainReason: selection.abstainReason,
      noneP: selection.noneP,
      fallbackUsed: extra.fallbackUsed ?? false,
      escalated: extra.escalated ?? false,
      elapsedMs: Date.now() - startTime,
    });

    if (firstCandidates.length === 0) {
      return build({
        primary: null,
        runnersUp: [],
        noneP: 0,
        abstained: true,
        abstainReason: 'no-answer',
      });
    }

    if (!this.systemOneClient.isConfigured()) {
      return build(this.keywordFallback(query, firstCandidates, limits), { fallbackUsed: true });
    }

    let selection: SkillSelection;
    let sufficient = true;
    try {
      const first = await this.judgePass(query, recentContext, firstCandidates, limits, signal);
      selection = first.selection;
      sufficient = first.sufficient;
    } catch {
      return build(this.keywordFallback(query, firstCandidates, limits), { fallbackUsed: true });
    }

    if (sufficient) {
      return build(selection);
    }

    // The shortlist was judged incomplete: widen once over the skills it never saw.
    const seen = new Set(candidateNames);
    const remainder = this.shortlist(allSkills, query, SKILL_CANDIDATE_LIMIT, seen);
    if (remainder.length === 0) {
      return build(selection);
    }

    try {
      const second = await this.judgePass(query, recentContext, remainder, limits, signal);
      return build(mergeSkillSelections(selection, second.selection, limits), {
        candidates: [...candidateNames, ...remainder.map((c) => c.name)],
        escalated: true,
      });
    } catch {
      // A failed widening pass must not discard what the first pass already judged.
      return build(selection);
    }
  }
}
