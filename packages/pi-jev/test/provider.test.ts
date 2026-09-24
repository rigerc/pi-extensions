import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  DEFAULT_MODEL,
  FALLBACK_STATUSES,
  JEV_ENV,
  JEV_PROVIDERS,
  JevClient,
  inferProviderFromBaseURL,
  isProviderFallbackError,
  normalizeUsage,
  parseProvider,
  resolveFallbackProvider,
  resolveJevProvider,
} from "../src/jev.js";

const MANAGED_ENV = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
  "OPENROUTER_API_KEY",
  JEV_ENV.provider,
  JEV_ENV.apiKey,
  JEV_ENV.baseURL,
  JEV_ENV.model,
  JEV_ENV.secretsDir,
] as const;

/**
 * Wipe every provider env var and point the secret store at a temp dir, so resolution
 * never sees the developer's real credentials or `~/.pi/agent/secrets` contents.
 */
function isolateEnv(vars: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-secrets-"));
  process.env[JEV_ENV.secretsDir] = secretsDir;
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;

  return {
    secretsDir,
    writeSecret: (name: string, value: string) =>
      fs.writeFileSync(path.join(secretsDir, name), value),
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(secretsDir, { recursive: true, force: true });
    },
  };
}

interface StubCall {
  baseURL: string;
  defaultModel: string;
  defaultHeaders: Record<string, string> | undefined;
  request: any;
}

/** Replace the SDK transport so provider/fallback logic runs without network access. */
function stubSystemOne(handler: (call: StubCall) => unknown) {
  const original = TypeSafeClient.prototype.systemOne;
  const calls: StubCall[] = [];

  (TypeSafeClient.prototype as any).systemOne = async function (request: any) {
    const call: StubCall = {
      baseURL: (this as any).baseURL,
      defaultModel: (this as any).defaultModel,
      defaultHeaders: (this as any).defaultHeaders,
      request,
    };
    calls.push(call);
    return handler(call);
  };

  return {
    calls,
    restore() {
      (TypeSafeClient.prototype as any).systemOne = original;
    },
  };
}

const NOUL_QUESTION = { ok: { type: "noul" as const, instructions: "Is this fine?" } };

test("test_provider_explicit_openrouter_uses_openrouter_base_url_and_key", () => {
  const env = isolateEnv({ OPENROUTER_API_KEY: "or-key", [JEV_ENV.provider]: "openrouter" });
  try {
    const info = new JevClient().getProviderInfo();
    assert.equal(info?.provider, "openrouter");
    assert.equal(info?.label, "OpenRouter");
    assert.equal(info?.baseURL, "https://openrouter.ai/api");
    assert.equal(info?.model, DEFAULT_MODEL);
    assert.equal(info?.keyOrigin, "$OPENROUTER_API_KEY");
  } finally {
    env.restore();
  }
});

test("test_provider_auto_detect_prefers_typesafe_when_both_keys_set", () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "typesafe");
    assert.equal(config?.baseURL, "https://api.typesafe.ai");
    assert.equal(config?.keyOrigin, "$TYPESAFE_API_KEY");
  } finally {
    env.restore();
  }
});

test("test_provider_auto_detect_uses_openrouter_when_only_openrouter_key_set", () => {
  const env = isolateEnv({ OPENROUTER_API_KEY: "or-key" });
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "openrouter");
    assert.equal(config?.keyOrigin, "$OPENROUTER_API_KEY");
  } finally {
    env.restore();
  }
});

test("test_provider_forced_provider_wins_over_the_other_providers_key", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    OPENROUTER_API_KEY: "or-key",
    [JEV_ENV.provider]: "openrouter",
  });
  try {
    assert.equal(resolveJevProvider()?.provider, "openrouter");
  } finally {
    env.restore();
  }
});

