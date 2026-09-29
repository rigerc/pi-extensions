import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SystemOneClient } from './system-one.js';
import { recentContextFrom } from './context.js';
import {
  buildShortlistSufficiencyQuestion,
  readSufficiency,
  shortlistQuestionId,
} from './escalation.js';
import {
  TOOL_CANDIDATE_LIMIT,
  TOOL_QUESTION_PREFIX,
  buildToolRelevanceQuestions,
  type ToolMetadata,
  type ToolRouter,
} from './router.js';
import {
  SYSTEM_ONE_THRESHOLD,
  SKILL_CANDIDATE_LIMIT,
  SKILL_PRIMARY_QUESTION_ID,
  SKILL_QUESTION_PREFIX,
  buildSkillPrimaryQuestion,
  buildSkillRelevanceQuestions,
  mergeSkillSelections,
  selectSkills,
  type SkillMetadata,
  type SkillRouter,
  type SkillChoiceAnswer,
  type SkillSelection,
} from './skills.js';
import type { SystemOneAnswerResult, QuestionConfig } from './types.js';
import {
  DEFAULT_ROUTING_THRESHOLDS,
  evaluatePromptHeuristics,
  type RoutingThresholds,
} from './thresholds.js';

export type AutoSkipReason =
  | 'disabled'
  | 'unconfigured'
  | 'busy'
  | 'empty-prompt'
  | 'slash-command'
  | 'too-short'
  | 'stall'
  | 'error';

/** One skill the automatic path wants the agent to consider. */
export interface AutoSkillSuggestion {
  name: string;
  probability: number;
  /** `primary` is the single best pick; `runner-up` is a bounded alternative. */
  role: 'primary' | 'runner-up';
}

export interface AutoRouteResult {
  ran: boolean;
  reason?: AutoSkipReason;
  /** Whether the tool-routing path ran for this prompt. */
  toolRouting: boolean;
  /** Whether the skill-routing path ran for this prompt. */
  skillRouting: boolean;
  activated: string[];
  /** At most one primary skill plus `maxRunnersUp` alternatives. */
  skills: AutoSkillSuggestion[];
  elapsedMs: number;
  /** True when a shortlist was judged incomplete and a second request widened the search. */
  escalated: boolean;
  /** Which paths actually widened; both false means one request served the prompt. */
  widened: { tools: boolean; skills: boolean };
}

/** No candidates judged yet, so nothing was selected. */
const EMPTY_SKILL_SELECTION: SkillSelection = {
  primary: null,
  runnersUp: [],
  noneP: 0,
  abstained: true,
  abstainReason: 'no-answer',
};

/** Flatten a selection into the display shape, primary first. */
function toSuggestions(selection: SkillSelection): AutoSkillSuggestion[] {
  const suggestions: AutoSkillSuggestion[] = [];
  if (selection.primary) {
    suggestions.push({
      name: selection.primary.name,
      probability: selection.primary.probability,
      role: 'primary',
    });
  }
  for (const runnerUp of selection.runnersUp) {
    suggestions.push({
      name: runnerUp.name,
      probability: runnerUp.probability,
      role: 'runner-up',
    });
  }
  return suggestions;
}

/**
 * The injection text for the agent, or null when no skill was suggested.
 *
 * The primary is stated first and the alternatives are explicitly conditional, because the
 * previous flat list read as "load all of these" and a runner-up is only useful when the
 * primary does not apply.
 */
export function formatAutoSkillMessage(skills: AutoSkillSuggestion[]): string | null {
  const primary = skills.find((skill) => skill.role === 'primary');
  if (!primary) return null;

  const lines = [`• /skill:${primary.name} (P=${primary.probability.toFixed(2)})`];
  const runnerUps = skills.filter((skill) => skill.role === 'runner-up');
  if (runnerUps.length > 0) {
    // The primary carries the Choice probability; an alternative carries the judged
    // relevance of its own Noul. Different measures, so they are named differently rather
    // than printed as two comparable `P=` values.
    lines.push(
      'Alternatives, only if the primary does not fit:',
      ...runnerUps.map(
        (skill) => `• /skill:${skill.name} (relevance=${skill.probability.toFixed(2)})`,
      ),
    );
  }

  return (
    'System One matched a skill for this task. Load its SKILL.md before proceeding:\n' +
    lines.join('\n')
  );
}

