import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  Usage,
} from '@earendil-works/pi-ai';
import type { ClassifierRegistry } from '../../src/system-one.js';

export interface FakeModelSpec {
  provider: string;
  id: string;
  api?: ClassifierApi;
  name?: string;
}

/** A catalog entry with the fields the registry hands out, and nothing that costs tokens. */
export function fakeClassifierModel(spec: FakeModelSpec): ClassifierModel<ClassifierApi> {
  return {
    type: 'classifier',
    provider: spec.provider,
    id: spec.id,
    name: spec.name ?? spec.id,
    api: spec.api ?? 'typesafe-system-one',
    baseUrl: 'https://example.invalid',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
  } as ClassifierModel<ClassifierApi>;
}

export interface FakeClassifyCall {
  model: ClassifierModel<ClassifierApi>;
  context: ClassifierContext;
  options?: { signal?: AbortSignal; temperature?: number };
}

export interface FakeRegistryOptions {
  /** Every classifier the fake offers, in the order the real catalog would list them. */
  models?: FakeModelSpec[];
  /** Authenticated providers; anything else reports as unconfigured. */
  authenticated?: string[];
  /**
   * Produce a result for one call. Return a partial answer map and the fake fills in
   * the result envelope; throw to simulate a classifier that cannot be reached.
   */
  classify?: (call: FakeClassifyCall, index: number) => Partial<ClassifierResult> | undefined;
  usage?: Partial<Usage>;
  /**
   * Make `classify` reject for a given call, as pi does for a pre-flight failure such as
   * an unresolvable credential. `classify` above only produces error *results*, so this
   * is the only way to exercise a rejected promise.
   */
  throwOn?: (call: FakeClassifyCall, index: number) => Error | undefined;
}

export interface FakeRegistry {
  registry: ClassifierRegistry;
  calls: FakeClassifyCall[];
  /** Convenience access to the model a call was made with. */
  calledProviders(): string[];
}

function baseResult(
  model: ClassifierModel<ClassifierApi>,
  overrides: Partial<ClassifierResult> | undefined,
  usage: Partial<Usage> | undefined,
): ClassifierResult {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: 'stop',
    timestamp: Date.now(),
    ...(usage ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage } as Usage } : {}),
    ...overrides,
  };
}

/**
 * A stand-in for the slice of pi's `ModelRegistry` the classifier client uses.
 *
 * `classify` never rejects in pi, it returns `stopReason: 'error'`, so the fake takes
 * the same shape: a throw here is turned into an error result, which is what makes the
 * client's fallback chain testable.
 */
export function fakeRegistry(options: FakeRegistryOptions = {}): FakeRegistry {
  const specs = options.models ?? [
    { provider: 'typesafe', id: 'jev-latest' },
    { provider: 'openrouter', id: 'typesafe/jev-1.13' },
  ];
  const models = specs.map(fakeClassifierModel);
  const authenticated = new Set(options.authenticated ?? specs.map((spec) => spec.provider));
  const calls: FakeClassifyCall[] = [];

  const registry = {
    getModelOfType(_type: string, provider: string, modelId: string) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    async getAvailableOfType(_type: string) {
      return models.filter((model) => authenticated.has(model.provider));
    },
    async classify(
      model: ClassifierModel<ClassifierApi>,
      context: ClassifierContext,
      classifyOptions?: { signal?: AbortSignal; temperature?: number },
    ) {
      const call: FakeClassifyCall = { model, context, options: classifyOptions };
      calls.push(call);
      const index = calls.length - 1;
      const thrown = options.throwOn?.(call, index);
      if (thrown) throw thrown;
      try {
        const overrides = options.classify?.(call, index);
        return baseResult(model, overrides, options.usage);
      } catch (error) {
        return baseResult(
          model,
          {
            stopReason: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          undefined,
        );
      }
    },
    getProviderAuthStatus(provider: string) {
      return authenticated.has(provider)
        ? { configured: true, source: 'stored' as const }
        : { configured: false };
    },
    getProviderDisplayName(provider: string) {
      return provider
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    },
  } as unknown as ClassifierRegistry;

  return { registry, calls, calledProviders: () => calls.map((call) => call.model.provider) };
}