test("test_provider_pi_jev_api_key_and_base_url_override_everything", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    [JEV_ENV.apiKey]: "custom-key",
    [JEV_ENV.baseURL]: "https://openrouter.ai/api",
    [JEV_ENV.model]: "typesafe/jev-1.13",
  });
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "openrouter", "provider is inferred from the override base URL");
    assert.equal(config?.apiKey, "custom-key");
    assert.equal(config?.keyOrigin, "$PI_JEV_API_KEY");
    assert.equal(config?.baseURL, "https://openrouter.ai/api");
    assert.equal(config?.model, "typesafe/jev-1.13");
  } finally {
    env.restore();
  }
});

test("test_provider_secret_file_is_used_when_the_env_var_is_absent", () => {
  const env = isolateEnv();
  env.writeSecret("openrouter_api_key", "file-key\n");
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "openrouter");
    assert.equal(config?.apiKey, "file-key");
    assert.equal(config?.keyOrigin, "~/.pi/agent/secrets/openrouter_api_key");
  } finally {
    env.restore();
  }
});

test("test_provider_legacy_typesafe_base_url_and_model_env_are_honoured", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    TYPESAFE_BASE_URL: "https://proxy.example.com",
    TYPESAFE_DEFAULT_MODEL: "jev-1.13.0",
  });
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "typesafe");
    assert.equal(config?.baseURL, "https://proxy.example.com");
    assert.equal(config?.model, "jev-1.13.0");
  } finally {
    env.restore();
  }
});

test("test_provider_openrouter_base_url_has_no_v1_suffix", () => {
  assert.equal(JEV_PROVIDERS.openrouter.baseURL, "https://openrouter.ai/api");
  assert.equal(JEV_PROVIDERS.typesafe.baseURL, "https://api.typesafe.ai");
  // The SDK appends the path itself; a /v1 suffix here would yield /api/v1/v1/systemone.
  assert.equal(
    `${JEV_PROVIDERS.openrouter.baseURL}/v1/systemone`,
    "https://openrouter.ai/api/v1/systemone"
  );
});

test("test_provider_base_url_override_naming_openrouter_selects_the_openrouter_key", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    OPENROUTER_API_KEY: "or-key",
    [JEV_ENV.baseURL]: "https://openrouter.ai/api",
  });
  try {
    const config = resolveJevProvider();
    assert.equal(config?.provider, "openrouter");
    assert.equal(config?.keyOrigin, "$OPENROUTER_API_KEY");
    assert.equal(config?.baseURL, "https://openrouter.ai/api");
  } finally {
    env.restore();
  }
});

test("test_provider_base_url_override_never_sends_the_other_providers_key", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    [JEV_ENV.baseURL]: "https://openrouter.ai/api",
  });
  try {
    assert.equal(
      resolveJevProvider(),
      null,
      "no OpenRouter key exists, so the TypeSafe key is not sent to OpenRouter"
    );
  } finally {
    env.restore();
  }
});

test("test_fallback_ignores_a_base_url_override_naming_the_other_provider", () => {
  const env = isolateEnv({
    TYPESAFE_API_KEY: "ts-key",
    OPENROUTER_API_KEY: "or-key",
    [JEV_ENV.baseURL]: "https://openrouter.ai/api",
  });
  try {
    const fallback = resolveFallbackProvider("openrouter");
    assert.equal(fallback?.provider, "typesafe");
    assert.equal(
      fallback?.baseURL,
      "https://api.typesafe.ai",
      "an OpenRouter URL must not be applied to the TypeSafe fallback"
    );
  } finally {
    env.restore();
  }
});

test("test_fallback_applies_the_model_override_but_guards_the_base_url", () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  try {
    assert.equal(resolveFallbackProvider("openrouter", { model: "jev-1.13" })?.model, "jev-1.13");
    assert.equal(
      resolveFallbackProvider("openrouter", { baseURL: "https://openrouter.ai/api" })?.baseURL,
      "https://api.typesafe.ai"
    );
  } finally {
    env.restore();
  }
});

