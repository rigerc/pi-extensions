import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { SystemOneClient } from './system-one.js';
import { describeUnconfigured } from './system-one.js';
import type { ToolRouter } from './router.js';
import type { SkillRouter } from './skills.js';
import type { QuestionConfig } from './types.js';
import { SYSTEM_ONE_THRESHOLD } from './skills.js';

/**
 * One rendered skill line: name, judged score, path and description.
 *
 * The primary shows `P=` (its Choice probability) and an alternative shows `relevance=`
 * (its own Noul), because the two are different measures and printing both as `P=` would
 * invite comparing them.
 */
function formatSkillLine(
  skill: { name: string; probability: number; location?: string; description: string },
  isAlternative: boolean,
): string {
  const label = isAlternative ? '(alternative) ' : '';
  const path = skill.location ? ` - ${skill.location}` : '';
  const score = isAlternative
    ? `relevance=${skill.probability.toFixed(2)}`
    : `P=${skill.probability.toFixed(2)}`;
  return `• ${label}/skill:${skill.name} (${score})${path}\n  ${skill.description}`;
}

export function registerSystemOneTools(
  pi: ExtensionAPI,
  systemOneClient: SystemOneClient,
  router: ToolRouter,
  skillRouter: SkillRouter,
): void {
  // 1. Tool router tool: system_one_find_tools
  pi.registerTool({
    name: 'system_one_find_tools',
    label: 'System One Tool Finder',
    description:
      'Find and additively activate registered Pi tools needed for a task using System One semantic evaluation.',
    promptSnippet: 'Search and dynamically activate specialized tools for current task',
    promptGuidelines: [
      'Use system_one_find_tools when current active tools cannot accomplish the user request.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'The action, capability, or user task you need tools for.',
      }),
      threshold: Type.Optional(
        Type.Number({
          description:
            'Activation confidence threshold between 0.0 and 1.0 (default SYSTEM_ONE_THRESHOLD).',
        }),
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: 'text', text: `Evaluating candidate tools for: "${params.query}"...` }],
        details: {},
      });

      const result = await router.findAndActivate(
        params.query,
        params.threshold ?? SYSTEM_ONE_THRESHOLD,
        signal,
        ctx,
      );

      let summaryText = '';
      if (result.activated.length > 0) {
        summaryText = `Activated tools: ${result.activated.join(', ')}`;
      } else if (result.candidates.length > 0) {
        summaryText = `No tools met the activation threshold among candidates: ${result.candidates.join(', ')}`;
      } else {
        summaryText = `No matching inactive tools found.`;
      }

      if (result.escalated) {
        summaryText +=
          ' (expanded: the first shortlist was judged incomplete, so a second pass considered more tools)';
      }

      if (result.fallbackUsed) {
        summaryText +=
          ' (Note: local heuristic shortlist used due to System One unconfigured/offline)';
      }

      return {
        content: [{ type: 'text', text: summaryText }],
        details: result,
      };
    },
  });

  // 2. Skill finder tool: system_one_find_skill
  pi.registerTool({
    name: 'system_one_find_skill',
    label: 'System One Skill Finder',
    description:
      'Find and recommend the best matching agent skills for a specific task or problem using System One semantic evaluation.',
    promptSnippet: 'Discover specialized skills/workflows relevant to current task',
    promptGuidelines: [
      'Use system_one_find_skill when working on specialized tasks (e.g. testing, UI design, animations, security reviews, git conflicts) to locate the relevant SKILL.md guide.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'The task, domain, or technology you need specialized skills for.',
      }),
      threshold: Type.Optional(
        Type.Number({
          description:
            'Minimum probability the winning skill must reach, between 0.0 and 1.0 (default 0.25).',
        }),
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: 'text', text: `Evaluating matching skills for: "${params.query}"...` }],
        details: {},
      });

      const result = await skillRouter.findSkills(
        params.query,
        params.threshold === undefined ? {} : { minWinnerProbability: params.threshold },
        ctx,
        signal,
      );

      let summaryText = '';
      if (result.primary) {
        const lines = [formatSkillLine(result.primary, false)];
        lines.push(...result.runnersUp.map((r) => formatSkillLine(r, true)));
        summaryText = `Recommended skill(s):\n${lines.join('\n')}\n\nTo use a skill, invoke /skill:<name> or use the read tool to open its SKILL.md file.`;
      } else if (result.abstained && result.candidates.length > 0) {
        summaryText =
          result.abstainReason === 'none-won'
            ? `No skill is needed for this task: System One chose none among ${result.candidates.length} candidate(s).`
            : `No skill was judged relevant among ${result.candidates.length} candidate(s) (${result.abstainReason ?? 'no answer'}).`;
      } else if (result.candidates.length > 0) {
        summaryText = `No skills met the confidence threshold among candidates: ${result.candidates.join(', ')}`;
      } else {
        summaryText = `No registered skills found in session.`;
      }

      if (result.escalated) {
        summaryText +=
          '\n(Expanded: the first shortlist was judged incomplete, so a second pass considered more skills.)';
      }

      if (result.fallbackUsed) {
        summaryText +=
          '\n(Note: local heuristic shortlist used due to System One unconfigured/offline)';
      }

      return {
        content: [{ type: 'text', text: summaryText }],
        details: result,
      };
    },
  });

  // 3. Typed evaluation tool: system_one_evaluate
  pi.registerTool({
    name: 'system_one_evaluate',
    label: 'System One Evaluate',
    description:
      'Ask typed System One questions (choice, bool, score) about structured state. Returns calibrated probabilities.',
    promptSnippet: 'Perform fast calibrated structured decisions and classifications over state',
    promptGuidelines: [
      'Use system_one_evaluate when you need structured probability, categorical choice, or scored rubric decisions rather than text generation.',
    ],
    parameters: Type.Object({
      state: Type.Any({ description: 'Target context, text, or structured JSON to evaluate' }),
      questions: Type.Record(
        Type.String(),
        Type.Object({
          type: Type.Union([
            Type.Literal('choice'),
            Type.Literal('bool'),
            Type.Literal('noul'),
            Type.Literal('score'),
          ]),
          instructions: Type.String({ description: 'The judgment instruction/question' }),
          criteria: Type.Optional(
            Type.Any({ description: 'Options, yes/no criterion, or rubric levels' }),
          ),
        }),
      ),
      model: Type.Optional(
        Type.String({ description: 'System One model identifier (default: jev-latest)' }),
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      if (!systemOneClient.isConfigured()) {
        throw new Error(describeUnconfigured());
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Querying System One model...' }],
        details: {},
      });

      const questions: Record<string, QuestionConfig> = {};
      for (const [id, q] of Object.entries(params.questions as Record<string, any>)) {
        questions[id] = {
          type: q.type,
          instructions: q.instructions,
          criteria: q.criteria,
        };
      }

      const response = await systemOneClient.evaluate(
        {
          state: params.state,
          questions,
          model: params.model,
        },
        signal,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.answers, null, 2),
          },
        ],
        details: response,
      };
    },
  });
}
