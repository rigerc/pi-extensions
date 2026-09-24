import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import type { NoulQuestionConfig } from "./types.js";
import { recentContextFrom } from "./context.js";
import {
  buildShortlistSufficiencyQuestion,
  mergeRecommendations,
  readSufficiency,
  shortlistQuestionId,
} from "./escalation.js";

/** Single activation cutoff for Jev probabilities. Raise to reduce noise, lower for recall. */
export const JEV_THRESHOLD = 0.65;

/** Question-ID prefix so a merged tool+skill request can split the answers apart. */
export const SKILL_QUESTION_PREFIX = "skill__";

/** Local shortlist size sent to Jev; keeps one request inside the context budget. */
export const SKILL_CANDIDATE_LIMIT = 12;

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

export interface SkillRouterResult {
  query: string;
  candidates: string[];
  recommended: SkillRecommendation[];
  fallbackUsed: boolean;
  /** True when the first shortlist was judged incomplete and a second pass widened it. */
  escalated: boolean;
  elapsedMs: number;
}

/**
 * One Noul per candidate over a shared state. Each question names its candidate by
 * state path (`available_skills[i]`) instead of interpolating the name into prose,
 * and states what yes and no mean so the boundary case is not left to the model.
 */
export function buildSkillRelevanceQuestions(
  candidates: SkillMetadata[],
  task: string,
  recentContext?: string
): Record<string, NoulQuestionConfig> {
  const questions: Record<string, NoulQuestionConfig> = {};
  candidates.forEach((candidate, index) => {
    questions[`${SKILL_QUESTION_PREFIX}${candidate.name}`] = {
      type: "noul",
      instructions: {
        question: "Does `available_skills[i]` provide guidance this `task` needs?",
        inspect: `available_skills[${index}]`,
        note: "Judge relevance to the task's domain and workflow, not whether the skill is generally useful. Judge only this skill. `recent_context` holds the tail of the previous turn and may clarify an abbreviated `task`.",
      },
      criteria: {
        true: {
          what: "The skill supplies specialized steps or domain guidance the task calls for",
          examples: ["Resolving a git rebase conflict during a merge"],
        },
        false: {
          what: "The task does not need this skill's guidance",
          examples: ["Auditing accessibility for a backend-only change"],
        },
      },
    };
  });
  return questions;
}

export class SkillRouter {
  private pi: ExtensionAPI;
  private jevClient: JevClient;

  constructor(pi: ExtensionAPI, jevClient: JevClient) {
    this.pi = pi;
    this.jevClient = jevClient;
  }

  public getAvailableSkills(ctx?: ExtensionContext | ExtensionCommandContext): SkillMetadata[] {
    const skillsMap = new Map<string, SkillMetadata>();

    // 1. Check systemPromptOptions if available in command context
    if (ctx && "getSystemPromptOptions" in ctx) {
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
      if (cmd.source !== "skill") continue;
      // Pi command names already include `skill:`; metadata uses the bare name.
      const name = cmd.name.replace(/^skill:/, "");
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

  /** Exclude names already judged by an earlier pass, so a widening pass adds only new ones. */
  public shortlist(
    skills: SkillMetadata[],
    query: string,
    limit = 10,
    exclude?: ReadonlySet<string>
  ): SkillMetadata[] {
    const pool = exclude && exclude.size > 0 ? skills.filter((skill) => !exclude.has(skill.name)) : skills;
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (terms.length === 0) {
      return pool.slice(0, limit);
    }

    const scored = pool.map((skill) => {
      const text = `${skill.name} ${skill.description}`.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (text.includes(term)) matchCount += 1;
      }
      return { skill, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.skill);
  }

  /** Rank candidates whose judged probability clears `threshold`, most probable first. */
  public applyRecommendations(
    probabilities: Record<string, number>,
    threshold: number,
    candidates: SkillMetadata[]
  ): SkillRecommendation[] {
    return candidates
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: skill.location,
        probability: probabilities[skill.name] ?? 0,
      }))
      .filter((skill) => skill.probability >= threshold)
      .sort((a, b) => b.probability - a.probability);
  }

