import type { ClassifierQuestion, JsonObject, JsonValue } from '@earendil-works/pi-ai';

/**
 * Question kinds this extension accepts. `noul` is the retired name for a yes/no
 * question and is still accepted on input so existing callers, tool arguments and
 * saved configurations keep working; it is canonicalised to `bool` before a request
 * leaves the process.
 */
export type QuestionType = 'choice' | 'bool' | 'noul' | 'score';

/** The three kinds pi's classifier API understands. */
export type ClassifierQuestionType = ClassifierQuestion['type'];

/** Tools this extension owns. Never offered as router candidates and toggled together. */
export const SYSTEM_ONE_TOOL_NAMES = [
  'system_one_find_tools',
  'system_one_find_skill',
  'system_one_evaluate',
] as const;

export function isSystemOneTool(name: string): boolean {
  return (SYSTEM_ONE_TOOL_NAMES as readonly string[]).includes(name);
}

/** A JSON-compatible value, mirroring the input shape the classifier API accepts. */
export type SystemOneJsonValue = JsonValue;

/**
 * Text handed to a model as part of a question.
 *
 * Pi's classifier API takes `instructions` and every criterion as plain strings, so a
 * structured instruction is rendered to prose before the request is built. Keeping the
 * loose input type means a question can still name the state path it judges (for
 * example `tools[0]`) through labelled fields instead of interpolating values.
 */
export type SystemOneInstruction =
  | string
  | number
  | boolean
  | SystemOneJsonValue[]
  | { [key: string]: SystemOneInstruction }
  | null;

/** A `{ true, false }` outcome description, which pins a bool question's boundary case. */
export interface BoolCriteria {
  true?: SystemOneInstruction;
  false?: SystemOneInstruction;
}

export interface BaseQuestionConfig {
  instructions: SystemOneInstruction;
}

export interface ChoiceQuestionConfig extends BaseQuestionConfig {
  type: 'choice';
  criteria: Record<string, SystemOneInstruction | null>;
}

/** A yes/no question. `criteria` is optional: pi renders sensible Yes/No labels without it. */
export interface BoolQuestionConfig extends BaseQuestionConfig {
  type: 'bool';
  criteria?: BoolCriteria | null;
}

export interface ScoreQuestionConfig extends BaseQuestionConfig {
  type: 'score';
  criteria: SystemOneInstruction[];
}

/** The pre-0.99 spelling of {@link BoolQuestionConfig}, still accepted on input. */
export interface NoulQuestionConfig extends BaseQuestionConfig {
  type: 'noul';
  criteria?: BoolCriteria | null;
}

export type QuestionConfig =
  | ChoiceQuestionConfig
  | BoolQuestionConfig
  | ScoreQuestionConfig
  | NoulQuestionConfig;

/** State a request may carry. Wrapped into an object before it reaches the classifier. */
export type SystemOneState =
  | string
  | number
  | boolean
  | null
  | SystemOneJsonValue[]
  | { [key: string]: SystemOneJsonValue }
  | Record<string, unknown>
  | readonly unknown[];

export interface SystemOneEvaluationRequest {
  /** Text, a JSON object or array, or `null`. Non-objects are wrapped as `{ state }`. */
  state: SystemOneState;
  questions: Record<string, QuestionConfig>;
  model?: string;
}

export interface SystemOneAnswerResult {
  /**
   * The kind of question that produced this answer. `noul` can still appear from a
   * caller that built the answer itself; a real classifier answer uses `bool`.
   */
  type: ClassifierQuestionType | 'noul';
  value: string | number | boolean;
  confidence?: number;
  /** Per-option probabilities for a `choice` answer. */
  distribution?: Record<string, number>;
  raw?: unknown;
}

export interface SystemOneUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cost in USD, when the model's catalog entry carries a price. */
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
  /** Classifier that served the most recent request. */
  provider?: string;
  /** Model reported for the most recent request. */
  model?: string;
  /** Set when the first candidate failed and another one served the request. */
  fallback?: { from: string; to: string; reason: string };
}

/* -------------------------------------------------------------------------- */
/* Rendering and validation for the classifier API                            */
/* -------------------------------------------------------------------------- */

/**
 * The option and level counts a llama.cpp classifier can label. A choice becomes one
 * letter per option and a score one digit per level, so the model has to emit a single
 * token; a hosted System One service is more generous, but staying inside these bounds
 * keeps one question set usable on every backend.
 */
export const MAX_CHOICE_OPTIONS = 62;
export const MAX_SCORE_LEVELS = 10;

/** Field order used when a structured instruction is flattened to prose. */
const INSTRUCTION_FIELD_ORDER = ['question', 'what', 'inspect', 'goal', 'note'] as const;

