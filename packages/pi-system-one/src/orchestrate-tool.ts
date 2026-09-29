import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { SystemOneClient } from './system-one.js';
import { determineTopology, type OrchestrationTopology } from './orchestrator.js';
import {
  HERDSMAN_DELEGATE_TOOL,
  HERDSMAN_HINT,
  mapTopologyToPlan,
  type HerdsmanAssignment,
} from './herdsman.js';
import { SYSTEM_ONE_ORCHESTRATE_TOOL } from './types.js';

export interface OrchestrateOutcome {
  definition: string;
  accepted: boolean;
  error?: string;
}

/** Text of a nested tool result, used to report why a delegation was rejected. */
function nestedErrorText(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  return text || 'unknown error';
}

function formatPlan(plan: HerdsmanAssignment[]): string {
  return plan.map((assignment) => `• ${assignment.definition}: ${assignment.task}`).join('\n');
}

/**
 * Register the pi-herdsman delegation tool.
 *
 * The tool is model-invoked and only usable while pi-herdsman's `agent_delegate` is
 * callable in this session (`ctx.tools`); `SettingsService` activates it from the
 * agent-orchestration setting, so it is inert elsewhere.
 */
export function registerSystemOneOrchestrateTool(
  pi: ExtensionAPI,
  systemOneClient: SystemOneClient,
): void {
  pi.registerTool({
    name: SYSTEM_ONE_ORCHESTRATE_TOOL,
    label: 'System One Orchestrate',
    description:
      'Delegate a task to pi-herdsman managed agents using a System One topology judgment. Results arrive asynchronously.',
    promptSnippet: 'Delegate complex work to pi-herdsman managed agents (asynchronous)',
    promptGuidelines: [
      'Use system_one_orchestrate to delegate complex, independent, or context-heavy work to pi-herdsman agents; results arrive asynchronously, so never poll or wait for them.',
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'The task to delegate to pi-herdsman managed agents.' }),
      topology: Type.Optional(
        Type.Union(
          [
            Type.Literal('implementation'),
            Type.Literal('research'),
            Type.Literal('review'),
            Type.Literal('general'),
          ],
          { description: 'Override the System One topology judgment.' },
        ),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: 'Return the delegation plan without starting any agent.' }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const callable = ctx.tools.some((tool) => tool.name === HERDSMAN_DELEGATE_TOOL);
      if (typeof ctx.executeTool !== 'function' || !callable) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: HERDSMAN_HINT }],
          details: { topology: undefined, plan: [], outcomes: [] },
        };
      }

      const topology =
        params.topology ?? (await determineTopology(params.task, systemOneClient, signal));
      const plan = mapTopologyToPlan(topology, params.task);

      if (params.dryRun) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `pi-herdsman ${topology} plan (dry run):\n${formatPlan(plan)}`,
            },
          ],
          details: { topology, plan, outcomes: [] },
        };
      }

      const outcomes: OrchestrateOutcome[] = await Promise.all(
        plan.map(async (assignment) => {
          const outcome = await ctx.executeTool(
            HERDSMAN_DELEGATE_TOOL,
            { definition: assignment.definition, task: assignment.task },
            { signal },
          );
          return {
            definition: assignment.definition,
            accepted: !outcome.isError,
            error: outcome.isError ? nestedErrorText(outcome.result) : undefined,
          };
        }),
      );

      const accepted = outcomes.filter((outcome) => outcome.accepted);
      const failed = outcomes.filter((outcome) => !outcome.accepted);
      const lines = [
        accepted.length > 0
          ? `Delegated to pi-herdsman (${topology}): ${accepted
              .map((outcome) => outcome.definition)
              .join(', ')}. Results arrive asynchronously; do not poll.`
          : `No pi-herdsman agent accepted the ${topology} plan.`,
        ...failed.map(
          (outcome) => `• ${outcome.definition} failed: ${outcome.error ?? 'unknown error'}`,
        ),
      ];

      return {
        isError: accepted.length === 0,
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: { topology, plan, outcomes },
      };
    },
  });
}
