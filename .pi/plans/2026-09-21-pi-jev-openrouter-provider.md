---
title: "Adapt pi-jev to support OpenRouter as a Jev System One provider"
status: draft
created: "2026-09-21T20:41:22.382Z"
type: feature
---

# Adapt pi-jev to support OpenRouter as a Jev provider

## Goal

Make `pi-jev` work with **either** TypeSafe-direct **or** OpenRouter as the System One
(Jev) API backend, with key-based auto-detection and a single bounded cross-provider
fallback on auth/config failure. No user-visible behavior change for existing
TypeSafe users.

Fork: <https://github.com/rigerc/pi-jev> (fork-only, not intended for upstream PR).
Working copy: `/mnt/extra-ssd/dev/projects2/pi-extensions/packages/pi-jev`.

## Status — all phases implemented

Branch `feature/openrouter-provider` @ `7d077f5` (commit `feat(jev): support OpenRouter as a System One provider`).

| Phase | Result |
| --- | --- |
| 0 — Fork + monorepo wiring | ✅ `rigerc/pi-jev`, cloned to `packages/pi-jev`, `upstream` remote, gitignored, **excluded from the monorepo workspace set** via `"!packages/pi-jev"` (npm would otherwise hoist its deps into the root lock) |
| 1 — Provider abstraction | ✅ `src/jev.ts`: provider registry, resolution order, per-provider client cache, bounded fallback, usage normalization |
| 2 — Observability & messages | ✅ `/jev status` (provider, API root, model, cost, fallback); `describeUnconfigured()` replaces hardcoded TypeSafe strings in commands/tools/agent/gate/designer |
| 3 — Tests | ✅ `test/provider.test.ts` (18 cases) + router candidate-bound guard; **67 tests pass** (was 47) |
| 4 — Docs | ✅ README two-provider setup + env matrix + OpenRouter caveats; CHANGELOG `0.6.0` |
| 5 — CI / packaging | ✅ `@rigerc/pi-jev@0.6.0`, publishConfig, root passthrough scripts, stale lockfile fixed so `npm ci` passes |

**Verification evidence**

- `npm run typecheck` clean; `npm test` 67/67; `npm ci` succeeds from a clean install.
- Extension loads under real pi v0.86.1 and registers all five flags.
- Live OpenRouter request (`POST https://openrouter.ai/api/v1/systemone`): gate CLI exit 0 (P=0.99); real evaluation returned `model=typesafe/jev-1.13-20260917`, `totalTokens=406`, `costUsd=0.000014742`, and a populated choice `distribution`.
- Root monorepo lock untouched; workspace set still contains only `@rigerc/pi-jevselector`.

**Deviations from the written plan**

