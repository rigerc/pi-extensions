import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SystemOneClient } from './system-one.js';
import { describeUnconfigured } from './system-one.js';
import type {
  QuestionConfig,
  SystemOneEvaluationResponse,
  SystemOneState,
  NoulQuestionConfig,
} from './types.js';

const RPC_REQUEST = 'subagents:rpc:v1:request';
const RPC_REPLY = 'subagents:rpc:v1:reply:';

export interface SystemOneAgentTaskParams {
  task?: string;
  state?: SystemOneState;
  type?: 'choice' | 'noul' | 'score';
  instructions?: string;
  criteria?: any;
  questions?: Record<string, QuestionConfig>;
  model?: string;
}

export interface SystemOneAgentResult {
  success: boolean;
  model: string;
  answers: Record<string, any>;
  primaryValue?: any;
  elapsedMs: number;
  usage?: any;
  error?: string;
}

export async function executeSystemOneAgentTask(
  params: SystemOneAgentTaskParams,
  client: SystemOneClient,
  signal?: AbortSignal,
): Promise<SystemOneAgentResult> {
  if (!client.isConfigured()) {
    throw new Error(describeUnconfigured());
  }

  let questions: Record<string, QuestionConfig> = {};
  const state = params.state ?? params.task ?? 'No state provided';

  if (params.questions && Object.keys(params.questions).length > 0) {
    questions = params.questions;
  } else if (params.type === 'choice') {
    questions['judgment'] = {
      type: 'choice',
      instructions: params.instructions || params.task || 'Categorize state',
      criteria: params.criteria || { yes: null, no: null },
    };
  } else if (params.type === 'score') {
    questions['judgment'] = {
      type: 'score',
      instructions: params.instructions || params.task || 'Score state',
      criteria: Array.isArray(params.criteria) ? params.criteria : ['poor', 'acceptable', 'good'],
    };
  } else {
    // Default to noul (probability / binary check). Noul criteria describe the yes and
    // no outcomes, so only the structured form is meaningful; a bare string is ignored.
    const rawCriteria = params.criteria;
    const noulCriteria: NoulQuestionConfig['criteria'] =
      rawCriteria && typeof rawCriteria === 'object' && !Array.isArray(rawCriteria)
        ? (rawCriteria as NoulQuestionConfig['criteria'])
        : undefined;
    questions['judgment'] = {
      type: 'noul',
      instructions: params.instructions || params.task || 'Evaluate state',
      criteria: noulCriteria,
    };
  }

  const response: SystemOneEvaluationResponse = await client.evaluate(
    {
      state,
      questions,
      model: params.model,
    },
    signal,
  );

  const primaryAnswer = response.answers['judgment'] ?? Object.values(response.answers)[0];

  return {
    success: true,
    model: response.model,
    answers: response.answers,
    primaryValue: primaryAnswer?.value,
    elapsedMs: response.elapsedMs,
    usage: response.usage,
  };
}

export class SystemOneAgentHandler {
  constructor(
    private pi: ExtensionAPI,
    private systemOneClient: SystemOneClient,
  ) {}

  public install(): void {
    // Keep the old System One ids as input aliases during the 0.8 migration window.
    this.pi.events.on(RPC_REQUEST, async (req: any) => {
      if (!req || req.version !== 1) return;
      const targetAgent = req.params?.agent || req.params?.agentType;
      if (targetAgent !== 'system-one' && targetAgent !== 'jev' && targetAgent !== 'typesafe-jev') {
        return;
      }

      const requestId = req.requestId;
      const replyEvent = `${RPC_REPLY}${requestId}`;

      try {
        const taskParams: SystemOneAgentTaskParams = {
          task: req.params?.task,
          state: req.params?.state ?? req.params?.args?.state,
          type: req.params?.type ?? req.params?.args?.type,
          instructions: req.params?.instructions ?? req.params?.args?.instructions,
          criteria: req.params?.criteria ?? req.params?.args?.criteria,
          questions: req.params?.questions ?? req.params?.args?.questions,
          model: req.params?.model ?? req.params?.args?.model,
        };

        const result = await executeSystemOneAgentTask(taskParams, this.systemOneClient);
        this.pi.events.emit(replyEvent, {
          success: true,
          data: {
            id: `system-one-${Date.now()}`,
            output: JSON.stringify(result, null, 2),
            result,
          },
        });
      } catch (err: any) {
        this.pi.events.emit(replyEvent, {
          success: false,
          error: { message: err?.message || String(err) },
        });
      }
    });
  }
}
