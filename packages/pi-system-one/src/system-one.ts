import type {
  ClassifierApi,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  Usage,
} from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  BOOL_FALSE_CRITERIA,
  BOOL_TRUE_CRITERIA,
  renderInstruction,
  validateQuestion,
  wrapState,
  type QuestionConfig,
  type SystemOneAnswerResult,
  type SystemOneEvaluationRequest,
  type SystemOneEvaluationResponse,
  type SystemOneSessionStats,
  type SystemOneState,
  type SystemOneUsage,
} from './types.js';
import { adjustProbability, isPromptClassifier } from './thresholds.js';

/**
 * The classifier served when nothing else is selected. `typesafe/jev-latest` is pi's
 * own Jev model, and every other provider in the catalog exposes an equivalent.
 */
export const DEFAULT_PROVIDER = 'typesafe';
export const DEFAULT_MODEL = 'jev-latest';

/** The subset of pi's model registry this extension needs, so tests can supply a fake. */
export type ClassifierRegistry = Pick<
  ModelRegistry,
  | 'getModelOfType'
  | 'getAvailableOfType'
  | 'classify'
  | 'getProviderAuthStatus'
  | 'getProviderDisplayName'
>;

/** One classifier the registry offers, in a form the settings UI and status can show. */
export interface ClassifierModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Which wire protocol serves it, e.g. `typesafe-system-one` or `llama-cpp-classify`. */
  api: string;
}

/** Layered-config overrides pushed in by the settings service. */
export interface ProviderOverrides {
  provider?: string;
  model?: string;
  /**
   * Divides a local model's answer logits before they become probabilities. Values
   * above 1 soften an overconfident distribution; it never changes the answer. APIs
   * that cannot apply it ignore it.
   */
  temperature?: number;
}

/** Public, secret-free view of the active classifier for `/system-one status`. */
export interface SystemOneProviderInfo {
  provider: string;
  model: string;
  /** Display name of the provider, when the registry knows one. */
  label: string;
  api: string;
  /** `ok` when the provider has working credentials, otherwise the reason it does not. */
  auth: string;
  /** Where the selection came from, for status output. */
  source: 'settings' | 'env' | 'default';
}

const PROVIDER_ENV = 'PI_SYSTEM_ONE_PROVIDER';
const MODEL_OVERRIDE_ENV = 'PI_SYSTEM_ONE_MODEL';
const TEMPERATURE_ENV = 'PI_SYSTEM_ONE_TEMPERATURE';
const LEGACY_MODEL_OVERRIDE_ENV = 'PI_JEV_MODEL';
const LEGACY_PROVIDER_ENV = 'PI_JEV_PROVIDER';

/**
 * Environment variables this extension reads, for docs and tests. Credentials are
 * deliberately absent: pi owns `auth.json` and each provider's own env var, so this
 * package never reads or stores a key.
 */
export const SYSTEM_ONE_ENV = {
  provider: PROVIDER_ENV,
  model: MODEL_OVERRIDE_ENV,
  temperature: TEMPERATURE_ENV,
} as const;

export const LEGACY_JEV_ENV = {
  provider: LEGACY_PROVIDER_ENV,
  model: LEGACY_MODEL_OVERRIDE_ENV,
} as const;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readAliasedEnv(
  canonicalName: string,
  legacyName: string,
): { value: string; name: string } | null {
  const canonical = readEnv(canonicalName);
  if (canonical) return { value: canonical, name: canonicalName };
  const legacy = readEnv(legacyName);
  return legacy ? { value: legacy, name: legacyName } : null;
}

/** A provider id from settings or `PI_SYSTEM_ONE_PROVIDER`, or null to auto-select. */
export function parseProvider(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return null;
  return normalized;
}

/**
 * Resolve a user-supplied model reference against the classifiers on offer.
 *
 * A bare id is matched as an id, a `provider/id` pair is matched as a pair, and only a
 * value matching neither is read as a reference. Splitting on the first slash alone would
 * be wrong: on a gateway `typesafe/jev-latest` is a *model id*, not a reference to the
 * `typesafe` provider, and guessing wrong sends the request to a different bill.
 *
 * `defaultProvider` supplies the provider when the value names only a model. Returns null
 * only when there is nothing to resolve, so the caller can report the provider and the
 * remedy for a model that matches nothing.
 */
