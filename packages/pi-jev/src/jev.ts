import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevProvider,
  JevSessionStats,
  JevState,
  JevUsage,
} from "./types.js";

export type { JevProvider };

/** Bare id valid on hosted Jev; Laya treats an unknown Jev id as auto-routing. */
export const DEFAULT_MODEL = "jev-latest";

/** Safely below laya-serve's 50,000-character state limit. */
export const LAYA_MAX_STATE_CHARS = 48_000;

/**
 * @typesafe-ai/sdk requires a non-empty key and always sends a bearer header. Laya
 * ignores that header when LAYA_API_KEY is unset, so keep this transport-only value
 * private and never expose it through config, status, persistence, or logs.
 */
const LOCAL_SDK_PLACEHOLDER = "pi-jev-local-no-auth";

export type ApiKeySource = "env" | "file";

export interface JevProviderDefinition {
  label: string;
  /** SDK root; the client appends `/v1/systemone`, so this must not include `/v1`. */
  baseURL: string;
  /** Legacy provider-specific base URL env var (TypeSafe only). */
  baseURLEnv?: string;
  model: string;
  /** Legacy provider-specific model env var (TypeSafe only). */
  modelEnv?: string;
  keyEnv?: string;
  secretFile?: string;
  auth: "required" | "optional";
}

export const JEV_PROVIDERS: Record<JevProvider, JevProviderDefinition> = {
  typesafe: {
    label: "TypeSafe",
    baseURL: "https://api.typesafe.ai",
    baseURLEnv: "TYPESAFE_BASE_URL",
    model: DEFAULT_MODEL,
    modelEnv: "TYPESAFE_DEFAULT_MODEL",
    keyEnv: "TYPESAFE_API_KEY",
    secretFile: "typesafe_api_key",
    auth: "required",
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api",
    model: DEFAULT_MODEL,
    keyEnv: "OPENROUTER_API_KEY",
    secretFile: "openrouter_api_key",
    auth: "required",
  },
  laya: {
    label: "Laya (local)",
    baseURL: "http://127.0.0.1:8000",
    model: DEFAULT_MODEL,
    keyEnv: "LAYA_API_KEY",
    secretFile: "laya_api_key",
    auth: "optional",
  },
};

/** Fully resolved primary/secondary request target, with provenance for status output. */
export interface JevProviderConfig {
  provider: JevProvider;
  label: string;
  apiKey?: string;
  baseURL: string;
  model: string;
  /** Where the key came from, e.g. `$OPENROUTER_API_KEY`. */
  keyOrigin: string | null;
  /** Whether requests use a user-configured bearer credential. */
  authMode: "none" | "bearer";
}

/** Public, secret-free view of the active provider for `/jev status`. */
export interface JevProviderInfo {
  provider: JevProvider;
  label: string;
  baseURL: string;
  model: string;
  keyOrigin: string | null;
  authMode: "none" | "bearer";
}

/** Layered-config overrides pushed in by the settings service. */
export interface ProviderOverrides {
  provider?: JevProvider | "auto";
  baseURL?: string;
  model?: string;
}

/** HTTP statuses meaning "this provider cannot serve the request, but the other might". */
export const FALLBACK_STATUSES = [401, 402, 403, 404] as const;

const BASE_URL_OVERRIDE_ENV = "PI_JEV_BASE_URL";
const MODEL_OVERRIDE_ENV = "PI_JEV_MODEL";
const API_KEY_OVERRIDE_ENV = "PI_JEV_API_KEY";
const PROVIDER_ENV = "PI_JEV_PROVIDER";
const SECRETS_DIR_ENV = "PI_JEV_SECRETS_DIR";

/** Every environment variable this extension reads, for docs and tests. */
export const JEV_ENV = {
  provider: PROVIDER_ENV,
  apiKey: API_KEY_OVERRIDE_ENV,
  baseURL: BASE_URL_OVERRIDE_ENV,
  model: MODEL_OVERRIDE_ENV,
  secretsDir: SECRETS_DIR_ENV,
  layaApiKey: "LAYA_API_KEY",
} as const;