export { SYSTEM_ONE_THRESHOLD };

/** No candidates judged yet, for the first of the (at most two) routing passes. */
const NO_EXCLUDE: Readonly<{ tools: ReadonlySet<string>; skills: ReadonlySet<string> }> = {
  tools: new Set<string>(),
  skills: new Set<string>(),
};

function probabilityOf(value: unknown): number | undefined {
  const probability = Number(value);
  return Number.isNaN(probability) ? undefined : probability;
}

/** Which paths a routing pass may shortlist for. The first pass widens both. */
interface WidenFlags {
  tools: boolean;
  skills: boolean;
}

interface CombinedPassResult {
  activated: string[];
  skillSelection: SkillSelection;
  toolSufficient: boolean;
  skillSufficient: boolean;
  /** Candidates judged by this pass, per path; a path with none never widened. */
  judged: { tools: number; skills: number };
  /**
   * Everything judged by this pass, per path, so the next pass adds only what no pass
   * saw. Tool and skill names are separate namespaces: a tool and a skill may share a
   * name without excluding one another.
   */
  seen: { tools: Set<string>; skills: Set<string> };
}

/**
 * Assemble the one request both enabled paths share: a relevance Noul per candidate,
 * plus one coverage Noul per non-empty list. Question ids come from the shared builders,
 * so tool and skill answers can never collide in the merged answer map.
 */
export function buildCombinedRequest(
  toolCandidates: ToolMetadata[],
  skillCandidates: SkillMetadata[],
  prompt: string,
  recentContext: string,
): { state: Record<string, unknown>; questions: Record<string, QuestionConfig> } {
  const toolCoverageId = shortlistQuestionId('tool');
  const skillCoverageId = shortlistQuestionId('skill');

  const questions: Record<string, QuestionConfig> = {
    ...buildToolRelevanceQuestions(toolCandidates, prompt, recentContext),
    ...buildSkillRelevanceQuestions(skillCandidates, prompt, recentContext),
    ...(skillCandidates.length > 0
      ? { [SKILL_PRIMARY_QUESTION_ID]: buildSkillPrimaryQuestion(skillCandidates) }
      : {}),
    ...(toolCandidates.length > 0
      ? { [toolCoverageId]: buildShortlistSufficiencyQuestion('tool') }
      : {}),
    ...(skillCandidates.length > 0
      ? { [skillCoverageId]: buildShortlistSufficiencyQuestion('skill') }
      : {}),
  };

  return {
    state: {
      task: prompt,
      recent_context: recentContext,
      tools: toolCandidates,
      available_skills: skillCandidates,
    },
    questions,
  };
}

/** Split one shared answer map back into per-path probabilities and coverage verdicts. */
export function readCombinedAnswers(
  answers: Record<string, SystemOneAnswerResult>,
  toolCandidates: ToolMetadata[],
  skillCandidates: SkillMetadata[],
  thresholds: RoutingThresholds,
): {
  toolProbabilities: Record<string, number>;
  skillProbabilities: Record<string, number>;
  skillChoice: SkillChoiceAnswer | undefined;
  toolSufficient: boolean;
  skillSufficient: boolean;
} {
  const toolProbabilities: Record<string, number> = {};
  for (const c of toolCandidates) {
    toolProbabilities[c.name] = Number(answers[`${TOOL_QUESTION_PREFIX}${c.name}`]?.value ?? 0);
  }
  const skillProbabilities: Record<string, number> = {};
  for (const s of skillCandidates) {
    skillProbabilities[s.name] = Number(answers[`${SKILL_QUESTION_PREFIX}${s.name}`]?.value ?? 0);
  }

  const rawChoice = answers[SKILL_PRIMARY_QUESTION_ID];
  const skillChoice =
    rawChoice === undefined
      ? undefined
      : ({ value: rawChoice.value, distribution: rawChoice.distribution } as SkillChoiceAnswer);

  // Coverage is only asked for a path that had candidates, so a missing answer means
  // "sufficient" and never triggers a pointless retry.
  return {
    toolProbabilities,
    skillProbabilities,
    skillChoice,
    toolSufficient:
      toolCandidates.length === 0 ||
      readSufficiency(
        probabilityOf(answers[shortlistQuestionId('tool')]?.value),
        thresholds.coverageThreshold,
      ),
    skillSufficient:
      skillCandidates.length === 0 ||
      readSufficiency(
        probabilityOf(answers[shortlistQuestionId('skill')]?.value),
        thresholds.coverageThreshold,
      ),
  };
}

