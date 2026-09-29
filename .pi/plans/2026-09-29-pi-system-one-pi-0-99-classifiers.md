---
title: "Migrate @rigerc/pi-system-one to Pi 0.99 classifier API"
status: draft
created: "2026-09-29T20:09:56.574Z"
updated: "2026-09-29T20:39:50.630Z"
type: refactor
---

Move `@rigerc/pi-system-one` off `@typesafe-ai/sdk` and onto Pi 0.99's classifier API
(`ctx.modelRegistry.classify()`), with `llama.cpp` replacing the dropped Laya provider.

## Why

Pi 0.99 ships classifiers natively: the `typesafe`, `openrouter`, `cloudflare-workers-ai`,
`vercel-ai-gateway` and `opencode` providers expose Jev models, and every chat model on a
llama.cpp router is also a classifier through the `llama-cpp-classify` API. Extensions call
them with `ctx.modelRegistry.classify()`; Pi resolves credentials, pricing, and the
`/v1/systemone` wire protocol. The package currently re-implements that client by hand
(`src/system-one.ts`, 910 lines) and manages its own API keys, secret files, provider
fallback and health checks.

Reference: <https://pi.dev/docs/latest/llama-cpp#classification>,
<https://pi.dev/docs/latest/models#use-classifier-models>.

## Target API mapping (verified against pi-ai 0.99.1 typings)

| Current (`src/types.ts` + SDK) | Pi 0.99 (`ClassifierQuestion` / `ClassifierAnswer`) |
| --- | --- |
| `instructions: string \| object \| array \| null` | `instructions: string` — **strings only** |
| choice `criteria: Record<string, SystemOneInstruction \| null>` | `Record<string, string>` |
| `noul` `criteria?: { true?, false? }` (optional) | `bool` `criteria: { true: string, false: string }` — **required** |
| `score` `criteria: string[]` | `criteria: string[]` (2–10 levels) |
| `state: SystemOneState` (text \| object \| array \| null) | `state: JsonObject` — **object only** |
| choice answer `{ value, confidence, distribution }` | `{ type:'choice', choice, probabilities, confidence }` |
| score answer `{ value, confidence, distribution, legend }` | `{ type:'score', score, confidence }` — no distribution/legend |
| noul answer `{ value: probability }` | `{ type:'bool', probability }` |
| `normalizeUsage` over SDK usage | `Usage { input, output, cacheRead, cacheWrite, totalTokens, cost: { …, total } }` |
| thrown HTTP errors + `FALLBACK_STATUSES` | `ClassifierResult { stopReason, errorMessage, … }` — **never rejects** |

Call shape: `registry.classify(model, { state, questions }, { signal, temperature })`.
Model lookup: `registry.findOfType('classifier', provider, id)` /
`getModelOfType`, availability: `await registry.getAvailableOfType('classifier')`.
`ModelRegistry` and `ModelRuntime.create()` are both exported from the package root, so the
standalone CLI can build its own registry.

## Decisions taken

- **Laya is dropped**; local classification uses Pi's built-in llama.cpp router
  (`llama-cpp-classify`). Laya health-check UI, `LAYA_*` env, and secret files go away.
- **Catalog-driven provider config**: the package stores a single `provider/model` classifier
  id; auth is Pi's (`/login` or the provider's own env var).
- **Gate CLI keeps working standalone** via `ModelRuntime.create()` + `new ModelRegistry(runtime)`.
- **Single cutover** behind a preserved `SystemOneClassifier` interface — no dual-path flag.

---

## Phase 0 — Dependencies and toolchain

- `packages/pi-system-one/package.json`
  - devDependencies: `@earendil-works/pi-{ai,coding-agent,tui}` `^0.85.0` → `^0.99.1`.
  - peerDependencies: `*` → `">=0.99.0 <1.0.0"` (the package is now unusable on 0.85).
  - remove `"@typesafe-ai/sdk"` from dependencies; `tsx` stays for the test runner unless
    Node's type stripping covers the suite (0.99 dropped `tsx` in favour of it — optional cleanup).
  - `engines.node`: `">=20.0.0"` → `">=22.19.0"` (pi 0.99 requirement).
  - keywords: drop `laya`, add `llama-cpp`; refresh the description.