  /**
   * One Jev pass over a candidate set: one relevance Noul per skill plus a coverage
   * Noul that reports whether the local shortlist missed something.
   */
  private async judgePass(
    query: string,
    recentContext: string,
    candidates: SkillMetadata[],
    threshold: number,
    signal?: AbortSignal
  ): Promise<{ recommended: SkillRecommendation[]; sufficient: boolean }> {
    const coverageId = shortlistQuestionId("skill");
    const res = await this.jevClient.evaluate(
      {
        state: { task: query, recent_context: recentContext, available_skills: candidates },
        questions: {
          ...buildSkillRelevanceQuestions(candidates, query, recentContext),
          [coverageId]: buildShortlistSufficiencyQuestion("skill"),
        },
      },
      signal
    );

    const probabilities: Record<string, number> = {};
    for (const c of candidates) {
      probabilities[c.name] = Number(
        res.answers[`${SKILL_QUESTION_PREFIX}${c.name}`]?.value ?? 0
      );
    }

    const coverage = Number(res.answers[coverageId]?.value);
    return {
      recommended: this.applyRecommendations(probabilities, threshold, candidates),
      sufficient: readSufficiency(Number.isNaN(coverage) ? undefined : coverage, threshold),
    };
  }

  /** Keyword-only candidates at zero confidence; used when Jev cannot judge. */
  private keywordFallback(query: string, candidates: SkillMetadata[]): SkillRecommendation[] {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return candidates
      .filter((c) => terms.some((t) => `${c.name} ${c.description}`.toLowerCase().includes(t)))
      .map((c) => ({
        name: c.name,
        description: c.description,
        location: c.location,
        probability: 0,
      }));
  }

  public async findSkills(
    query: string,
    threshold = JEV_THRESHOLD,
    ctx?: ExtensionContext,
    signal?: AbortSignal
  ): Promise<SkillRouterResult> {
    const startTime = Date.now();
    const allSkills = this.getAvailableSkills(ctx);
    const recentContext = recentContextFrom(ctx);
    const firstCandidates = this.shortlist(allSkills, query, SKILL_CANDIDATE_LIMIT);
    const candidateNames = firstCandidates.map((c) => c.name);

    if (firstCandidates.length === 0) {
      return {
        query,
        candidates: [],
        recommended: [],
        fallbackUsed: false,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    if (!this.jevClient.isConfigured()) {
      return {
        query,
        candidates: candidateNames,
        recommended: this.keywordFallback(query, firstCandidates),
        fallbackUsed: true,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    let recommended: SkillRecommendation[] = [];
    let sufficient = true;
    try {
      const first = await this.judgePass(query, recentContext, firstCandidates, threshold, signal);
      recommended = first.recommended;
      sufficient = first.sufficient;
    } catch {
      return {
        query,
        candidates: candidateNames,
        recommended: this.keywordFallback(query, firstCandidates),
        fallbackUsed: true,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    if (sufficient) {
      return {
        query,
        candidates: candidateNames,
        recommended,
        fallbackUsed: false,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    // The shortlist was judged incomplete: widen once over the skills it never saw.
    const seen = new Set(candidateNames);
    const remainder = this.shortlist(allSkills, query, SKILL_CANDIDATE_LIMIT, seen);
    if (remainder.length === 0) {
      return {
        query,
        candidates: candidateNames,
        recommended,
        fallbackUsed: false,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    try {
      const second = await this.judgePass(query, recentContext, remainder, threshold, signal);
      return {
        query,
        candidates: [...candidateNames, ...remainder.map((c) => c.name)],
        recommended: mergeRecommendations(recommended, second.recommended),
        fallbackUsed: false,
        escalated: true,
        elapsedMs: Date.now() - startTime,
      };
    } catch {
      // A failed widening pass must not discard what the first pass already judged.
      return {
        query,
        candidates: candidateNames,
        recommended,
        fallbackUsed: false,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }
  }
}