/**
 * Automatic System One usage: runs a routing pass per user prompt before the agent starts.
 *
 * Tool routing and skill routing keep independent switches, so a disabled path costs
 * nothing. Both enabled paths share one System One request: their questions read the same
 * prompt state and run in parallel inside a request, so a second request would only
 * Routing quality is bounded by the local shortlist, so both paths also ask a coverage Noul;
 * when Jev judges a path's shortlist incomplete, one bounded widening pass runs for that path
 * alone. Skill selection is bounded to one primary plus `maxRunnersUp` alternatives, and
 * abstention is decided by the primary Choice rather than by a per-candidate threshold.
 */
export class AutoSystemOne {
  private toolsEnabled: boolean;
  private skillsEnabled: boolean;
  private running = false;

  constructor(
    private systemOneClient: SystemOneClient,
    private router: ToolRouter,
    private skillRouter: SkillRouter,
    enabled = false,
    skillsEnabled?: boolean,
    private thresholds: RoutingThresholds = DEFAULT_ROUTING_THRESHOLDS,
  ) {
    this.toolsEnabled = enabled;
    this.skillsEnabled = skillsEnabled ?? enabled;
  }

  /** True when either routing path is on. */
  public get anyEnabled(): boolean {
    return this.toolsEnabled || this.skillsEnabled;
  }

  public get tools(): boolean {
    return this.toolsEnabled;
  }

  public get skills(): boolean {
    return this.skillsEnabled;
  }

  /** Back-compat alias for {@link anyEnabled}. */
  public get enabled(): boolean {
    return this.anyEnabled;
  }

  /** Back-compat: toggles both routing paths together. */
  public setEnabled(enabled: boolean): void {
    this.setToolsEnabled(enabled);
    this.setSkillsEnabled(enabled);
  }

  public setToolsEnabled(enabled: boolean): void {
    this.toolsEnabled = enabled;
  }

  public setSkillsEnabled(enabled: boolean): void {
    this.skillsEnabled = enabled;
  }

