import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { OrchestrationTopology } from './orchestrator.js';

/** pi-herdsman's delegation entry point; its presence means the extension is loaded. */
export const HERDSMAN_DELEGATE_TOOL = 'agent_delegate';

/** Coordination tool every managed pi-herdsman agent receives. */
export const HERDSMAN_MANAGED_TOOL = 'ask_owner';

/** System-prompt tag pi-herdsman appends to a managed agent session. */
export const HERDSMAN_ACTIVE_AGENT_TAG = '<active_agent ';

/** Environment variable pi-herdsman sets on every managed agent process. */
export const HERDSMAN_AGENT_ENV = 'PI_HERDSMAN_AGENT_DEFINITION';

/** Actionable message when pi-herdsman is absent or the session is not a herdr lead. */
export const HERDSMAN_HINT =
  'pi-herdsman not detected. Install it and run this session inside herdr; delegation uses its agent_delegate tool.';

/** Definition name the installer writes for typed System One judgments. */
export const HERDSMAN_JUDGE_DEFINITION = 'system-one-judge';

/** Thinking levels pi-herdsman accepts in a definition's frontmatter. */
export const HERDSMAN_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export interface HerdsmanAssignment {
  definition: string;
  task: string;
}

/** True when pi-herdsman has registered its delegation tool in this session. */
export function isHerdsmanAvailable(pi: Pick<ExtensionAPI, 'getAllTools'>): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === HERDSMAN_DELEGATE_TOOL);
  } catch {
    // A host without the tool registry (older pi, SDK embedding) simply has no herdsman.
    return false;
  }
}

/**
 * True when this session is a pi-herdsman managed agent.
 *
 * The launch environment (`PI_HERDSMAN_AGENT_DEFINITION`) is the primary signal. When it
 * is absent — an older pi-herdsman, or a test double — fall back to the prompt tag plus
 * `ask_owner`, which must agree so tool-grant preservation cannot be triggered by a user
 * prompt that merely mentions the tag.
 */
export function isManagedHerdsmanAgent(
  ctx: { getSystemPrompt?: () => string },
  activeTools: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // pi-herdsman sets its managed-agent environment before the session starts, so this is
  // available earlier than the prompt tag and cannot be spoofed by user text.
  if (env[HERDSMAN_AGENT_ENV]?.trim()) return true;

  let prompt: string | undefined;
  try {
    prompt = ctx.getSystemPrompt?.();
  } catch {
    return false;
  }
  if (!prompt?.includes(HERDSMAN_ACTIVE_AGENT_TAG)) return false;
  return activeTools.includes(HERDSMAN_MANAGED_TOOL);
}

/**
 * Map a System One topology onto pi-herdsman's bundled definitions.
 *
 * pi-herdsman has no workflow engine: `agent_delegate` returns on acceptance and results
 * arrive asynchronously, so a plan is a set of independent assignments. `research` is the
 * only topology that fans out; `implementer` already owns a nested `scout`.
 */
export function mapTopologyToPlan(
  topology: OrchestrationTopology,
  task: string,
): HerdsmanAssignment[] {
  switch (topology) {
    case 'implementation':
      return [{ definition: 'implementer', task }];
    case 'research':
      return [
        { definition: 'scout', task: `Reconnoiter repository evidence for: ${task}` },
        {
          definition: 'researcher',
          task: `Research external and technical context for: ${task}`,
        },
      ];
    case 'review':
      return [{ definition: 'reviewer', task }];
    case 'general':
    default:
      return [{ definition: 'generalist', task }];
  }
}

export interface HerdsmanJudgeDefinitionOptions {
  /** Absolute path to this package's extension entry, passed to Pi unchanged. */
  extensionPath: string;
  model?: string;
  thinking?: string;
}

const HERDSMAN_JUDGE_BODY = `You are system-one-judge, a typed judgment agent. Answer the assigned question by calling \`system_one_evaluate\` once with a single question built from the task, then return the typed answer as your result.

Use the narrowest question type that fits:
- \`bool\` for yes/no or probability checks,
- \`choice\` for mutually exclusive categories,
- \`score\` for graded rubrics.

Do not edit files, run commands, or delegate. Return the answer, the question you asked, and the confidence System One reported. If \`system_one_evaluate\` is unavailable or the classifier is unconfigured, report that instead of guessing.`;

/**
 * Render the `system-one-judge` agent definition for pi-herdsman.
 *
 * Every frontmatter key is part of pi-herdsman's agent-definition schema; unknown keys
 * fail discovery, so this renderer is the single source of truth for the file.
 */
export function buildHerdsmanJudgeDefinition(options: HerdsmanJudgeDefinitionOptions): string {
  const frontmatter = [
    `name: ${HERDSMAN_JUDGE_DEFINITION}`,
    'description: Fast typed System One judgments; use for classification, ranking, verification, and scoring',
    'tools: ["system_one_evaluate"]',
    `extensions: [${JSON.stringify(options.extensionPath)}]`,
    'noSkills: true',
    'noBuiltinTools: true',
    'inheritProjectContext: false',
    'inheritGlobalContext: false',
  ];
  if (options.model) frontmatter.push(`model: ${JSON.stringify(options.model)}`);
  if (options.thinking) frontmatter.push(`thinking: ${options.thinking}`);
  return `---\n${frontmatter.join('\n')}\n---\n\n${HERDSMAN_JUDGE_BODY}\n`;
}

/**
 * Target path for the judge definition: `<agentDir>/agents` for a global definition
 * (the same base pi-herdsman uses via `getAgentDir()`), or `<cwd>/.pi/agents` for a
 * project definition.
 */
export function herdsmanJudgeDefinitionPath(
  scope: 'global' | 'project',
  cwd: string,
  agentDir: string,
): string {
  const base =
    scope === 'project' ? path.join(cwd, '.pi', 'agents') : path.join(agentDir, 'agents');
  return path.join(base, `${HERDSMAN_JUDGE_DEFINITION}.md`);
}