export function resolveModelRef(
  value: string | null | undefined,
  defaultProvider: string,
  available: readonly ClassifierModel<ClassifierApi>[],
): { provider: string; model: string } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  // A model id wins over a reference: `typesafe/jev-latest` on a gateway is an id.
  const asId =
    available.find((model) => model.id === trimmed) ??
    available.find((model) => `${model.provider}/${model.id}` === trimmed);
  if (asId) return { provider: asId.provider, model: asId.id };

  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    const exact = available.find((c) => c.provider === provider && c.id === model);
    if (exact) return { provider, model };
  }

  const onDefault = available.find(
    (model) => model.provider === defaultProvider && model.id === trimmed,
  );
  if (onDefault) return { provider: defaultProvider, model: trimmed };

  return { provider: defaultProvider, model: trimmed };
}

function readTemperature(overrides: ProviderOverrides): number | undefined {
  const raw = overrides.temperature ?? readEnv(TEMPERATURE_ENV);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Every classifier the registry can serve right now, deduplicated and in catalog order.
 *
 * Availability already accounts for credentials, so a provider the user has not
 * authenticated with simply does not appear.
 */
export async function listClassifierModels(
  registry: ClassifierRegistry,
): Promise<ClassifierModelInfo[]> {
  const models = await registry.getAvailableOfType('classifier');
  const seen = new Set<string>();
  const result: ClassifierModelInfo[] = [];
  for (const model of models) {
    if (!model) continue;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      api: model.api,
    });
  }
  return result;
}

/** Convert one question to the shape pi's classifier API takes. */
export function toClassifierQuestion(id: string, question: QuestionConfig): ClassifierQuestion {
  const instructions = renderInstruction(question.instructions);

  if (question.type === 'choice') {
    const criteria: Record<string, string> = {};
    for (const [option, description] of Object.entries(question.criteria)) {
      criteria[option] = renderInstruction(description) || option;
    }
    return { type: 'choice', instructions, criteria };
  }

  if (question.type === 'score') {
    return {
      type: 'score',
      instructions,
      criteria: question.criteria.map(
        (level, index) => renderInstruction(level) || `Level ${index}`,
      ),
    };
  }

  // `noul` and `bool` are the same question under two names.
  const criteria = question.criteria ?? undefined;
  return {
    type: 'bool',
    instructions,
    criteria: {
      true: renderInstruction(criteria?.true) || BOOL_TRUE_CRITERIA,
      false: renderInstruction(criteria?.false) || BOOL_FALSE_CRITERIA,
    },
  };
}

/** Map one classifier answer onto the shape this extension has always returned. */
export function toAnswerResult(answer: ClassifierResult['answers'][string]): SystemOneAnswerResult {
  if (answer.type === 'choice') {
    return {
      type: 'choice',
      value: answer.choice,
      confidence: answer.confidence,
      distribution: answer.probabilities,
      raw: answer,
    };
  }
  if (answer.type === 'score') {
    return { type: 'score', value: answer.score, confidence: answer.confidence, raw: answer };
  }
  return { type: 'bool', value: answer.probability, raw: answer };
}

/**
 * Scale an answer's evidence when a prompt-rendered classifier produced it.
 *
 * A local model's label probabilities are usually overconfident, so every number a
 * routing decision could compare against is discounted here, at the one place all of
 * them pass through. The classifier's own value stays on `raw`, so status output can
 * show what was actually returned.
 */
function discountAnswer(answer: SystemOneAnswerResult, api: string): SystemOneAnswerResult {
  if (!isPromptClassifier(api)) return answer;
  const discounted: SystemOneAnswerResult = { ...answer };
  if (typeof discounted.value === 'number') {
    discounted.value = adjustProbability(discounted.value, api);
  }
  if (typeof discounted.confidence === 'number') {
    discounted.confidence = adjustProbability(discounted.confidence, api);
  }
  if (discounted.distribution) {
    const distribution: Record<string, number> = {};
    for (const [option, probability] of Object.entries(discounted.distribution)) {
      distribution[option] = adjustProbability(probability, api);
    }
    discounted.distribution = distribution;
  }
  return discounted;
}

/**
 * Normalize pi's `Usage` into the token and cost totals this extension reports.
 *
 * A classifier that reports no tokens leaves the counts at zero rather than guessing,
 * so an uncosted call never inflates the session totals.
 */