test("test_forced_provider_ignores_a_settings_base_url_naming_the_other_provider", () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  try {
    const client = new JevClient();
    client.setProviderOverrides({ provider: "typesafe", baseURL: "https://openrouter.ai/api" });
    const info = client.getProviderInfo();
    assert.equal(info?.provider, "typesafe");
    assert.equal(info?.baseURL, "https://api.typesafe.ai");
  } finally {
    env.restore();
  }
});

test("test_settings_selected_provider_honours_pi_jev_api_key", () => {
  const env = isolateEnv({ [JEV_ENV.apiKey]: "override-key" });
  try {
    const client = new JevClient();
    client.setProviderOverrides({ provider: "openrouter" });
    const info = client.getProviderInfo();
    assert.equal(info?.provider, "openrouter");
    assert.equal(info?.keyOrigin, "$PI_JEV_API_KEY");
    assert.equal(client.getConfig()?.apiKey, "override-key");
  } finally {
    env.restore();
  }
});

test("test_pi_jev_provider_with_pi_jev_api_key_resolves_that_provider", () => {
  const env = isolateEnv({
    [JEV_ENV.provider]: "openrouter",
    [JEV_ENV.apiKey]: "override-key",
  });
  try {
    const info = new JevClient().getProviderInfo();
    assert.equal(info?.provider, "openrouter");
    assert.equal(info?.keyOrigin, "$PI_JEV_API_KEY");
  } finally {
    env.restore();
  }
});

test("test_fallback_uses_pi_jev_api_key_for_the_other_provider", () => {
  const env = isolateEnv({ [JEV_ENV.apiKey]: "override-key" });
  try {
    const fallback = resolveFallbackProvider("typesafe");
    assert.equal(fallback?.provider, "openrouter");
    assert.equal(fallback?.apiKey, "override-key");
    assert.equal(fallback?.keyOrigin, "$PI_JEV_API_KEY");
  } finally {
    env.restore();
  }
});

test("test_parse_provider_and_infer_base_url_handle_unknown_input", () => {
  assert.equal(parseProvider("OPENROUTER"), "openrouter");
  assert.equal(parseProvider(" typesafe "), "typesafe");
  assert.equal(parseProvider("nonsense"), "auto");
  assert.equal(parseProvider(undefined), "auto");
  assert.equal(inferProviderFromBaseURL("https://openrouter.ai/api"), "openrouter");
  assert.equal(inferProviderFromBaseURL("https://api.typesafe.ai"), null);
  assert.equal(inferProviderFromBaseURL(undefined), null);
});

test("test_normalize_usage_handles_sdk_snake_case_openrouter_cost_and_legacy_camel_case", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5, cost: 0.0042 }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd: 0.0042,
  });
  assert.deepEqual(normalizeUsage({ inputTokens: 2, outputTokens: 3, totalTokens: 9 }), {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 9,
  });
  assert.deepEqual(normalizeUsage(undefined), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("test_isProviderFallbackError_classifies_only_provider_scoped_statuses", () => {
  assert.deepEqual([...FALLBACK_STATUSES], [401, 402, 403, 404]);
  for (const status of FALLBACK_STATUSES) {
    assert.equal(isProviderFallbackError({ status }), true, `status ${status}`);
  }
  assert.equal(isProviderFallbackError({ status: 429 }), false);
  assert.equal(isProviderFallbackError({ status: 500 }), false);
  assert.equal(isProviderFallbackError(new Error("nope")), false);
});

test("test_resolve_fallback_provider_returns_the_other_configured_provider", () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  try {
    assert.equal(resolveFallbackProvider("typesafe")?.provider, "openrouter");
    assert.equal(resolveFallbackProvider("openrouter")?.provider, "typesafe");
  } finally {
    env.restore();
  }

  const solo = isolateEnv({ OPENROUTER_API_KEY: "or-key" });
  try {
    assert.equal(resolveFallbackProvider("openrouter"), null, "no other provider is configured");
  } finally {
    solo.restore();
  }
});