/**
 * Fields that point at a state path rather than saying something on their own. They are
 * labelled so the model reads `Inspect tools[0].` instead of a bare fragment that looks
 * like part of the preceding sentence.
 */
const POINTER_FIELDS: ReadonlySet<string> = new Set(['inspect', 'goal']);

/** The key that carries worked examples, rendered as its own "For example" clause. */
const EXAMPLES_FIELD = 'examples';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelled(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Sentence-case the label, so the flattened text reads as prose rather than as JSON.
  const sentenceLabel = label.charAt(0).toUpperCase() + label.slice(1);
  return `${sentenceLabel}: ${trimmed}`;
}

/** Join rendered fragments into one paragraph, keeping sentence boundaries intact. */
function joinParts(parts: (string | null | undefined)[]): string {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  if (kept.length === 0) return '';
  const text = kept
    .map((part) => part.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function renderExamples(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  const rendered = items
    .map((item) => (typeof item === 'string' ? item.trim() : renderInstruction(item)))
    .filter(Boolean);
  if (rendered.length === 0) return '';
  return `For example: ${rendered.join('; ')}`;
}

function renderRecord(value: Record<string, unknown>): string {
  const parts: (string | null)[] = [];
  for (const key of INSTRUCTION_FIELD_ORDER) {
    if (!(key in value)) continue;
    const rendered = renderInstruction(value[key] as SystemOneInstruction);
    if (!rendered) continue;
    // A `question` or `what` is the whole instruction; a pointer field is labelled.
    parts.push(POINTER_FIELDS.has(key) ? labelled(key, rendered) : rendered);
  }
  if (EXAMPLES_FIELD in value) {
    const examples = renderExamples(value[EXAMPLES_FIELD] as SystemOneInstruction);
    if (examples) parts.push(examples);
  }

  const known = new Set<string>([...INSTRUCTION_FIELD_ORDER, EXAMPLES_FIELD]);
  for (const [key, field] of Object.entries(value)) {
    if (known.has(key)) continue;
    if (field === null || field === undefined) continue;
    const rendered = renderInstruction(field as SystemOneInstruction);
    if (!rendered) continue;
    parts.push(labelled(key.replace(/_/g, ' '), rendered));
  }

  return joinParts(parts);
}

/**
 * Flatten one instruction or criterion to the plain string pi's classifier API takes.
 *
 * Structured input keeps its meaning: labelled fields become labelled sentences and an
 * `examples` array becomes a "For example" clause, so a question that used to ship as
 * JSON reaches the model as the same guidance in prose.
 */
export function renderInstruction(value: SystemOneInstruction | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return renderExamples(value);
  if (isRecord(value)) return renderRecord(value);
  return String(value);
}

/** The key pi's classifier API labels a `true`/`false` answer with. */
export const BOOL_TRUE_CRITERIA = 'Yes';
export const BOOL_FALSE_CRITERIA = 'No';

/**
 * A choice needs at least two options to be a question, and both must label
 * something: an unlabelled option is indistinguishable from its neighbours.
 */
export function validateQuestion(id: string, question: QuestionConfig): string | null {
  const instructions = renderInstruction(question.instructions);
  if (!instructions) return `question "${id}" has no instructions`;

  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    if (options.length < 2) {
      return `question "${id}" needs at least 2 choice options, got ${options.length}`;
    }
    if (options.length > MAX_CHOICE_OPTIONS) {
      return `question "${id}" has ${options.length} choice options, more than the ${MAX_CHOICE_OPTIONS} a classifier can label`;
    }
    const unlabelled = options.filter((option) => !renderInstruction(question.criteria[option]));
    if (unlabelled.length > 0) {
      return `question "${id}" has unlabelled choice options: ${unlabelled.join(', ')}`;
    }
    return null;
  }

  if (question.type === 'score') {
    const levels = question.criteria;
    if (levels.length < 2) {
      return `question "${id}" needs at least 2 score levels, got ${levels.length}`;
    }
    if (levels.length > MAX_SCORE_LEVELS) {
      return `question "${id}" has ${levels.length} score levels, more than the ${MAX_SCORE_LEVELS} a classifier can label`;
    }
    const unlabelled = levels.filter((level) => !renderInstruction(level));
    if (unlabelled.length > 0) {
      return `question "${id}" has ${unlabelled.length} unlabelled score levels`;
    }
    return null;
  }

  return null;
}

/**
 * Wrap any JSON state into the object pi's classifier API takes.
 *
 * A bare string, array or scalar is the caller's own text; `{ state }` keeps it
 * addressable by a question that says "judge `state`" without renaming the caller's
 * own top-level keys.
 */
export function wrapState(state: SystemOneState): JsonObject {
  if (state === null || state === undefined) return {};
  if (isRecord(state)) return state as JsonObject;
  return { state: state as JsonValue };
}