export function normalizeUsage(raw: unknown): SystemOneUsage {
  const usage = (raw ?? {}) as Partial<Usage> & Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const inputTokens = num(usage.input) ?? num(usage.input_tokens) ?? num(usage.inputTokens) ?? 0;
  const outputTokens =
    num(usage.output) ?? num(usage.output_tokens) ?? num(usage.outputTokens) ?? 0;
  const totalTokens = num(usage.totalTokens) ?? num(usage.total_tokens) ?? inputTokens + outputTokens;
  const cost = usage.cost as { total?: number } | undefined;
  const costUsd = num(cost?.total) ?? num(usage.costUsd) ?? num(usage.cost);

  return costUsd === undefined
    ? { inputTokens, outputTokens, totalTokens }
    : { inputTokens, outputTokens, totalTokens, costUsd };
}

/** Actionable message naming every way to get a classifier. */
export function describeUnconfigured(): string {
  return [
    'No System One classifier is available.',
    'Sign in with `/login typesafe` (or openrouter, cloudflare-workers-ai, vercel-ai-gateway, opencode),',
    'or run a llama.cpp router and load a model with `/llama`.',
    `Set ${PROVIDER_ENV} and ${MODEL_OVERRIDE_ENV} to choose one explicitly.`,
  ].join(' ');
}

/**
 * Jev serves a 32K-token context window. The routers cap candidate *counts*, but
 * free-form state does not: a git diff, a failed tool result, or an agent-supplied
 * evaluation target can be arbitrarily large, and an oversized request fails as an
 * opaque transport error rather than a clear "state too large". Cap the serialized
 * state instead, mark every cut in place, and report it in session stats so silent
 * evidence loss is observable.
 */
export const MAX_STATE_CHARS = 60_000;

/** Longest single string field before it is cut, so one giant value cannot displace the rest. */
export const MAX_STATE_FIELD_CHARS = 12_000;

/** Floor a string is halved down to while shrinking the whole payload. */
const MIN_STRING_CHARS = 200;
const MAX_CAP_PASSES = 64;
/** Full-depth passes that drop whole array elements / object keys to fit the budget. */
const MAX_STRUCTURE_PASSES = 64;
/** Reserved room for a truncation marker so a cut never exceeds its cap. */
const MARKER_BUDGET = 40;
const MARKER_PATTERN = /\n?…\[truncated \d+ chars\]$/;

export interface CappedState {
  value: SystemOneState;
  /** Content characters dropped across all cuts; 0 means the state was sent intact. */
  truncatedChars: number;
  /** Array elements / object keys dropped to fit the budget; 0 when none were. */
  truncatedItems: number;
}

/** Read/write handle for one string leaf of a JSON-compatible state object. */
interface StringSlot {
  get(): string;
  set(value: string): void;
}

function truncationMarker(dropped: number): string {
  return `…[truncated ${dropped} chars]`;
}

function structureMarker(droppedItems: number): string {
  return `…[truncated ${droppedItems} items]`;
}

function stripMarker(value: string): string {
  return value.replace(MARKER_PATTERN, '');
}

/**
 * Cut one string to at most `max` characters, replacing any previous marker. Room is
 * reserved for the marker so the returned string never exceeds `max`, which is what
 * lets {@link capState} guarantee its postcondition.
 */
function cut(value: string, max: number): { value: string; dropped: number } {
  const plain = stripMarker(value);
  if (plain.length <= max) return { value, dropped: 0 };
  const target = Math.max(0, max - MARKER_BUDGET);
  const dropped = plain.length - target;
  return { value: plain.slice(0, target) + truncationMarker(dropped), dropped };
}

function collectStringSlots(node: unknown, out: StringSlot[], depth = 0): void {
  if (depth > 64 || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (typeof item === 'string') {
        out.push({
          get: () => node[index] as string,
          set: (value) => {
            node[index] = value;
          },
        });
      } else {
        collectStringSlots(item, out, depth + 1);
      }
    });
    return;
  }

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      out.push({
        get: () => record[key] as string,
        set: (next) => {
          record[key] = next;
        },
      });
    } else {
      collectStringSlots(value, out, depth + 1);
    }
  }
}

function longestSlot(slots: StringSlot[]): StringSlot | null {
  let best: StringSlot | null = null;
  for (const slot of slots) {
    if (!best || slot.get().length > best.get().length) best = slot;
  }
  return best;
}

/** Mutable array or object inside the cloned state, for structural truncation. */
type CollectionHandle =
  | { kind: 'array'; node: unknown[] }
  | { kind: 'object'; node: Record<string, unknown> };