- Bump TypeScript if pi 0.99's `.d.ts` needs a newer compiler than `^5.7` (0.99 builds with TS 7.0).
- **Verify:** `npm run check` still passes on the untouched sources before any code change.
  If the 0.85→0.99 extension-API surface broke anything, fix it here in isolation; known
  candidates are `SessionBeforeCompactEvent` (`src/compact.ts:1`) and `pi.on` handlers
  (`src/tool-guard.ts:97,115`, `extensions/index.ts:137-191`). The TUI helpers used by
  `src/settings-ui.ts` (`DynamicBorder`, `getSettingsListTheme`, `SettingsList`) all still exist in 0.99.
- `npm run smoke` needs `-e builtin:llama.cpp`: 0.99 makes `--no-extensions` disable built-in
  extensions, which would silently remove the llama.cpp provider the smoke run now depends on.

## Phase 1 — Question and state shapes (`src/types.ts` + builders)

- `QuestionType`: add `'bool'`, keep `'noul'` as an accepted input alias; canonicalize internally
  so the user-facing tool schema (`src/tools.ts:173`, `src/designer.ts:15,56`, `src/agent.ts:17,48`)
  and `SYSTEM_ONE` docs do not break in one release.
- `SystemOneInstruction` → `string`. Add `renderInstruction()` helpers in `src/types.ts` and
  convert the eight structured-instruction call sites, reviewing each for lost meaning:
  `src/compact.ts:71`, `src/escalation.ts:32`, `src/gate.ts:274`, `src/router.ts:61`,
  `src/skills.ts:101,175`, `src/tool-guard.ts:224`.
  The object form existed to name a state path (e.g. `tools[0]`) instead of interpolating values;
  the replacement must say the same thing in prose and the referenced data must already be in `state`.
- `NoulQuestionConfig` → `BoolQuestionConfig` with required `criteria: { true, false }`; supply
  neutral defaults where callers pass none (`src/auto.ts:187,190`, `src/escalation.ts:26`).
- `SystemOneState` → `JsonObject`. Add `wrapState()`: non-object JSON (including the free-form
  `state` accepted by `src/tools.ts:173,209` and `src/agent.ts:117`, and the string state in
  `test/provider.test.ts:705`) becomes `{ state: … }`. `capState()` (`src/system-one.ts:564`) already
  normalises to objects and stays the single place that enforces the character cap.
- Add local validation before any network call, with clear messages:
  choice needs 2–62 options, score needs 2–10 levels, and every label must be a non-empty string.
  `llama-cpp-classify` throws on these (`A choice question needs 2 to 62 options`, score 2–10).

## Phase 2 — Transport swap (`src/system-one.ts`)

- Extract the current class into an interface so callers and test stubs are untouched:
  `interface SystemOneClassifier { evaluate(request, signal?); isConfigured(); getProviderInfo();
  setApiKey(); getKeyOrigin(); getStats(); }`. Keep the class name `SystemOneClient` as the
  concrete registry-backed implementation so the ~14 test files that stub it
  (`as unknown as SystemOneClient`, e.g. `test/auto.test.ts:60`, `test/settings-harness.ts:128`)
  keep compiling after a type-only rename.
- `evaluate()` rewrite:
  1. resolve the classifier model — configured `provider/model` first, then the ordered list from
     `await registry.getAvailableOfType('classifier')`;
  2. `capState()` + `wrapState()`;
  3. `await registry.classify(model, { state, questions }, { signal, temperature })`;
  4. if `stopReason !== 'stop'`, record `stats.lastError = errorMessage` and continue to the next
     candidate; the registry never rejects, so `isProviderFallbackError`/`FALLBACK_STATUSES`
     (`src/system-one.ts:112,`, `:839`) are replaced by candidate iteration;
  5. map answers per the table above; drop `legend` and score `distribution` (nothing consumes
     them — only `src/system-one.ts:897` produced them and no reader exists in `src/` or `scripts/`);
  6. `normalizeUsage()` over `Usage` (`input`→`inputTokens`, `cost.total`→`costUsd`), set
     `stats.model`/`stats.provider` from `result.provider`/`result.model`, and keep the
     `stats.fallback` shape used by `src/commands.ts:125`.