- Added `PI_JEV_SECRETS_DIR`: needed to make provider resolution testable without reading the developer's real `~/.pi/agent/secrets`. Also useful for custom layouts.
- Fixed `distribution` (choice answers now read the SDK's `probabilities`, not only the legacy key) and the stale committed lockfile — both found while implementing.
- Not pushed to `origin`; the branch exists only locally so far.
- No upstream PR, per the chosen fork-only strategy.

## Verified facts driving the design

OpenRouter implements TypeSafe's System One wire format, so **no protocol shim is
needed** — only client configuration:

| Item | TypeSafe-direct | OpenRouter |
| --- | --- | --- |
| Base URL (SDK option `baseURL`) | `https://api.typesafe.ai` | `https://openrouter.ai/api` |
| Actual endpoint (SDK appends) | `POST /v1/systemone` | `POST /api/v1/systemone` |
| Auth | `Authorization: Bearer <TYPESAFE_API_KEY>` | `Authorization: Bearer <OPENROUTER_API_KEY>` |
| Model IDs | `jev-latest`, `jev-1.13.0` | bare IDs are mapped server-side (`jev-latest` → `~typesafe/jev-latest`, `jev-1.13` → `typesafe/jev-1.13`); prefixed IDs pass through |
| Response extras | — | adds `id`, `provider`, `usage.cost` (SDK passes through) |
| Models API | `client.models.list()` supported | **not supported** (returns OpenRouter shape → SDK rejects) |
| Context window | — | 32K tokens |

`@typesafe-ai/sdk@0.6.0` confirmed API surface (`package/dist/index.d.mts`):
`TypeSafeClientConfig { apiKey, baseURL, defaultModel, defaultHeaders, retry, timeout, fetch, ... }`,
env fallbacks `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`,
error classes `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `RateLimitError`,
and `Usage { input_tokens, output_tokens }`.

**Pre-existing bug found while auditing:** `src/jev.ts:113` reads
`response.usage?.totalTokens`, but the SDK returns `input_tokens`/`output_tokens`.
`stats.totalTokens` therefore never accumulates. Fix as part of Phase 2.

Because the bare model id `jev-latest` is valid on **both** backends, the default
model stays `jev-latest` and only the base URL + key change per provider.

## Design

### Provider resolution (single source of truth)

New exported helpers in `src/jev.ts`:

```ts
export type JevProvider = "typesafe" | "openrouter";

export interface JevProviderConfig {
  provider: JevProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  /** Human-readable provenance for /jev status, e.g. "$OPENROUTER_API_KEY". */
  keyOrigin: string;
}

export const JEV_PROVIDERS: Record<JevProvider, {
  baseURL: string; model: string; keyEnv: string; baseURLEnv?: string;
  modelEnv?: string; secretFile: string; label: string;
}>;
```

Resolution order (first match wins):

1. **Explicit override** — `PI_JEV_API_KEY` (+ optional `PI_JEV_BASE_URL` / `PI_JEV_MODEL`).
   Provider inferred from `PI_JEV_PROVIDER`, else from `PI_JEV_BASE_URL` containing `openrouter.ai`, else `typesafe`.
2. **Forced provider** — `PI_JEV_PROVIDER=typesafe|openrouter` selects that provider's
   key env (`TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`) + its default base URL.
3. **Auto-detect** (`PI_JEV_PROVIDER` unset or `auto`) — `TYPESAFE_API_KEY` first,
   then `OPENROUTER_API_KEY`.
4. **Secret files** — `~/.pi/agent/secrets/typesafe_api_key`,
   `~/.pi/agent/secrets/openrouter_api_key` (same precedence, per provider).

Legacy `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` continue to be honored for the
typesafe provider only. `PI_JEV_MODEL` overrides both.

### Client construction

```ts
new TypeSafeClient({
  apiKey: cfg.apiKey,
  baseURL: cfg.baseURL,        // no trailing /v1 — SDK appends /v1/systemone
  defaultModel: cfg.model,
  defaultHeaders: cfg.provider === "openrouter"
    ? { "HTTP-Referer": "https://github.com/rigerc/pi-jev", "X-Title": "pi-jev" }
    : undefined,
});
```

### Fallback chain (exactly one retry, never a loop)

- Compute primary via the order above, plus a `secondary` from the remaining
  configured provider (if any).
- On `AuthenticationError` / `PermissionDeniedError` / `NotFoundError` (or HTTP
  401/402/403/404) from the primary, rebuild the client for `secondary` and retry
  **once**. Record `stats.fallback = { from, to, reason }` for `/jev status`.
- Never fall back on user abort, timeout, 429, 5xx, or question-validation errors —
  those propagate unchanged so callers keep their existing fail-closed semantics.
- If no secondary is configured, behavior is identical to upstream.

### Usage / cost normalization

```ts
function normalizeUsage(raw: any) {
  const inputTokens  = raw?.input_tokens  ?? raw?.inputTokens  ?? 0;
  const outputTokens = raw?.output_tokens ?? raw?.outputTokens ?? 0;
  const totalTokens  = raw?.total_tokens  ?? raw?.totalTokens  ?? inputTokens + outputTokens;
  const costUsd      = typeof raw?.cost === "number" ? raw.cost : undefined; // OpenRouter only
  return { inputTokens, outputTokens, totalTokens, costUsd };
}
```

Update `src/types.ts`:

- `JevEvaluationResponse.usage` → `{ inputTokens, outputTokens, totalTokens, costUsd? }`
  (keep `totalTokens` name for compatibility with existing readers).
- `JevSessionStats` → add `totalCostUsd`, `provider?: JevProvider`, `model?: string`,
  `fallback?: { from: JevProvider; to: JevProvider; reason: string }`.

### Preserved public surface

`JevClient.isConfigured()`, `getKeyOrigin()`, `setApiKey()`, `evaluate()`, and
`stats.requestsCount / totalTokens` keep working — `test/*.test.ts` stubs them.

## Files touched

| File | Change |
| --- | --- |
| `src/jev.ts` | provider registry, resolution, client build, fallback, usage normalization |
| `src/types.ts` | usage + stats types |
| `src/commands.ts` | `/jev status` provider/model/cost/fallback lines; provider-aware test + error copy (lines 31, 52, 71–73, 90, 94) |
| `src/tools.ts` | provider-aware messages (lines 20, 72, 128, 152, 157) |
| `src/agent.ts` | provider-aware unconfigured error (line 34) |
| `src/gate.ts` | provider-aware error + help text (lines 66, 141) |
| `src/designer.ts` | neuter "TypeSafe Jev model" → "System One (Jev) model" (line 8) |
| `test/provider.test.ts` | **new** — resolution, fallback, usage normalization |
| `test/commands.test.ts` | extend status assertions for provider lines |
| `README.md`, `CHANGELOG.md` | OpenRouter setup section + 0.6.0 entry |
| `package.json` | name/repo/bin identity for the fork |

## Phases

### Phase 0 — Fork + monorepo wiring ✅ (done)

- [x] GitHub fork created: `rigerc/pi-jev`.
- [x] Cloned to `packages/pi-jev`; remotes `origin` (fork) + `upstream` (TheoOliveira).
- [x] `packages/pi-jev/` added to monorepo `.gitignore` (nested `.git`; npm `workspaces: packages/*` still links it).
- [x] Default branch `main` @ `549c2bf`.

**Verify:** `cd packages/pi-jev && git remote -v && git log --oneline -1`

### Phase 1 — Provider abstraction (core)

1. `git switch -c feature/openrouter-provider` in `packages/pi-jev`.
2. Add `JEV_PROVIDERS` registry + `resolveJevProvider()` + `resolveSecondaryProvider()`
   to `src/jev.ts`; export them for tests.
3. Rework `JevClient.getClient()` to build from a resolved `JevProviderConfig`;
   cache the client per provider so a forced provider switch mid-session works via
   `setApiKey()`.
4. Implement the one-shot auth-failure fallback in `evaluate()` around
   `client.systemOne(...)`.
5. Implement `normalizeUsage()` and fix the `totalTokens` accumulation bug.

**Verify:** `cd packages/pi-jev && npm run typecheck`

⏸️ **Pause** — review `src/jev.ts` diff before touching the other 14 call sites.

### Phase 2 — Observability & messages

1. `/jev status`: add
   - `Provider: openrouter (https://openrouter.ai/api) — key from $OPENROUTER_API_KEY`
   - `Model: jev-latest`
   - `Cost (session): $0.004200` when known, else `n/a`
   - `Fallback: typesafe → openrouter (authentication failed)` when it fired
   - keep `Total tokens used` (now actually populated).
2. Replace hardcoded "TypeSafe Jev" / "Set TYPESAFE_API_KEY" strings with a shared
   `describeConfig()` helper so error text names the provider actually in use and the
   env var/secret path that would fix it.
3. `bin/jev-gate-runner.ts` / `src/gate.ts`: `--model` still overrides; help text
   mentions `PI_JEV_PROVIDER` / `OPENROUTER_API_KEY`.

**Verify:** `npm run typecheck && npm test` (existing suites must stay green).

### Phase 3 — Tests

New `test/provider.test.ts` (snapshot `process.env`; no network — stub the SDK
client or `evaluate` transport):

- `test_provider_explicit_openrouter_uses_openrouter_base_url_and_key`
- `test_provider_auto_detect_prefers_typesafe_when_both_keys_set`
- `test_provider_auto_detect_uses_openrouter_when_only_openrouter_key_set`
- `test_provider_pi_jev_api_key_and_base_url_override_everything`
- `test_provider_secret_file_fallback_openrouter`
- `test_provider_openrouter_base_url_has_no_v1_suffix` (guards the `/api/v1/systemone` path)
- `test_normalize_usage_handles_sdk_snake_case_openrouter_cost_and_legacy_camel_case`
- `test_fallback_retries_secondary_once_on_authentication_error`
- `test_fallback_does_not_retry_on_rate_limit_or_abort`
- `test_unconfigured_client_reports_not_configured_and_no_fallback`

Extend `test/commands.test.ts` status assertions for the new lines (its mock client
supplies `getKeyOrigin`; add `getProviderInfo`/stats fields to the mock).

**Verify:** `npm test` — expect all suites green, new file ≥10 cases.

⏸️ **Pause** — confirm tests reflect intended provider precedence before docs/CI.

### Phase 4 — Docs

- `README.md`: replace the "Set your TypeSafe API key" setup block with a two-provider
  setup table (`TYPESAFE_API_KEY` vs `OPENROUTER_API_KEY`), the `PI_JEV_PROVIDER` /
  `PI_JEV_API_KEY` / `PI_JEV_BASE_URL` / `PI_JEV_MODEL` matrix, the OpenRouter base URL
  (`https://openrouter.ai/api`, no `/v1`), the 32K-context and prepaid-credit caveats,
  and a note that `client.models.list()` is unsupported on OpenRouter.
- Update the "Cost Clarity" bullet to mention OpenRouter billing (`usage.cost`).
- `CHANGELOG.md`: `0.6.0` — "feat: OpenRouter System One provider with auto-detect and
  one-shot auth fallback; fix token accounting (`usage.input_tokens`/`output_tokens`)".

### Phase 5 — CI / packaging

- `package.json`: `name` → `@rigerc/pi-jev`, `repository`/`bugs`/`homepage` → `rigerc/pi-jev`,
  `publishConfig.access: "public"`, version `0.6.0`.
- Keep the fork's own `.github/workflows/{ci,publish}.yml` (they run on `rigerc/pi-jev`;
  the monorepo's workflows do not see this nested repo).
- Add to the **monorepo** root `package.json` scripts (opt-in, does not affect
  `vitest run`): `"check:pi-jev": "npm --prefix packages/pi-jev run typecheck"`,
  `"test:pi-jev": "npm --prefix packages/pi-jev test"`.
- Add an OpenRouter row to `docs/` if a provider matrix is maintained there.

**Verify (full gate):**

```bash
cd /mnt/extra-ssd/dev/projects2/pi-extensions/packages/pi-jev
npm ci && npm run typecheck && npm test
```

**Manual smoke (opt-in, spend-aware):**

```bash
# TypeSafe path unchanged
TYPESAFE_API_KEY=ts_...  npx tsx bin/jev-gate-runner.ts -c "no syntax errors" -d
# OpenRouter path
OPENROUTER_API_KEY=sk-or-... npx tsx bin/jev-gate-runner.ts -c "no syntax errors" -d
# In-session: /jev status  → shows provider/baseURL/model/cost
#             /jev test    → fixed smoke evaluation against the active provider
```

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| OpenRouter's `client.models.list()` is unsupported | Confirm nothing in `src/` calls it (audit found none); do not add model listing. |
| OpenRouter needs prepaid credits → 402 | Classify 402 as a billing/auth-class error and surface an explicit message; do **not** auto-fallback on it unless the secondary is configured and healthy. |
| Fallback doubles latency and cost | Exactly one retry, only on auth/config-class failures; never on abort/timeout/429/5xx. |
| Jev's 32K context on OpenRouter | Existing bounds already hold (≤10 tool candidates, ≤6 designed questions); add one test asserting the state payload stays bounded. |
| Accidental key leakage in logs | `TYPESAFE_LOG_LEVEL` stays `warn` by default (SDK redacts credential headers at `debug`); never log `apiKey`/`baseURL`+key together. |
| Upstream drift | `upstream` remote is configured; rebase `feature/openrouter-provider` on `upstream/main` before starting Phase 1. |

## Definition of done

- `npm run typecheck` and `npm test` pass in `packages/pi-jev`.
- Existing TypeSafe behavior is byte-for-byte unchanged when `OPENROUTER_API_KEY` is unset.
- With only `OPENROUTER_API_KEY` set, `/jev status`, `/jev test`, and
  `pi-jev-gate` all work end-to-end through `https://openrouter.ai/api/v1/systemone`.
- Session token + cost accounting is correct for both providers.