test("test_client_records_tokens_and_cost_from_openrouter_usage", async () => {
  const env = isolateEnv({ OPENROUTER_API_KEY: "or-key" });
  const stub = stubSystemOne(() => ({
    model: "typesafe/jev-latest",
    answers: { ok: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 },
  }));
  try {
    const client = new JevClient();
    const response = await client.evaluate({ state: "some state", questions: NOUL_QUESTION });

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].baseURL, "https://openrouter.ai/api");
    assert.equal(stub.calls[0].defaultModel, DEFAULT_MODEL);

    assert.equal(response.answers.ok.value, 0.9);
    assert.equal(response.usage?.totalTokens, 100);
    assert.equal(response.usage?.costUsd, 0.0000042);

    assert.equal(client.stats.requestsCount, 1);
    assert.equal(client.stats.totalTokens, 100);
    assert.equal(client.stats.totalCostUsd, 0.0000042);
    assert.equal(client.stats.provider, "openrouter");
    assert.equal(client.stats.model, "typesafe/jev-latest");
    assert.equal(client.stats.fallback, undefined);
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_client_sends_string_state_unwrapped_and_labels_openrouter_requests", async () => {
  const env = isolateEnv({ OPENROUTER_API_KEY: "or-key" });
  const stub = stubSystemOne(() => ({
    model: "typesafe/jev-latest",
    answers: { ok: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 1, output_tokens: 0 },
  }));
  try {
    await new JevClient().evaluate({ state: "plain state", questions: NOUL_QUESTION });
    assert.equal(stub.calls[0].request.state, "plain state", "string state passes through as-is");
    assert.equal(stub.calls[0].defaultHeaders?.["HTTP-Referer"], "https://github.com/rigerc/pi-jev");
    assert.equal(stub.calls[0].defaultHeaders?.["X-OpenRouter-Title"], "pi-jev");
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_score_answers_expose_probabilities_and_legend", async () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key" });
  const stub = stubSystemOne(() => ({
    model: "jev-latest",
    answers: {
      severity: {
        type: "score",
        score: 1.4,
        confidence: 0.8,
        probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 },
        legend: { "0": "low", "1": "medium", "2": "high" },
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  try {
    const response = await new JevClient().evaluate({
      state: "state",
      questions: {
        severity: {
          type: "score",
          instructions: "How severe?",
          criteria: ["low", "medium", "high"],
        },
      },
    });

    const answer = response.answers.severity;
    assert.equal(answer.value, 1.4);
    assert.equal(answer.confidence, 0.8);
    assert.deepEqual(answer.distribution, { "0": 0.1, "1": 0.5, "2": 0.4 });
    assert.deepEqual(answer.legend, { "0": "low", "1": "medium", "2": "high" });
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_array_state_is_preserved_not_rewritten", async () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key" });
  const stub = stubSystemOne(() => ({
    model: "jev-latest",
    answers: { ok: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  try {
    await new JevClient().evaluate({
      state: [1, "two", { three: 3 }],
      questions: NOUL_QUESTION,
    });
    assert.deepEqual(stub.calls[0].request.state, [1, "two", { three: 3 }]);
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_fallback_uses_the_model_override_from_settings", async () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  let attempts = 0;
  const stub = stubSystemOne(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("401 unauthorized"), { status: 401 });
    return {
      model: "jev-1.13",
      answers: { ok: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 3, output_tokens: 0 },
    };
  });
  try {
    const client = new JevClient();
    client.setProviderOverrides({ provider: "typesafe", model: "jev-1.13" });
    await client.evaluate({ state: "s", questions: NOUL_QUESTION });
    assert.equal(attempts, 2);
    assert.equal(stub.calls[0].defaultModel, "jev-1.13");
    assert.equal(stub.calls[1].defaultModel, "jev-1.13", "the model override reaches the fallback");
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_fallback_retries_secondary_once_on_authentication_error", async () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
  let attempts = 0;
  const stub = stubSystemOne(() => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("401 unauthorized"), { status: 401 });
    }
    return {
      model: "~typesafe/jev-latest",
      answers: { ok: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 3, output_tokens: 0 },
    };
  });
  try {
    const client = new JevClient();
    const response = await client.evaluate({ state: "some state", questions: NOUL_QUESTION });

    assert.equal(attempts, 2, "exactly one fallback attempt");
    assert.equal(stub.calls[0].baseURL, "https://api.typesafe.ai");
    assert.equal(stub.calls[1].baseURL, "https://openrouter.ai/api");
    assert.equal(response.answers.ok.value, 0.5);

    assert.deepEqual(client.stats.fallback, {
      from: "typesafe",
      to: "openrouter",
      reason: "401 unauthorized",
    });
    assert.equal(client.stats.provider, "openrouter");
    assert.equal(client.stats.totalTokens, 3);
    assert.equal(client.stats.lastError, undefined);
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_fallback_does_not_retry_on_rate_limit_server_error_or_abort", async () => {
  const cases: Array<{ label: string; error: unknown }> = [
    { label: "429", error: Object.assign(new Error("rate limited"), { status: 429 }) },
    { label: "500", error: Object.assign(new Error("boom"), { status: 500 }) },
    { label: "abort", error: Object.assign(new Error("aborted"), { name: "APIUserAbortError" }) },
  ];

  for (const { label, error } of cases) {
    const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "or-key" });
    let attempts = 0;
    const stub = stubSystemOne(() => {
      attempts += 1;
      throw error;
    });
    try {
      const client = new JevClient();
      await assert.rejects(() => client.evaluate({ state: "s", questions: NOUL_QUESTION }));
      assert.equal(attempts, 1, `${label}: must not retry`);
      assert.equal(client.stats.fallback, undefined, `${label}: no fallback recorded`);
      assert.equal(client.stats.lastError, (error as Error).message, `${label}: error recorded`);
    } finally {
      stub.restore();
      env.restore();
    }
  }
});

test("test_fallback_records_no_secondary_when_only_one_provider_is_configured", async () => {
  const env = isolateEnv({ TYPESAFE_API_KEY: "ts-key" });
  let attempts = 0;
  const stub = stubSystemOne(() => {
    attempts += 1;
    throw Object.assign(new Error("401 unauthorized"), { status: 401 });
  });
  try {
    const client = new JevClient();
    await assert.rejects(() => client.evaluate({ state: "s", questions: NOUL_QUESTION }));
    assert.equal(attempts, 1);
    assert.equal(client.stats.fallback, undefined);
  } finally {
    stub.restore();
    env.restore();
  }
});

test("test_unconfigured_client_reports_not_configured_and_no_fallback", async () => {
  const env = isolateEnv();
  try {
    const client = new JevClient();
    assert.equal(client.isConfigured(), false);
    assert.equal(client.getKeyOrigin(), null);
    assert.equal(client.getProviderInfo(), null);
    await assert.rejects(
      () => client.evaluate({ state: "s", questions: NOUL_QUESTION }),
      /No Jev provider is configured/
    );
  } finally {
    env.restore();
  }
});

test("test_set_api_key_overrides_the_resolved_key_for_the_session", () => {
  const env = isolateEnv({ OPENROUTER_API_KEY: "or-key" });
  try {
    const client = new JevClient();
    client.setApiKey("session-key");
    const info = client.getProviderInfo();
    assert.equal(info?.provider, "openrouter", "provider is still auto-detected");
    assert.equal(info?.keyOrigin, "set in-session");
    assert.equal(client.getConfig()?.apiKey, "session-key");
  } finally {
    env.restore();
  }
});