- Attach point: the classifier holds a nullable registry and `attach(registry)`. `evaluate()` before
  attachment throws the existing `describeUnconfigured()`-style error. `extensions/index.ts:25`
  constructs the classifier eagerly (no `ctx` at load time) and attaches in `session_start`
  (`extensions/index.ts:137`, has `ctx`); tool handlers re-attach from their `ctx.modelRegistry`
  (`ExtensionToolContext extends ExtensionContext`, so it is always present).
- Delete in this phase: `TypeSafeClient` import, `LOCAL_SDK_PLACEHOLDER` (`:27`), the `clients`
  map and `getClient()` (`:766`), `SYSTEM_ONE_PROVIDERS` (`:44`), `FALLBACK_STATUSES`,
  `resolveFallbackProvider`, secret-file reading (`:161`), and the whole Laya health surface
  (`LayaHealthResult`, `checkLayaHealth`, `healthStatusListener`, `getLayaEndpoint()` `:748`).

## Phase 3 — Configuration, status and settings UI

- `src/config.ts`: replace the provider field with `classifier: { provider, model }`; the value
  choices come from the live catalog. `PI_SYSTEM_ONE_PROVIDER` / `PI_SYSTEM_ONE_MODEL` remain as
  overrides of the selection; keep the legacy `PI_JEV_*` aliases through the existing
  `readAliasedEnv` pattern and the migration already in `src/config-store.ts:35`.
  Remove the API-key/base-URL/secrets-dir inputs (`src/config.ts:323` comments them as client-only).
- `src/settings-ui.ts`: the provider field becomes a list over
  `await registry.getAvailableOfType('classifier')`, grouped by provider, annotated with
  `registry.getProviderAuthStatus(provider)` so an unauthenticated provider is visibly unselectable.
  Replace `maskedKey()` (`:256`) with an auth-status row.
- Remove every Laya health string from `src/commands.ts` (`:125` area) and the settings UI.
- `/system-one status` reports the selected `provider/model`, its `api` (so `llama-cpp-classify` vs
  `typesafe-system-one` is visible), auth status, and the remedy (`/login <provider>`, or `/llama`
  to load a model) when nothing is available.
- New optional setting: per-request `temperature` (llama.cpp-only in practice; values > 1 soften
  overconfident label probabilities and never change the answer). Surface it in the settings UI and
  document that other APIs ignore it.

## Phase 4 — Standalone gate CLI

- `bin/system-one-gate-runner.ts`: build the registry with
  `const runtime = await ModelRuntime.create({ allowModelNetwork: true })` (defaults to Pi's
  `auth.json`, so `/login` credentials work) → `new ModelRegistry(runtime)` →
  attach to the classifier → run the gate → `runtime.dispose()`.
  Take the runtime factory as an injectable parameter so tests never touch the real `auth.json`.
- `src/gate.ts:229-231`: drop the `new SystemOneClient()` default; require a classifier argument and
  document the error when the process has no available classifier model. Update the help text at
  `:104` for the new `--provider`/`--model` semantics.
- Keep the four `bin` aliases in `package.json` unchanged.

## Phase 5 — llama.cpp-specific behaviour

- **Context cost doubles**: pi renders the state twice per question, so `MAX_STATE_CHARS`
  (`src/system-one.ts`) should be roughly halved when the selected model is `llama-cpp-classify`.
  Make the cap provider-aware and surface truncations in the existing stats
  (`src/commands.ts:125` already prints them).
- **Hybrid models** (Qwen3.5 and friends) cannot rewind a partially cached prompt without context
  checkpoints. Document `--ctx-checkpoints 32 --checkpoint-min-step 0` in the README's
  llama.cpp section.
- **Trust model**: small local models may follow instructions embedded in `state`. Recommend
  stricter default thresholds for `llama-cpp-classify` and say so in the README; `src/thresholds.ts`
  is the place to express it.

