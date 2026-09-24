export type QuestionType = "choice" | "noul" | "score";

/** System One backends this extension can talk to. */
export type JevProvider = "typesafe" | "openrouter";

/** Tools this extension owns. Never offered as router candidates and toggled together. */
export const JEV_TOOL_NAMES = ["jev_find_tools", "jev_find_skill", "jev_evaluate"] as const;

export function isJevTool(name: string): boolean {
  return (JEV_TOOL_NAMES as readonly string[]).includes(name);
}

/** A JSON-compatible value, mirroring the input shape the Jev SDK accepts. */
export type JevJsonValue =
  | string
  | number
  | boolean
  | null
  | JevJsonValue[]
  | { [key: string]: JevJsonValue };

/**
 * Jev accepts a question's `instructions` and each criterion as text, a JSON object,
 * or an array. Structured instructions let a question name the state path it judges
 * (for example `tools[0]`) instead of interpolating values into prose.
 */
export type JevInstruction = string | { [key: string]: JevJsonValue } | JevJsonValue[] | null;

/**
 * State a request may carry: the SDK's `EntryType` (text, JSON object/array, or null)
 * plus the looser object/array shapes callers build from typed interfaces in code.
 */
export type JevState = JevJsonValue | Record<string, unknown> | readonly unknown[] | null;

export interface BaseQuestionConfig {
  instructions: JevInstruction;
}

export interface ChoiceQuestionConfig extends BaseQuestionConfig {
  type: "choice";
  criteria: Record<string, JevInstruction | null>;
}

export interface NoulQuestionConfig extends BaseQuestionConfig {
  type: "noul";
  /** Optional descriptions of the yes and no outcomes; they fix the boundary case. */
  criteria?: { true?: JevInstruction; false?: JevInstruction } | null;
}

export interface ScoreQuestionConfig extends BaseQuestionConfig {
  type: "score";
  criteria: JevInstruction[];
}

export type QuestionConfig = ChoiceQuestionConfig | NoulQuestionConfig | ScoreQuestionConfig;

export interface JevEvaluationRequest {
  /** Text, a JSON object or array, or `null`, matching the SDK's state entry type. */
  state: JevState;
  questions: Record<string, QuestionConfig>;
  model?: string;
}

export interface JevAnswerResult {
  type: QuestionType;
  value: string | number | boolean;
  confidence?: number;
  distribution?: Record<string, number>;
  /** Rubric descriptions keyed by score, for `score` answers. */
  legend?: Record<string, unknown>;
  raw?: unknown;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Reported by OpenRouter only. */
  costUsd?: number;
}

export interface JevEvaluationResponse {
  answers: Record<string, JevAnswerResult>;
  model: string;
  usage?: JevUsage;
  elapsedMs: number;
}

export interface JevSessionStats {
  requestsCount: number;
  totalTokens: number;
  totalCostUsd: number;
  lastElapsedMs?: number;
  lastError?: string;
  /** Requests whose free-form state had to be cut to fit Jev's context window. */
  truncations?: number;
  /** Total characters dropped across those requests. */
  truncatedChars?: number;
  /** Total array elements / object keys dropped across those requests. */
  truncatedItems?: number;
  /** Provider that served the most recent request. */
  provider?: JevProvider;
  /** Model reported for the most recent request. */
  model?: string;
  /** Set once the primary provider failed and the secondary served the request. */
  fallback?: { from: JevProvider; to: JevProvider; reason: string };
}