function collectCollections(node: unknown, out: CollectionHandle[], depth = 0): void {
  if (depth > 64 || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    out.push({ kind: 'array', node });
    for (const item of node) collectCollections(item, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  out.push({ kind: 'object', node: record });
  for (const value of Object.values(record)) collectCollections(value, out, depth + 1);
}

function collectionSize(handle: CollectionHandle): number {
  return handle.kind === 'array' ? handle.node.length : Object.keys(handle.node).length;
}

/**
 * Drop the second half of the largest array/object at any depth until the payload fits.
 * String reduction cannot shrink a structure made of numbers, booleans, or key names;
 * this bounds those without discarding the whole state. Returns the number of dropped
 * elements/keys and leaves a marker in place of each cut.
 */
function shrinkStructure(root: SystemOneState, maxChars: number): number {
  let droppedItems = 0;

  for (let pass = 0; pass < MAX_STRUCTURE_PASSES; pass++) {
    if (JSON.stringify(root).length <= maxChars) break;

    const collections: CollectionHandle[] = [];
    collectCollections(root, collections);

    let fattest: CollectionHandle | null = null;
    let fattestSize = 1;
    for (const handle of collections) {
      const size = collectionSize(handle);
      if (size > fattestSize) {
        fattest = handle;
        fattestSize = size;
      }
    }
    if (!fattest) break;

    if (fattest.kind === 'array') {
      const keep = Math.ceil(fattest.node.length / 2);
      const removed = fattest.node.length - keep;
      fattest.node.splice(keep, removed, structureMarker(removed));
      droppedItems += removed;
    } else {
      const keys = Object.keys(fattest.node);
      const keep = Math.ceil(keys.length / 2);
      const removed = keys.length - keep;
      for (const key of keys.slice(keep)) delete fattest.node[key];
      fattest.node['…truncated'] = structureMarker(removed);
      droppedItems += removed;
    }
  }

  return droppedItems;
}

/**
 * Cap a request's state to fit Jev's window without dropping structure: per-field cuts
 * first, then halving the longest remaining string, then structural truncation of the
 * largest arrays/objects. Every cut is marked in place, so a judge reading the state can
 * see that it is partial. Guarantees `JSON.stringify(value).length <= maxChars`, throwing
 * when even that is impossible so an oversized body never reaches Jev.
 */
export function capState(state: SystemOneState, maxChars = MAX_STATE_CHARS): CappedState {
  if (typeof state === 'string') {
    const result = cut(state, maxChars);
    return { value: result.value, truncatedChars: result.dropped, truncatedItems: 0 };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(state ?? null) ?? 'null';
  } catch {
    // State that cannot be serialized could not have reached Jev anyway.
    return {
      value: { state: 'omitted: state was not JSON-serializable' },
      truncatedChars: 0,
      truncatedItems: 0,
    };
  }

  let copy: SystemOneState;
  try {
    copy = JSON.parse(serialized) as SystemOneState;
  } catch {
    return {
      value: { state: 'omitted: state was not JSON-serializable' },
      truncatedChars: 0,
      truncatedItems: 0,
    };
  }

  let dropped = 0;
  const slots: StringSlot[] = [];
  collectStringSlots(copy, slots);

  for (const slot of slots) {
    const result = cut(slot.get(), MAX_STATE_FIELD_CHARS);
    if (result.dropped > 0) {
      slot.set(result.value);
      dropped += result.dropped;
    }
  }

  for (let pass = 0; pass < MAX_CAP_PASSES && JSON.stringify(copy).length > maxChars; pass++) {
    const slot = longestSlot(slots);
    if (!slot) break;
    const current = stripMarker(slot.get());
    if (current.length <= MIN_STRING_CHARS) break;
    const result = cut(slot.get(), Math.max(MIN_STRING_CHARS, Math.floor(current.length / 2)));
    if (result.dropped === 0) break;
    slot.set(result.value);
    dropped += result.dropped;
  }

  // Strings exhausted: bound any remaining structural overhead by dropping whole
  // elements/keys, then assert the cap so an oversized body can never be returned.
  const droppedItems = shrinkStructure(copy, maxChars);

  if (JSON.stringify(copy).length > maxChars) {
    throw new Error('state too large after truncation');
  }

  return { value: copy, truncatedChars: dropped, truncatedItems: droppedItems };
}

function errorMessage(error: unknown): string {
  return (error as { message?: string } | null | undefined)?.message ?? String(error);
}

/** A prompt-rendered classifier serves the state inside a chat prompt, not a request body. */

/**
 * A prompt-rendered classifier sends the state in one prompt per question and pi
 * writes the state twice in each, so the same state costs roughly twice the context
 * it does on a System One service. Cap it lower so the second copy still fits.
 */
export const PROMPT_MAX_STATE_CHARS = Math.floor(MAX_STATE_CHARS / 2);

export class SystemOneClient {
  private registry: ClassifierRegistry | null = null;
  private providerOverrides: ProviderOverrides = {};
  public stats: SystemOneSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };

  /**
   * Hand this client pi's model registry. Extensions construct it before any event
   * fires, so it stays usable — and reports itself unconfigured — until the first
   * context arrives.
   */
  public attach(registry: ClassifierRegistry): void {
    this.registry = registry;
  }

  public detach(): void {
    this.registry = null;
  }

  /** Apply the classifier chosen through layered settings. */
  public setProviderOverrides(overrides: ProviderOverrides): void {
    this.providerOverrides = overrides ?? {};
  }

  /** Whether a registry is attached; it says nothing about whether a model is available. */
  public isConfigured(): boolean {
    return this.registry !== null;
  }

  /** Classifiers the registry can serve right now. */
  public async listAvailable(): Promise<ClassifierModelInfo[]> {
    if (!this.registry) return Promise.resolve([]);
    return listClassifierModels(this.registry);
  }

  /**
   * The explicitly chosen classifier, with the source that asked for it. `provider` is
   * null when only a model was named, because that model may itself carry a
   * `provider/` prefix.
   */
  private getSelection(): { provider: string | null; model: string; source: 'settings' | 'env' } | null {
    const settingsProvider = parseProvider(this.providerOverrides.provider);
    const settingsModel = this.providerOverrides.model?.trim();
    if (settingsProvider || settingsModel) {
      return {
        provider: settingsProvider,
        model: settingsModel ?? DEFAULT_MODEL,
        source: 'settings',
      };
    }

    const envProvider = parseProvider(readAliasedEnv(PROVIDER_ENV, LEGACY_PROVIDER_ENV)?.value);
    const envModel = readAliasedEnv(MODEL_OVERRIDE_ENV, LEGACY_MODEL_OVERRIDE_ENV)?.value;
    if (envProvider || envModel) {
      return {
        provider: envProvider,
        model: envModel ?? DEFAULT_MODEL,
        source: 'env',
      };
    }

    return null;
  }

  /** A human-readable summary of the active classifier, for status output. */
  public async getProviderInfo(): Promise<SystemOneProviderInfo | null> {
    const registry = this.registry;
    if (!registry) return null;

    const selection = this.getSelection();
    const source = selection?.source ?? 'default';
    const defaultProvider = selection?.provider ?? DEFAULT_PROVIDER;
    const { provider, model } = resolveModelRef(
      selection?.model ?? DEFAULT_MODEL,
      defaultProvider,
      await registry.getAvailableOfType('classifier'),
    ) ?? { provider: defaultProvider, model: selection?.model ?? DEFAULT_MODEL };
    const resolved = registry.getModelOfType('classifier', provider, model);
    const auth = registry.getProviderAuthStatus(provider);

    return {
      provider,
      model: resolved?.id ?? model,
      label: registry.getProviderDisplayName(provider) || provider,
      api: resolved?.api ?? 'unknown',
      auth: auth.configured ? (auth.label ?? auth.source ?? 'ok') : 'not configured',
      source,
    };
  }

  /**
   * The classifiers to try, in order.
   *
   * An explicitly chosen model is all-or-nothing: if it is not available the caller is
   * told why rather than quietly served by a different, differently priced model.
   * Without an explicit choice, everything the registry offers is a candidate, so one
   * unreachable provider does not disable semantic routing.
   */
  private async candidates(
    registry: ClassifierRegistry,
    modelOverride: string | undefined,
  ): Promise<ClassifierModel<ClassifierApi>[]> {
    const available = await registry.getAvailableOfType('classifier');

    const requestRef = modelOverride?.trim();
    const selection = requestRef ? null : this.getSelection();
    const explicitModel = requestRef ?? selection?.model;
    const explicitProvider = requestRef ? null : selection?.provider;
    if (!explicitModel && !explicitProvider) return [...available];

    // With a provider but no model, the provider's default classifier is meant.
    const { provider, model } = resolveModelRef(
      explicitModel ?? DEFAULT_MODEL,
      explicitProvider ?? DEFAULT_PROVIDER,
      available,
    ) ?? { provider: explicitProvider ?? DEFAULT_PROVIDER, model: DEFAULT_MODEL };

    // An explicitly chosen classifier is all-or-nothing: substituting a differently
    // priced model behind the user's back is worse than telling them it is missing.
    const resolved =
      available.find((candidate) => candidate.provider === provider && candidate.id === model) ??
      registry.getModelOfType('classifier', provider, model);
    if (!resolved) {
      throw new Error(
        [
          `No classifier available for ${provider}/${model}.`,
          `Run /login ${provider} for hosted classifiers, or /llama to load a local model.`,
        ].join(' '),
      );
    }
    return [resolved];
  }

  public async evaluate(
    request: SystemOneEvaluationRequest,
    signal?: AbortSignal,
  ): Promise<SystemOneEvaluationResponse> {
    const startTime = Date.now();
    const registry = this.registry;
    if (!registry) throw new Error(describeUnconfigured());
    this.stats.fallback = undefined;

    const questions: Record<string, ClassifierQuestion> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const problem = validateQuestion(id, question);
      if (problem) throw new Error(problem);
      questions[id] = toClassifierQuestion(id, question);
    }

    const candidates = await this.candidates(registry, request.model);
    if (candidates.length === 0) throw new Error(describeUnconfigured());

    const primary = candidates[0];
    const maxChars = isPromptClassifier(primary.api)
      ? PROMPT_MAX_STATE_CHARS
      : MAX_STATE_CHARS;
    const capped = capState(request.state, maxChars);
    if (capped.truncatedChars > 0 || capped.truncatedItems > 0) {
      this.stats.truncations = (this.stats.truncations ?? 0) + 1;
      this.stats.truncatedChars = (this.stats.truncatedChars ?? 0) + capped.truncatedChars;
      this.stats.truncatedItems = (this.stats.truncatedItems ?? 0) + capped.truncatedItems;
    }
    const state = wrapState(capped.value as SystemOneState);

    const temperature = readTemperature(this.providerOverrides);
    const options: { signal?: AbortSignal; temperature?: number } = {};
    if (signal) options.signal = signal;
    if (temperature !== undefined) options.temperature = temperature;

    // `classify` reports an inference failure in its result rather than rejecting, so the
    // chain is driven by `stopReason`. It does still *throw* for some pre-flight failures
    // — an unresolvable credential throws before any request is made — so a throw is
    // treated as a failed candidate rather than an exception that ends the chain.
    // An abort is the caller's decision, not a provider fault, and stops the chain
    // instead of spending the alternatives.
    let active = primary;
    let result: ClassifierResult | null = null;
    let lastError = describeUnconfigured();

    for (const [index, candidate] of candidates.entries()) {
      let outcome: ClassifierResult;
      try {
        outcome = await registry.classify(candidate, { state, questions }, options);
      } catch (error) {
        // A cancellation the caller asked for is not a provider fault, so it does not
        // spend the remaining candidates.
        if (signal?.aborted) {
          lastError = errorMessage(error);
          break;
        }
        lastError = errorMessage(error);
        continue;
      }

      if (outcome.stopReason === 'stop') {
        active = candidate;
        result = outcome;
        if (index > 0) {
          this.stats.fallback = {
            from: `${primary.provider}/${primary.id}`,
            to: `${candidate.provider}/${candidate.id}`,
            reason: lastError,
          };
        }
        break;
      }
      lastError = outcome.errorMessage ?? `classifier ${outcome.stopReason}`;
      if (outcome.stopReason === 'aborted') break;
    }

    if (!result) {
      this.stats.lastError = lastError;
      throw new Error(lastError);
    }

    const elapsedMs = Date.now() - startTime;
    const usage = normalizeUsage(result.usage);

    this.stats.requestsCount += 1;
    this.stats.provider = result.provider ?? active.provider;
    this.stats.model = result.model || active.id;
    this.stats.totalTokens += usage.totalTokens;
    this.stats.totalCostUsd += usage.costUsd ?? 0;
    this.stats.lastElapsedMs = elapsedMs;
    this.stats.lastError = undefined;

    const answers: Record<string, SystemOneAnswerResult> = {};
    for (const id of Object.keys(questions)) {
      const answer = result.answers[id];
      if (!answer) continue;
      answers[id] = discountAnswer(toAnswerResult(answer), result.api ?? active.api);
    }

    return { answers, model: result.model || active.id, usage, elapsedMs };
  }
}
