export type QuestionType = 'choice' | 'noul' | 'score';

/** System One backends this extension can talk to. */
export type SystemOneProvider = 'typesafe' | 'openrouter' | 'laya';

/** Tools this extension owns. Never offered as router candidates and toggled together. */
export const SYSTEM_ONE_TOOL_NAMES = [
  'system_one_find_tools',
  'system_one_find_skill',
  'system_one_evaluate',
] as const;

export function isSystemOneTool(name: string): boolean {
  return (SYSTEM_ONE_TOOL_NAMES as readonly string[]).includes(name);
}

/** A JSON-compatible value, mirroring the input shape the System One SDK accepts. */
export type SystemOneJsonValue =
  | string
  | number
  | boolean
  | null
  | SystemOneJsonValue[]
  | { [key: string]: SystemOneJsonValue };

/**
 * System One accepts a question's `instructions` and each criterion as text, a JSON object,
 * or an array. Structured instructions let a question name the state path it judges
 * (for example `tools[0]`) instead of interpolating values into prose.
 */
export type SystemOneInstruction =
  | string
  | { [key: string]: SystemOneJsonValue }
  | SystemOneJsonValue[]
  | null;

/**
 * State a request may carry: the SDK's `EntryType` (text, JSON object/array, or null)
 * plus the looser object/array shapes callers build from typed interfaces in code.
 */
export type SystemOneState =
  | SystemOneJsonValue
  | Record<string, unknown>
  | readonly unknown[]
  | null;

export interface BaseQuestionConfig {
  instructions: SystemOneInstruction;
}

export interface ChoiceQuestionConfig extends BaseQuestionConfig {
  type: 'choice';
  criteria: Record<string, SystemOneInstruction | null>;
}

export interface NoulQuestionConfig extends BaseQuestionConfig {
  type: 'noul';
  /** Optional descriptions of the yes and no outcomes; they fix the boundary case. */
  criteria?: { true?: SystemOneInstruction; false?: SystemOneInstruction } | null;
}

export interface ScoreQuestionConfig extends BaseQuestionConfig {
  type: 'score';
  criteria: SystemOneInstruction[];
}

export type QuestionConfig = ChoiceQuestionConfig | NoulQuestionConfig | ScoreQuestionConfig;

export interface SystemOneEvaluationRequest {
  /** Text, a JSON object or array, or `null`, matching the SDK's state entry type. */
  state: SystemOneState;
  questions: Record<string, QuestionConfig>;
  model?: string;
}

export interface SystemOneAnswerResult {
  type: QuestionType;
  value: string | number | boolean;
  confidence?: number;
  distribution?: Record<string, number>;
  /** Rubric descriptions keyed by score, for `score` answers. */
  legend?: Record<string, unknown>;
  raw?: unknown;
}

export interface SystemOneUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Reported by OpenRouter only. */
  costUsd?: number;
}

export interface SystemOneEvaluationResponse {
  answers: Record<string, SystemOneAnswerResult>;
  model: string;
  usage?: SystemOneUsage;
  elapsedMs: number;
}

export interface SystemOneSessionStats {
  requestsCount: number;
  totalTokens: number;
  totalCostUsd: number;
  lastElapsedMs?: number;
  lastError?: string;
  /** Requests whose free-form state had to be cut to fit the backend context window. */
  truncations?: number;
  /** Total characters dropped across those requests. */
  truncatedChars?: number;
  /** Total array elements / object keys dropped across those requests. */
  truncatedItems?: number;
  /** Provider that served the most recent request. */
  provider?: SystemOneProvider;
  /** Model reported for the most recent request. */
  model?: string;
  /** Set once the primary provider failed and the secondary served the request. */
  fallback?: { from: SystemOneProvider; to: SystemOneProvider; reason: string };
}