/** Secrets live next to Pi's own store by default; override for custom layouts and tests. */
function secretsDir(): string {
  return readEnv(SECRETS_DIR_ENV) ?? path.join(os.homedir(), ".pi", "agent", "secrets");
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readSecretFile(fileName: string): { key: string; origin: string } | null {
  const filePath = path.join(secretsDir(), fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (content) return { key: content, origin: `~/.pi/agent/secrets/${fileName}` };
  } catch {
    // An unreadable secret file is treated as absent.
  }
  return null;
}

/** A known explicit provider, or `auto` for unset/unknown values. */
export function parseProvider(value: string | null | undefined): JevProvider | "auto" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "typesafe" || normalized === "openrouter" || normalized === "laya") {
    return normalized;
  }
  return "auto";
}

/** Infer the provider from an explicit base URL; only OpenRouter is distinguishable. */
export function inferProviderFromBaseURL(baseURL: string | null | undefined): JevProvider | null {
  if (!baseURL) return null;
  return /openrouter\.ai/i.test(baseURL) ? "openrouter" : null;
}

/**
 * Whether a base URL override may be used for `provider`. A URL that names the other
 * provider is rejected, so one provider's key is never sent to the other's host.
 */
function overrideAppliesTo(baseURL: string | null | undefined, provider: JevProvider): boolean {
  if (
    provider === "laya" &&
    baseURL &&
    /(?:openrouter\.ai|(?:^|\.)typesafe\.ai)(?:[/:]|$)/i.test(baseURL)
  ) {
    return false;
  }
  const inferred = inferProviderFromBaseURL(baseURL);
  return inferred === null || inferred === provider;
}

/** Apply the layered base URL/model overrides to a resolved provider config. */
function applyOverrides(config: JevProviderConfig, overrides: ProviderOverrides): JevProviderConfig {
  const baseURL = overrides.baseURL?.trim();
  const model = overrides.model?.trim();
  return {
    ...config,
    baseURL: baseURL && overrideAppliesTo(baseURL, config.provider) ? baseURL : config.baseURL,
    model: model || config.model,
  };
}

function buildConfig(
  provider: JevProvider,
  apiKey?: string,
  keyOrigin: string | null = null
): JevProviderConfig {
  const def = JEV_PROVIDERS[provider];
  const legacyBaseURL = def.baseURLEnv ? readEnv(def.baseURLEnv) : null;
  const legacyModel = def.modelEnv ? readEnv(def.modelEnv) : null;
  const overrideBaseURL = readEnv(BASE_URL_OVERRIDE_ENV);
  return {
    provider,
    label: def.label,
    apiKey,
    baseURL:
      (overrideBaseURL && overrideAppliesTo(overrideBaseURL, provider) ? overrideBaseURL : null) ??
      legacyBaseURL ??
      def.baseURL,
    model: readEnv(MODEL_OVERRIDE_ENV) ?? legacyModel ?? def.model,
    keyOrigin,
    authMode: apiKey ? "bearer" : "none",
  };
}

/** Credentials for one provider: its env var first, then its secret file. */
export function resolveProviderConfig(provider: JevProvider): JevProviderConfig | null {
  const def = JEV_PROVIDERS[provider];
  const envKey = def.keyEnv ? readEnv(def.keyEnv) : null;
  if (envKey) return buildConfig(provider, envKey, `$${def.keyEnv}`);

  const fileKey = def.secretFile ? readSecretFile(def.secretFile) : null;
  if (fileKey) return buildConfig(provider, fileKey.key, fileKey.origin);

  return def.auth === "optional" ? buildConfig(provider) : null;
}

/**
 * Credentials for one provider with the cross-provider `PI_JEV_API_KEY` applied first.
 * A provider selected through layered settings must not bypass that override, which the
 * documented resolution order places above every provider-specific key.
 */
export function resolveProviderConfigFor(provider: JevProvider): JevProviderConfig | null {
  const overrideKey = readEnv(API_KEY_OVERRIDE_ENV);
  if (overrideKey) return buildConfig(provider, overrideKey, `$${API_KEY_OVERRIDE_ENV}`);
  return resolveProviderConfig(provider);
}