  /**
   * One routing pass over the candidates no earlier pass has judged. A disabled path —
   * and a path not selected by `widen` — contributes no candidates and therefore no
   * questions, so both enabled paths still travel in one request. Per-path coverage lets
   * the caller widen only the path System One judged incomplete.
   */
  private async pass(
    prompt: string,
    ctx: ExtensionContext | undefined,
    signal: AbortSignal | undefined,
    exclude: { tools: ReadonlySet<string>; skills: ReadonlySet<string> },
    widen: WidenFlags,
  ): Promise<CombinedPassResult> {
    const toolCandidates =
      this.toolsEnabled && widen.tools
        ? this.router.shortlist(prompt, TOOL_CANDIDATE_LIMIT, exclude.tools)
        : [];
    const skillCandidates =
      this.skillsEnabled && widen.skills
        ? this.skillRouter.shortlist(
            this.skillRouter.getAvailableSkills(ctx),
            prompt,
            SKILL_CANDIDATE_LIMIT,
            exclude.skills,
          )
        : [];

    const judged = { tools: toolCandidates.length, skills: skillCandidates.length };
    const seen = {
      tools: new Set<string>(toolCandidates.map((c) => c.name)),
      skills: new Set<string>(skillCandidates.map((s) => s.name)),
    };

    const { state, questions } = buildCombinedRequest(
      toolCandidates,
      skillCandidates,
      prompt,
      recentContextFrom(ctx),
    );

    if (Object.keys(questions).length === 0) {
      return {
        activated: [],
        skillSelection: EMPTY_SKILL_SELECTION,
        toolSufficient: true,
        skillSufficient: true,
        judged,
        seen,
      };
    }

    const response = await this.systemOneClient.evaluate({ state, questions }, signal);
    const read = readCombinedAnswers(
      response.answers,
      toolCandidates,
      skillCandidates,
      this.thresholds,
    );

    const activated =
      this.toolsEnabled && toolCandidates.length > 0
        ? this.router.applyActivation(
            read.toolProbabilities,
            SYSTEM_ONE_THRESHOLD,
            toolCandidates.map((c) => c.name),
          )
        : [];
    // The primary Choice decides whether anything is loaded; the per-candidate values only
    // rank the bounded runner-ups.
    const skillSelection =
      this.skillsEnabled && skillCandidates.length > 0
        ? selectSkills(read.skillChoice, read.skillProbabilities, skillCandidates, this.thresholds)
        : EMPTY_SKILL_SELECTION;

    return {
      activated,
      skillSelection,
      toolSufficient: read.toolSufficient,
      skillSufficient: read.skillSufficient,
      judged,
      seen,
    };
  }

  /** Never throws: automatic routing must not break the agent turn. */
  public async route(
    prompt: string,
    ctx?: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AutoRouteResult> {
    const startTime = Date.now();
    const skip = (reason: AutoSkipReason): AutoRouteResult => ({
      ran: false,
      reason,
      toolRouting: false,
      skillRouting: false,
      activated: [],
      skills: [],
      escalated: false,
      widened: { tools: false, skills: false },
      elapsedMs: Date.now() - startTime,
    });

    if (!this.anyEnabled) return skip('disabled');
    if (this.running) return skip('busy');
    // The automatic path pays for a request per prompt, so cheap prompts that carry no
    // routing signal are rejected locally instead.
    const heuristic = evaluatePromptHeuristics(prompt ?? '');
    if (heuristic.skip) {
      return skip(heuristic.reason === 'empty' ? 'empty-prompt' : heuristic.reason);
    }
    if (!this.systemOneClient.isConfigured()) return skip('unconfigured');

    this.running = true;
    try {
      const first = await this.pass(prompt, ctx, signal, NO_EXCLUDE, { tools: true, skills: true });
      let activated = first.activated;
      let skillSelection = first.skillSelection;
      let widened = { tools: false, skills: false };

      // Widen only the path(s) System One judged incomplete, so a tool-only shortfall never
      // re-judges skills. Still one bounded extra request, and best-effort: a failed
      // second request keeps the first pass's verdicts.
      const widen: WidenFlags = {
        tools: !first.toolSufficient && this.toolsEnabled,
        skills: !first.skillSufficient && this.skillsEnabled,
      };

      if (widen.tools || widen.skills) {
        try {
          const second = await this.pass(prompt, ctx, signal, first.seen, widen);
          activated = [...new Set([...activated, ...second.activated])];
          if (second.judged.skills > 0) {
            // Two passes produce two independent primary picks; the more probable wins and
            // the other is demoted to a runner-up rather than dropped.
            skillSelection = mergeSkillSelections(
              skillSelection,
              second.skillSelection,
              this.thresholds,
            );
          }
          widened = {
            tools: widen.tools && second.judged.tools > 0,
            skills: widen.skills && second.judged.skills > 0,
          };
        } catch {
          widened = { tools: false, skills: false };
        }
      }

      return {
        ran: true,
        toolRouting: this.toolsEnabled,
        skillRouting: this.skillsEnabled,
        activated,
        skills: toSuggestions(skillSelection),
        escalated: widened.tools || widened.skills,
        widened,
        elapsedMs: Date.now() - startTime,
      };
    } catch {
      return skip('error');
    } finally {
      this.running = false;
    }
  }
}