## Phase 6 — Tests

- Add `test/fake-registry.ts`: a minimal `ModelRegistry` stand-in exposing
  `findOfType`/`getModelOfType`/`getAvailableOfType`/`classify`/`getProviderAuthStatus`, returning
  canned `ClassifierResult`s.
- `test/provider.test.ts`: drop the `TypeSafeClient` import (`:6`) and the stubbed-transport tests
  (`:705-909`) in favour of registry-driven equivalents; keep the env-isolation harness for the
  surviving `PI_SYSTEM_ONE_*` override tests.
- Delete `test/laya-health.test.ts`; add registry cases for: choice/bool/score answer conversion,
  bool criteria defaults, string-state wrapping, option/level count validation, `temperature`
  passthrough, `stopReason: 'error'` → next-candidate fallback, `usage` normalisation, and the
  "no classifier available" message.
- `test/gate-cli.test.ts`: exercise the `ModelRuntime` bootstrap through the injected factory.
- `test/settings-ui*.test.ts`: update the fake client and add auth-status rows.
- **Verify:** `npm run check` and `npm run test` green; then `npm run smoke` plus a real
  end-to-end run against both a hosted classifier and a local llama.cpp router.

## Phase 7 — Docs and release

- `README.md`: Pi ≥ 0.99 requirement; auth via `/login`; the classifier catalog and how to pick one;
  a llama.cpp setup section (router flags, model layout, `/llama` then `/model`, the
  `--ctx-checkpoints` note, doubled state context); remove the `TYPESAFE_API_KEY`/secrets-file and
  Laya documentation; document `temperature` and the state double-read.
- `SECURITY.md`: keys are no longer read or stored by the package — Pi owns `auth.json`.
- `CHANGELOG.md`: 0.8.0, breaking — SDK removed, Laya removed, config keys changed, `noul` → `bool`.
- `docs/openrouter-system-one/` at the repo root: review or retire if it documents the retired client.

## Risks and open items

Implemented. `npm run check` clean, 296/296 tests, the extension loads under pi 0.99, and the gate CLI was run end-to-end against a real hosted classifier (98% on a passing input, 1% on a failing one, and correct fail-closed behaviour on an unauthenticated pinned provider).

**Where the implementation diverged from the plan, and why:**

1. **The local-model confidence discount went into the answer mapping, not the routers.** Phase 5 named `src/thresholds.ts`, but threading the active classifier's `api` into four routers is a design change, not a constant. `adjustProbability()` now scales the bool probability, the choice confidence, and the per-option probabilities at the single point every decision already passes through, preserving the classifier's own value on `raw`. The other two Phase 5 items landed as planned: half the state budget for `llama-cpp-classify`, and the `--ctx-checkpoints` note in the README.

2. **`baseURL` was removed from the settings schema rather than deprecated, and `provider` became a validated string instead of a closed enum.** The catalog-driven picker can select a provider this package has never heard of (`llama-cpp`), and an enum would have rejected it on save. Acceptance is a slug pattern plus a retired-value list, so a malformed id never reaches the registry.

3. **Two bugs were found by running against a real classifier, not by the suite:**
   - pi's `classify()` is documented as never rejecting, but it *throws* on a pre-flight auth failure. The throw ended the fallback chain instead of marking a candidate failed; it is now caught, except when the caller cancelled.
   - Splitting a model reference on the first `/` is wrong: on OpenRouter, `typesafe/jev-latest` is a *model id*, not a `provider/model` reference, so the request went to the wrong provider and would have billed the wrong account. `resolveModelRef()` now looks the value up as an id in the catalog before reading it as a reference.

4. **`parseModelRef` was added and then removed**, superseded by `resolveModelRef` once the id-versus-reference distinction was understood.

5. **Test doubles were hiding the throw path.** `test/support/registry.ts` converted a throw into an error *result*, so the throw-path tests passed without ever exercising a rejected promise. A `throwOn` option was added so that path is really covered.

The plan's decision list held: Laya dropped, catalog-driven config, a standalone `ModelRuntime` for the CLI, and a single cutover behind the preserved `SystemOneClient` interface.