function resolveOverrideConfig(): JevProviderConfig | null {
  const apiKey = readEnv(API_KEY_OVERRIDE_ENV);
  if (!apiKey) return null;

  const forced = parseProvider(readEnv(PROVIDER_ENV));
  const provider =
    forced !== "auto" ? forced : inferProviderFromBaseURL(readEnv(BASE_URL_OVERRIDE_ENV)) ?? "typesafe";
  return buildConfig(provider, apiKey, `$${API_KEY_OVERRIDE_ENV}`);
}

/**
 * Resolve the primary provider, first match wins:
 * 1. `PI_JEV_API_KEY` (+ optional `PI_JEV_PROVIDER` / `PI_JEV_BASE_URL` / `PI_JEV_MODEL`)
 * 2. forced provider via `PI_JEV_PROVIDER=typesafe|openrouter|laya`
 * 3. auto-detect: `TYPESAFE_API_KEY` then `OPENROUTER_API_KEY` (env, then secret file)
 */
export function resolveJevProvider(): JevProviderConfig | null {
  const override = resolveOverrideConfig();
  if (override) return override;

  const forced = parseProvider(readEnv(PROVIDER_ENV));
  if (forced !== "auto") return resolveProviderConfig(forced);

  // A base URL override that names a provider selects it, so its key is used rather
  // than the other provider's key being sent to that host.
  const inferred = inferProviderFromBaseURL(readEnv(BASE_URL_OVERRIDE_ENV));
  if (inferred) return resolveProviderConfig(inferred);

  return resolveProviderConfig("typesafe") ?? resolveProviderConfig("openrouter");
}

/** The other hosted provider, when configured. Local Laya never crosses the cloud boundary. */
export function resolveFallbackProvider(
  primary: JevProvider,
  overrides: ProviderOverrides = {}
): JevProviderConfig | null {
  if (primary === "laya") return null;
  const other: JevProvider = primary === "typesafe" ? "openrouter" : "typesafe";
  const config = resolveProviderConfigFor(other);
  return config ? applyOverrides(config, overrides) : null;
}

/** Backwards-compatible key lookup used by older callers. */
export function resolveApiKeySource(): { key: string; source: ApiKeySource; origin: string } | null {
  const config = resolveJevProvider();
  if (!config?.apiKey || !config.keyOrigin) return null;
  return {
    key: config.apiKey,
    source: config.keyOrigin.startsWith("$") ? "env" : "file",
    origin: config.keyOrigin,
  };
}

/** Whether a failure is provider-scoped, so retrying the other provider is worthwhile. */
export function isProviderFallbackError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && (FALLBACK_STATUSES as readonly number[]).includes(status);
}

/** Accept the SDK's snake_case usage, OpenRouter's `cost`, and legacy camelCase. */
export function normalizeUsage(raw: unknown): JevUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const inputTokens = num(usage.input_tokens) ?? num(usage.inputTokens) ?? 0;
  const outputTokens = num(usage.output_tokens) ?? num(usage.outputTokens) ?? 0;
  const totalTokens = num(usage.total_tokens) ?? num(usage.totalTokens) ?? inputTokens + outputTokens;
  const costUsd = num(usage.cost) ?? num(usage.costUsd);

  return costUsd === undefined
    ? { inputTokens, outputTokens, totalTokens }
    : { inputTokens, outputTokens, totalTokens, costUsd };
}

