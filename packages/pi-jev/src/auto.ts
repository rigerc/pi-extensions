import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { recentContextFrom } from "./context.js";
import {
  buildShortlistSufficiencyQuestion,
  mergeRecommendations,
  readSufficiency,
  shortlistQuestionId,
} from "./escalation.js";
import {
  TOOL_CANDIDATE_LIMIT,
  TOOL_QUESTION_PREFIX,
  buildToolRelevanceQuestions,
  type ToolMetadata,
  type ToolRouter,
} from "./router.js";
import {
  JEV_THRESHOLD,
  SKILL_CANDIDATE_LIMIT,
  SKILL_QUESTION_PREFIX,
  buildSkillRelevanceQuestions,
  type SkillMetadata,
  type SkillRouter,
} from "./skills.js";
import type { JevAnswerResult, QuestionConfig } from "./types.js";

export type AutoSkipReason =
  | "disabled"
  | "unconfigured"
  | "busy"
  | "empty-prompt"
  | "error";

export interface AutoRouteResult {
  ran: boolean;
  reason?: AutoSkipReason;
  /** Whether the tool-routing path ran for this prompt. */
  toolRouting: boolean;
  /** Whether the skill-routing path ran for this prompt. */
  skillRouting: boolean;
  activated: string[];
  skills: Array<{ name: string; probability: number }>;
  elapsedMs: number;
  /** True when a shortlist was judged incomplete and a second request widened the search. */
  escalated: boolean;
  /** Which paths actually widened; both false means one request served the prompt. */
  widened: { tools: boolean; skills: boolean };
}

export { JEV_THRESHOLD };

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
  skills: Array<{ name: string; probability: number }>;
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
  recentContext: string
): { state: Record<string, unknown>; questions: Record<string, QuestionConfig> } {
  const toolCoverageId = shortlistQuestionId("tool");
  const skillCoverageId = shortlistQuestionId("skill");

  const questions: Record<string, QuestionConfig> = {
    ...buildToolRelevanceQuestions(toolCandidates, prompt, recentContext),
    ...buildSkillRelevanceQuestions(skillCandidates, prompt, recentContext),
    ...(toolCandidates.length > 0
      ? { [toolCoverageId]: buildShortlistSufficiencyQuestion("tool") }
      : {}),
    ...(skillCandidates.length > 0
      ? { [skillCoverageId]: buildShortlistSufficiencyQuestion("skill") }
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
  answers: Record<string, JevAnswerResult>,
  toolCandidates: ToolMetadata[],
  skillCandidates: SkillMetadata[],
  threshold: number
): {
  toolProbabilities: Record<string, number>;
  skillProbabilities: Record<string, number>;
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

  // Coverage is only asked for a path that had candidates, so a missing answer means
  // "sufficient" and never triggers a pointless retry.
  return {
    toolProbabilities,
    skillProbabilities,
    toolSufficient:
      toolCandidates.length === 0 ||
      readSufficiency(probabilityOf(answers[shortlistQuestionId("tool")]?.value), threshold),
    skillSufficient:
      skillCandidates.length === 0 ||
      readSufficiency(probabilityOf(answers[shortlistQuestionId("skill")]?.value), threshold),
  };
}

/**
 * Automatic Jev usage: runs a routing pass per user prompt before the agent starts.
 *
 * Tool routing and skill routing keep independent switches, so a disabled path costs
 * nothing. Both enabled paths share one Jev request: their questions read the same
 * prompt state and run in parallel inside a request, so a second request would only
 * add cost. When Jev judges a path's local shortlist incomplete, one bounded widening
 * pass runs for that path alone. Both paths share `JEV_THRESHOLD` so their
 * precision/recall stays aligned.
 */
export class AutoJev {
  private toolsEnabled: boolean;
  private skillsEnabled: boolean;
  private running = false;

  constructor(
    private jevClient: JevClient,
    private router: ToolRouter,
    private skillRouter: SkillRouter,
    enabled = false,
    skillsEnabled?: boolean
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
   * the caller widen only the path Jev judged incomplete.
   */
  private async pass(
    prompt: string,
    ctx: ExtensionContext | undefined,
    signal: AbortSignal | undefined,
    exclude: { tools: ReadonlySet<string>; skills: ReadonlySet<string> },
    widen: WidenFlags
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
            exclude.skills
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
      recentContextFrom(ctx)
    );

    if (Object.keys(questions).length === 0) {
      return {
        activated: [],
        skills: [],
        toolSufficient: true,
        skillSufficient: true,
        judged,
        seen,
      };
    }

    const response = await this.jevClient.evaluate({ state, questions }, signal);
    const read = readCombinedAnswers(
      response.answers,
      toolCandidates,
      skillCandidates,
      JEV_THRESHOLD
    );

    const activated =
      this.toolsEnabled && toolCandidates.length > 0
        ? this.router.applyActivation(
            read.toolProbabilities,
            JEV_THRESHOLD,
            toolCandidates.map((c) => c.name)
          )
        : [];
    const skills =
      this.skillsEnabled && skillCandidates.length > 0
        ? this.skillRouter.applyRecommendations(
            read.skillProbabilities,
            JEV_THRESHOLD,
            skillCandidates
          )
        : [];

    return {
      activated,
      skills: skills.map((s) => ({ name: s.name, probability: s.probability })),
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
    signal?: AbortSignal
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

    if (!this.anyEnabled) return skip("disabled");
    if (this.running) return skip("busy");
    if (!prompt || !prompt.trim() || prompt.trim().startsWith("/")) {
      return skip("empty-prompt");
    }
    if (!this.jevClient.isConfigured()) return skip("unconfigured");

    this.running = true;
    try {
      const first = await this.pass(prompt, ctx, signal, NO_EXCLUDE, { tools: true, skills: true });
      let activated = first.activated;
      let skills = first.skills;
      let widened = { tools: false, skills: false };

      // Widen only the path(s) Jev judged incomplete, so a tool-only shortfall never
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
          skills = mergeRecommendations(skills, second.skills).map((s) => ({
            name: s.name,
            probability: s.probability,
          }));
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
        skills,
        escalated: widened.tools || widened.skills,
        widened,
        elapsedMs: Date.now() - startTime,
      };
    } catch {
      return skip("error");
    } finally {
      this.running = false;
    }
  }
}
