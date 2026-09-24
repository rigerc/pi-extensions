import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { isJevTool, type NoulQuestionConfig } from "./types.js";
import { JEV_THRESHOLD } from "./skills.js";
import { recentContextFrom } from "./context.js";
import {
  buildShortlistSufficiencyQuestion,
  readSufficiency,
  shortlistQuestionId,
} from "./escalation.js";

/** Question-ID prefix so a merged tool+skill request can split the answers apart. */
export const TOOL_QUESTION_PREFIX = "tool__";

/** Local shortlist size sent to Jev; keeps one request inside the context budget. */
export const TOOL_CANDIDATE_LIMIT = 10;

export interface ToolMetadata {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface RouterResult {
  query: string;
  candidates: string[];
  activated: string[];
  probabilities: Record<string, number>;
  fallbackUsed: boolean;
  /** True when the first shortlist was judged incomplete and a second pass widened it. */
  escalated: boolean;
  elapsedMs: number;
}

/**
 * One Noul per candidate over a shared state. Each question names its candidate by
 * state path (`tools[i]`) instead of interpolating the name into prose, and states
 * what yes and no mean so the boundary case is not left to the model.
 */
export function buildToolRelevanceQuestions(
  candidates: ToolMetadata[],
  task: string,
  recentContext?: string
): Record<string, NoulQuestionConfig> {
  const questions: Record<string, NoulQuestionConfig> = {};
  candidates.forEach((candidate, index) => {
    questions[`${TOOL_QUESTION_PREFIX}${candidate.name}`] = {
      type: "noul",
      instructions: {
        question: "Does `tools[i]` provide a capability this `task` needs?",
        inspect: `tools[${index}]`,
        note: "Judge only this tool. Answer no when the active tool set already covers the capability, or when the tool is merely thematically related. `recent_context` holds the tail of the previous turn and may clarify an abbreviated `task`.",
      },
      criteria: {
        true: {
          what: "The tool supplies a capability the task cannot be completed without",
          examples: ["Query the SQLite database to inspect its schema"],
        },
        false: {
          what: "The task does not need this tool's capability",
          examples: ["Read a file from disk when the read tool is already active"],
        },
      },
    };
  });
  return questions;
}

export class ToolRouter {
  private pi: ExtensionAPI;
  private jevClient: JevClient;
  private managedTools = new Set<string>();

  constructor(pi: ExtensionAPI, jevClient: JevClient) {
    this.pi = pi;
    this.jevClient = jevClient;
  }

  public getAvailableTools(): ToolMetadata[] {
    const all = this.pi.getAllTools();
    return all.map((t: any) => ({
      name: t.name,
      description: t.description,
      promptSnippet: t.promptSnippet,
      promptGuidelines: t.promptGuidelines,
    }));
  }

  /** Exclude names already judged by an earlier pass, so a widening pass adds only new ones. */
  public shortlist(query: string, limit = 8, exclude?: ReadonlySet<string>): ToolMetadata[] {
    const active = new Set(this.pi.getActiveTools());
    const all = this.getAvailableTools();

    const inactive = all.filter(
      (t) => !active.has(t.name) && !isJevTool(t.name) && !(exclude?.has(t.name) ?? false)
    );
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

    if (terms.length === 0) {
      return inactive.slice(0, limit);
    }

    const scored = inactive.map((tool) => {
      const text = `${tool.name} ${tool.description || ""} ${tool.promptSnippet || ""}`.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (text.includes(term)) matchCount += 1;
      }
      return { tool, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.tool);
  }

  /**
   * Additively activate every candidate whose judged probability clears `threshold`.
   * Additive activation preserves Pi's deferred-tool loading and prompt caching.
   */
  public applyActivation(
    probabilities: Record<string, number>,
    threshold: number,
    candidateNames: string[]
  ): string[] {
    const activated = candidateNames.filter((name) => (probabilities[name] ?? 0) >= threshold);
    if (activated.length > 0) {
      const currentActive = this.pi.getActiveTools();
      const updated = Array.from(new Set([...currentActive, ...activated]));
      this.pi.setActiveTools(updated);
    }
    return activated;
  }

  /**
   * One Jev pass over a candidate set: one relevance Noul per tool plus a coverage
   * Noul that reports whether the local shortlist missed something.
   */
  private async judgePass(
    query: string,
    recentContext: string,
    candidates: ToolMetadata[],
    threshold: number,
    signal?: AbortSignal
  ): Promise<{ probabilities: Record<string, number>; sufficient: boolean }> {
    const coverageId = shortlistQuestionId("tool");
    const res = await this.jevClient.evaluate(
      {
        state: { task: query, recent_context: recentContext, tools: candidates },
        questions: {
          ...buildToolRelevanceQuestions(candidates, query, recentContext),
          [coverageId]: buildShortlistSufficiencyQuestion("tool"),
        },
      },
      signal
    );

    const probabilities: Record<string, number> = {};
    for (const c of candidates) {
      probabilities[c.name] = Number(res.answers[`${TOOL_QUESTION_PREFIX}${c.name}`]?.value ?? 0);
    }

    const coverage = Number(res.answers[coverageId]?.value);
    return {
      probabilities,
      sufficient: readSufficiency(Number.isNaN(coverage) ? undefined : coverage, threshold),
    };
  }

  public async findAndActivate(
    query: string,
    threshold = JEV_THRESHOLD,
    signal?: AbortSignal,
    ctx?: unknown
  ): Promise<RouterResult> {
    const startTime = Date.now();
    const recentContext = recentContextFrom(ctx);
    const firstCandidates = this.shortlist(query, TOOL_CANDIDATE_LIMIT);
    const candidateNames = firstCandidates.map((c) => c.name);

    if (firstCandidates.length === 0) {
      return {
        query,
        candidates: [],
        activated: [],
        probabilities: {},
        fallbackUsed: false,
        escalated: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    let probabilities: Record<string, number> = {};
    let activated: string[] = [];
    let fallbackUsed = false;

    if (this.jevClient.isConfigured()) {
      try {
        const first = await this.judgePass(query, recentContext, firstCandidates, threshold, signal);
        probabilities = first.probabilities;
        activated = this.applyActivation(probabilities, threshold, candidateNames);

        if (!first.sufficient) {
          // The shortlist was judged incomplete: widen once over the tools it never saw.
          const seen = new Set(candidateNames);
          const remainder = this.shortlist(query, TOOL_CANDIDATE_LIMIT, seen);
          if (remainder.length > 0) {
            try {
              const second = await this.judgePass(query, recentContext, remainder, threshold, signal);
              const secondNames = remainder.map((c) => c.name);
              probabilities = { ...probabilities, ...second.probabilities };
              activated = this.applyActivation(
                probabilities,
                threshold,
                [...candidateNames, ...secondNames]
              );
              return {
                query,
                candidates: [...candidateNames, ...secondNames],
                activated,
                probabilities,
                fallbackUsed: false,
                escalated: true,
                elapsedMs: Date.now() - startTime,
              };
            } catch {
              // A failed widening pass must not discard what the first pass already judged.
            }
          }
        }
      } catch {
        fallbackUsed = true;
      }
    } else {
      fallbackUsed = true;
    }

    if (fallbackUsed) {
      // Fallback does not activate tools or claim certainty without Jev judgment
      for (const c of firstCandidates) {
        probabilities[c.name] = 0;
      }
      activated = [];
    }

    return {
      query,
      candidates: candidateNames,
      activated,
      probabilities,
      fallbackUsed,
      escalated: false,
      elapsedMs: Date.now() - startTime,
    };
  }
}