/** Actionable message naming every way to configure a provider. */
export function describeUnconfigured(): string {
  return [
    "No Jev provider is configured.",
    "Set TYPESAFE_API_KEY (TypeSafe) or OPENROUTER_API_KEY (OpenRouter),",
    `or write ~/.pi/agent/secrets/{${JEV_PROVIDERS.typesafe.secretFile},${JEV_PROVIDERS.openrouter.secretFile}}.`,
    `For local Laya, set ${PROVIDER_ENV}=laya and run laya-serve.`,
    `${API_KEY_OVERRIDE_ENV} is the generic bearer-token override.`,
  ].join(" ");
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
  value: JevState;
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
  return value.replace(MARKER_PATTERN, "");
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
  if (depth > 64 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (typeof item === "string") {
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
    if (typeof value === "string") {
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
  | { kind: "array"; node: unknown[] }
  | { kind: "object"; node: Record<string, unknown> };

function collectCollections(node: unknown, out: CollectionHandle[], depth = 0): void {
  if (depth > 64 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    out.push({ kind: "array", node });
    for (const item of node) collectCollections(item, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  out.push({ kind: "object", node: record });
  for (const value of Object.values(record)) collectCollections(value, out, depth + 1);
}

function collectionSize(handle: CollectionHandle): number {
  return handle.kind === "array" ? handle.node.length : Object.keys(handle.node).length;
}

/**
 * Drop the second half of the largest array/object at any depth until the payload fits.
 * String reduction cannot shrink a structure made of numbers, booleans, or key names;
 * this bounds those without discarding the whole state. Returns the number of dropped
 * elements/keys and leaves a marker in place of each cut.
 */
function shrinkStructure(root: JevState, maxChars: number): number {
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

    if (fattest.kind === "array") {
      const keep = Math.ceil(fattest.node.length / 2);
      const removed = fattest.node.length - keep;
      fattest.node.splice(keep, removed, structureMarker(removed));
      droppedItems += removed;
    } else {
      const keys = Object.keys(fattest.node);
      const keep = Math.ceil(keys.length / 2);
      const removed = keys.length - keep;
      for (const key of keys.slice(keep)) delete fattest.node[key];
      fattest.node["…truncated"] = structureMarker(removed);
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
export function capState(state: JevState, maxChars = MAX_STATE_CHARS): CappedState {
  if (typeof state === "string") {
    const result = cut(state, maxChars);
    return { value: result.value, truncatedChars: result.dropped, truncatedItems: 0 };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(state ?? null) ?? "null";
  } catch {
    // State that cannot be serialized could not have reached Jev anyway.
    return {
      value: { state: "omitted: state was not JSON-serializable" },
      truncatedChars: 0,
      truncatedItems: 0,
    };
  }

  let copy: JevState;
  try {
    copy = JSON.parse(serialized) as JevState;
  } catch {
    return {
      value: { state: "omitted: state was not JSON-serializable" },
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
    throw new Error("state too large after truncation");
  }

  return { value: copy, truncatedChars: dropped, truncatedItems: droppedItems };
}

function errorMessage(error: unknown): string {
  return (error as { message?: string } | null | undefined)?.message ?? String(error);
}

export class JevClient {
  private clients = new Map<JevProvider, TypeSafeClient>();
  private apiKey: string | null = null;
  private providerOverrides: ProviderOverrides = {};
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };

  /**
   * Apply provider/model/base URL from the layered settings. A non-empty base URL that
   * points at OpenRouter also infers the provider, matching env behaviour.
   */
  public setProviderOverrides(overrides: ProviderOverrides): void {
    this.providerOverrides = overrides ?? {};
    this.clients.clear();
  }

  /** Resolved provider, honouring layered settings and an in-session key override. */
  public getConfig(): JevProviderConfig | null {
    const { provider: choice, baseURL } = this.providerOverrides;

    const forced = choice && choice !== "auto" ? choice : null;
    const inferred = !forced && baseURL ? inferProviderFromBaseURL(baseURL) : null;
    const requested = forced ?? inferred;

    // A concrete provider chosen through layered settings must still respect
    // PI_JEV_API_KEY, which outranks provider-specific credentials. With no provider
    // selected, the full env/secret resolution order already handles the override.
    let base = requested ? resolveProviderConfigFor(requested) : resolveJevProvider();

    // If the selected provider has no credentials of its own, an in-session key can
    // still target it; with no provider selected, default to TypeSafe.
    if (!base && this.apiKey) {
      base = buildConfig(requested ?? "typesafe", this.apiKey, "set in-session");
    }
    if (!base) return null;

    const config = applyOverrides(base, this.providerOverrides);

    if (this.apiKey) {
      return {
        ...config,
        apiKey: this.apiKey,
        keyOrigin: "set in-session",
        authMode: "bearer",
      };
    }
    return config;
  }

  public getProviderInfo(): JevProviderInfo | null {
    const config = this.getConfig();
    if (!config) return null;
    return {
      provider: config.provider,
      label: config.label,
      baseURL: config.baseURL,
      model: config.model,
      keyOrigin: config.keyOrigin,
      authMode: config.authMode,
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.getConfig());
  }

  /** Human-readable description of where the API key came from, or null when unconfigured. */
  public getKeyOrigin(): string | null {
    return this.getConfig()?.keyOrigin ?? null;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
    this.clients.clear();
  }

  private getClient(config: JevProviderConfig): TypeSafeClient {
    let client = this.clients.get(config.provider);
    if (!client) {
      client = new TypeSafeClient({
        apiKey: config.apiKey ?? LOCAL_SDK_PLACEHOLDER,
        baseURL: config.baseURL,
        defaultModel: config.model,
        defaultHeaders:
          config.provider === "openrouter"
            ? { "HTTP-Referer": "https://github.com/rigerc/pi-jev", "X-OpenRouter-Title": "pi-jev" }
            : undefined,
      });
      this.clients.set(config.provider, client);
    }
    return client;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const primary = this.getConfig();
    if (!primary) {
      throw new Error(describeUnconfigured());
    }

    const formattedQuestions: Record<string, any> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        formattedQuestions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        // Noul criteria describe the yes/no outcomes; dropping them would leave the
        // boundary case undefined for the model.
        formattedQuestions[id] = noul(q.instructions, q.criteria ?? undefined);
      } else if (q.type === "score") {
        formattedQuestions[id] = score(q.instructions, q.criteria as any);
      }
    }

    const capped = capState(
      request.state,
      primary.provider === "laya" ? LAYA_MAX_STATE_CHARS : MAX_STATE_CHARS
    );
    // The API accepts a plain string state, so pass it through unwrapped.
    const statePayload: any = capped.value;

    if (capped.truncatedChars > 0 || capped.truncatedItems > 0) {
      this.stats.truncations = (this.stats.truncations ?? 0) + 1;
      this.stats.truncatedChars = (this.stats.truncatedChars ?? 0) + capped.truncatedChars;
      this.stats.truncatedItems = (this.stats.truncatedItems ?? 0) + capped.truncatedItems;
    }

    const body = {
      state: statePayload,
      questions: formattedQuestions,
      model: request.model,
    };

    let active = primary;
    let response: any;
    try {
      response = await this.getClient(active).systemOne(body, { signal });
    } catch (error) {
      // Retry the other hosted provider once, and only for provider-scoped failures.
      const secondary = isProviderFallbackError(error)
        ? resolveFallbackProvider(active.provider, this.providerOverrides)
        : null;
      if (!secondary) {
        this.stats.lastError = errorMessage(error);
        throw error;
      }

      this.stats.fallback = {
        from: active.provider,
        to: secondary.provider,
        reason: errorMessage(error),
      };
      active = secondary;
      try {
        response = await this.getClient(active).systemOne(body, { signal });
      } catch (retryError) {
        this.stats.lastError = errorMessage(retryError);
        throw retryError;
      }
    }

    const elapsedMs = Date.now() - startTime;
    const usage = normalizeUsage(response?.usage);

    this.stats.requestsCount += 1;
    this.stats.provider = active.provider;
    this.stats.model = response?.model || active.model;
    this.stats.totalTokens += usage.totalTokens;
    this.stats.totalCostUsd += usage.costUsd ?? 0;
    this.stats.lastElapsedMs = elapsedMs;
    this.stats.lastError = undefined;

    const answers: Record<string, JevAnswerResult> = {};
    for (const [id, rawAns] of Object.entries(response?.answers || {})) {
      const qConfig = request.questions[id];
      if (!qConfig) continue;
      const raw = rawAns as any;

      if (qConfig.type === "choice") {
        answers[id] = {
          type: "choice",
          value: raw.choice ?? raw.value,
          confidence: raw.confidence,
          distribution: raw.probabilities ?? raw.distribution,
          raw: rawAns,
        };
      } else if (qConfig.type === "noul") {
        const prob = raw.noul ?? raw.probability ?? raw.value ?? 0;
        answers[id] = {
          type: "noul",
          value: prob,
          raw: rawAns,
        };
      } else if (qConfig.type === "score") {
        const s = raw.score ?? raw.value ?? 0;
        answers[id] = {
          type: "score",
          value: s,
          confidence: raw.confidence,
          distribution: raw.probabilities ?? raw.distribution,
          legend: raw.legend,
          raw: rawAns,
        };
      }
    }

    return {
      answers,
      model: response?.model || active.model,
      usage,
      elapsedMs,
    };
  }
}
