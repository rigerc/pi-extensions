---
title: "Add local Laya as a first-class pi-jev System One provider"
status: draft
created: "2026-09-24T19:27:25+02:00"
type: feature
---

# Add local Laya as a first-class pi-jev provider

## Goal

Let `packages/pi-jev` use a locally hosted [Laya](https://github.com/NandhaKishorM/laya)
server as an explicit System One backend alongside TypeSafe and OpenRouter.

The v1 integration should:

- expose `laya` in `PI_JEV_PROVIDER` and `/jev-settings`;
- default to `http://127.0.0.1:8000` and Laya's Jev-compatible
  `POST /v1/systemone` endpoint;
- work without an API key when the local server has auth disabled;
- support `LAYA_API_KEY` when the server requires bearer auth;
- retain the existing TypeSafe/OpenRouter resolution and fallback behavior;
- never silently send a request selected for local execution to a cloud provider;
- keep Laya installation, process supervision, checkpoint loading, and device selection
  outside the Node extension.

Working copy: `/mnt/extra-ssd/dev/projects2/pi-extensions/packages/pi-jev`.

## Verified starting point

### pi-jev

- `JevClient` already sends the correct Choice, Score, and Noul wire shapes through
  `@typesafe-ai/sdk@0.6.0`.
- The SDK appends `/v1/systemone` to `baseURL`, requires a non-empty constructor API
  key, and always emits `Authorization: Bearer <key>`.
- Providers are currently the closed union `"typesafe" | "openrouter"` in
  `src/types.ts` and `src/jev.ts`.
- Provider selection is represented in the layered settings registry and settings TUI.
- TypeSafe/OpenRouter can retry each other once for HTTP 401/402/403/404.
- `capState()` currently permits 60,000 serialized characters.
- Baseline on 2026-09-24: `npm run typecheck` passes and all **190 tests pass**.

### Laya

- Installed version: `laya 0.3.20` in `/home/bond/dev/laya/.venv`.
- Server executable: `/home/bond/dev/laya/.venv/bin/laya-serve` (not currently on
  the shell `PATH`).
- Checkpoint files are already cached under
  `/home/bond/.cache/huggingface/hub/models--convaiinnovations--laya`.
- No Laya/Uvicorn service was listening when this plan was written.
- This machine has an RTX 3070 (8 GiB). The existing local benchmark recorded an
  English checkpoint cold call around 3.8 s and warmed calls around 20 ms.
- Laya's server implements `POST /v1/systemone`, returns Jev-compatible answers and
  usage, and exposes `GET /health`.
- The server defaults to `0.0.0.0:8000`; local documentation must override that to
  `127.0.0.1` unless remote access is intentional.
- `LAYA_API_KEY` is optional. When set, the server requires the same bearer token.
- Recognized checkpoint model values are `english`, `multilingual`, and
  `typed-decisions`. Unknown Jev model IDs such as `jev-latest` are intentionally
  treated as “auto-route”, so pi-jev's current model default remains compatible.
- Laya rejects more than 64 questions, more than 50,000 state characters, or a body
  over 2 MiB. Its routed checkpoints also have smaller effective token windows than
  hosted Jev, so quality on large routing states needs explicit regression coverage.

## Decisions

1. **Add a provider, not a new inference adapter.** Laya deliberately implements the
   Jev wire protocol, so `JevClient.evaluate()` and answer normalization stay shared.
2. **Selection is explicit in v1.** `provider: "auto"` continues to detect configured
   cloud credentials only. It does not probe localhost or silently select a running
   process. Users choose `laya` in settings or set `PI_JEV_PROVIDER=laya`.
3. **pi-jev does not spawn Laya.** Python environments, CUDA/CPU choice, model preload,
   logs, restart policy, and checkpoint downloads remain the server operator's job.
   This keeps the npm package portable and avoids orphaned model processes.
4. **No local-to-cloud fallback.** A Laya connection/auth/inference failure is surfaced
   to existing fail-safe callers. TypeSafe and OpenRouter retain their current bounded
   mutual fallback. This preserves the privacy expectation of selecting a local model.
5. **Auth is optional only for Laya.** If neither `PI_JEV_API_KEY` nor `LAYA_API_KEY`
   nor `laya_api_key` exists, Laya is still configured. Internally, client construction
   supplies a private placeholder because the TypeSafe SDK requires a key; the local
   server ignores that header when its auth is disabled. The placeholder is never
   persisted or exposed in status output.
6. **Keep `jev-latest` as the cross-provider default.** Laya interprets it as automatic
   checkpoint routing. Users can pin `english`, `multilingual`, or `typed-decisions`
   with the existing model setting.
7. **Use a Laya-safe state cap.** Requests for Laya are capped at 48,000 serialized
   characters, leaving margin below its 50,000-character server check. Remote providers
   retain the existing 60,000-character cap.

## Configuration contract

| Setting | Laya behavior |
| --- | --- |
| `PI_JEV_PROVIDER=laya` | Explicitly selects the local provider |
| `PI_JEV_BASE_URL` | Optional override; default `http://127.0.0.1:8000`; no `/v1` suffix |
| `PI_JEV_MODEL` | `jev-latest` auto-routes; or pin `english`, `multilingual`, `typed-decisions` |
| `PI_JEV_API_KEY` | Highest-precedence bearer token, unchanged from current behavior |
| `LAYA_API_KEY` | Laya-specific bearer token when the server enables auth |
| `~/.pi/agent/secrets/laya_api_key` | Optional file equivalent to `LAYA_API_KEY` |

`PI_JEV_BASE_URL=http://127.0.0.1:8000` alone will not infer Laya. Requiring
`PI_JEV_PROVIDER=laya` avoids misclassifying local TypeSafe-compatible proxies and makes
the local-only privacy boundary explicit.

## Design

### Provider model and auth

Extend the provider union and registry:

```ts
export type JevProvider = "typesafe" | "openrouter" | "laya";

export interface JevProviderDefinition {
  label: string;
  baseURL: string;
  model: string;
  keyEnv?: string;
  secretFile?: string;
  auth: "required" | "optional";
  // existing legacy TypeSafe override fields remain
}
```

Add:

```ts
laya: {
  label: "Laya (local)",
  baseURL: "http://127.0.0.1:8000",
  model: DEFAULT_MODEL,
  keyEnv: "LAYA_API_KEY",
  secretFile: "laya_api_key",
  auth: "optional",
}
```

Make the resolved key optional and describe auth separately from configuration:

```ts
interface JevProviderConfig {
  provider: JevProvider;
  label: string;
  apiKey?: string;
  baseURL: string;
  model: string;
  keyOrigin: string | null;
  authMode: "none" | "bearer";
}
```

`getClient()` passes `config.apiKey ?? LOCAL_SDK_PLACEHOLDER` to `TypeSafeClient`.
The placeholder is a module-private constant with no credential value. Status/UI uses
`authMode` and `keyOrigin`, never the transport placeholder.

### Resolution and precedence

Preserve current precedence with one Laya-specific branch:

1. `PI_JEV_API_KEY` remains the highest-priority key when present.
2. `PI_JEV_PROVIDER=laya` resolves Laya even when no key exists.
3. A forced Laya provider reads `LAYA_API_KEY`, then `laya_api_key`; absence means
   `authMode: "none"`, not “unconfigured”.
4. `provider: auto` remains TypeSafe-first, then OpenRouter. It never selects Laya.
5. A selected Laya provider accepts the layered base URL/model overrides.
6. `setApiKey()` still provides an in-session bearer token for any provider.

Do not extend `inferProviderFromBaseURL()` to generic loopback URLs. It should continue
to distinguish OpenRouter only; provider identity comes from the explicit Laya choice.

### Fallback policy

Refactor `resolveFallbackProvider()` from “the other member of a two-value union” to an
explicit remote pairing:

```ts
if (primary === "typesafe") return configured("openrouter");
if (primary === "openrouter") return configured("typesafe");
return null; // laya is local-only and never crosses the network implicitly
```

The existing fallback status set and one-retry bound stay unchanged for the remote pair.
Tests must prove both directions: Laya never falls back to cloud, and cloud failures do
not fall back to Laya merely because it is a supported provider.

### Request sizing and response handling

- Add `LAYA_MAX_STATE_CHARS = 48_000`.
- Resolve the primary provider before capping state and call
  `capState(request.state, providerSpecificLimit)`.
- Keep the question builders and response normalization unchanged. Laya already returns
  `choice`, `score`, `noul`, `probabilities`, `legend`, and snake-case usage fields.
- Ignore Laya's extra `routing`, `answer_confidence`, and `action` fields except that they
  remain available through `JevAnswerResult.raw`.
- Continue recording the response's actual `model` (`laya-rl-agent`) after a successful
  request; before the first request, status shows the configured routing value.

### Settings and status UX

- Add `laya` to `PROVIDER_VALUES` so the settings enum cycles
  `auto → typesafe → openrouter → laya`.
- Update the provider description to explain that `auto` covers configured hosted
  providers and Laya is explicit.
- When unauthenticated Laya is selected, show **API key: not required (local endpoint)**,
  not “unset” and not a masked fake key.
- Connectivity failure guidance should say to check that `laya-serve` is running and
  that the Base URL omits `/v1`.
- `/jev status` should report provider `laya`, the endpoint, configured model, auth mode,
  and normal request/token/latency counters. Cost remains `n/a`.

## Files to change

| File | Planned change |
| --- | --- |
| `src/types.ts` | Add `laya` to `JevProvider`; let fallback stats refer to the expanded union |
| `src/jev.ts` | Laya provider definition, optional-auth config, SDK placeholder, explicit remote fallback pairing, Laya state cap, provider-aware messages |
| `src/config.ts` | Add `laya` to settings enum and update provider/base URL/model descriptions |
| `src/settings-ui.ts` | Render optional local auth correctly and add Laya-aware connectivity guidance |
| `src/commands.ts` | Adjust command description/status wording from two hosted providers to System One backends |
| `test/provider.test.ts` | Resolution, auth, transport, cap, and no-cloud-fallback cases |
| `test/config.test.ts` | Provider coercion/registry coverage for `laya` |
| `test/settings-ui.test.ts` | Local auth/status and provider enum rows |
| `test/settings-ui-integration.test.ts` | Cycle to Laya and verify live provider overrides |
| `test/commands.test.ts` | `/jev status` output for unauthenticated local provider |
| `README.md` | Laya setup, launch, selection, model pinning, limits, and troubleshooting |
| `SECURITY.md` | Loopback binding recommendation and warning against unauthenticated LAN exposure |
| `CHANGELOG.md` | Record first-class local Laya backend |
| `package.json` | Mention Laya/local inference in description and keywords |

No change is expected in the router, skill, gate, tool-guard, compactor, or agent call
sites: they all depend on `JevClient` and should inherit the provider transparently.

## Implementation phases

### Phase 1 — Provider and auth core

1. Expand `JevProvider` and `JEV_PROVIDERS`.
2. Make provider credentials optional only when the provider definition permits it.
3. Preserve generic/session key precedence and add `LAYA_API_KEY` plus the secret file.
4. Add the internal SDK placeholder at client construction only.
5. Replace binary fallback selection with the explicit hosted-provider pairing.
6. Apply the 48,000-character cap when Laya is primary.

Verify:

```bash
npm --prefix packages/pi-jev run typecheck
npm --prefix packages/pi-jev test
```

### Phase 2 — Settings and operator feedback

1. Add `laya` to the settings provider enum.
2. Update provider descriptions and Base URL help.
3. Render “not required” for an unauthenticated local server.
4. Make `/jev status`, `/jev-settings`, and connectivity failures Laya-aware.
5. Confirm persisted settings accept `{"provider":"laya"}` without schema migration;
   the settings file version can remain `1` because this only expands an enum.

Verify the focused config, settings, UI, and command suites.

### Phase 3 — Documentation and package metadata

1. Add a Local Laya setup section to the README.
2. Document generic installation and startup:

   ```bash
   python -m pip install "laya[serve]"
   LAYA_HOST=127.0.0.1 LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve
   export PI_JEV_PROVIDER=laya
   ```

3. Document optional auth by setting the same `LAYA_API_KEY` for the server and the
   Pi process.
4. Document checkpoint pinning and the smaller effective context windows.
5. Add SECURITY guidance and update CHANGELOG/package metadata.

### Phase 4 — Full verification and local smoke

Run the complete deterministic gate:

```bash
npm --prefix packages/pi-jev run typecheck
npm --prefix packages/pi-jev test
```

Then perform an opt-in machine-local smoke. Start with only the English checkpoint
preloaded to reduce startup VRAM pressure; Laya can load another routed checkpoint later:

```bash
LAYA_HOST=127.0.0.1 \
LAYA_PORT=8000 \
LAYA_DEVICE=cuda \
LAYA_PRELOAD=1 \
LAYA_MODELS=english \
/home/bond/dev/laya/.venv/bin/laya-serve
```

In a second shell:

```bash
curl --fail http://127.0.0.1:8000/health
PI_JEV_PROVIDER=laya npm --prefix packages/pi-jev run smoke  # extension-load check only
```

Inside Pi, run `/jev status`, `/jev test`, and one `jev_evaluate` request containing a
Choice, Score, and Noul. Confirm:

- the provider is `laya` and the base URL is loopback;
- the API key row says “not required” when auth is disabled;
- the response model is `laya-rl-agent` and usage tokens accumulate;
- no OpenRouter/TypeSafe credential is required or transmitted;
- stopping Laya produces a clear local endpoint error without a cloud retry.

Repeat once with `LAYA_API_KEY` enabled to cover bearer auth. This live smoke remains
opt-in and must not become a CI dependency on Python, a GPU, model weights, or localhost.

## Test inventory

Add or extend cases for:

- parsing/coercing `laya` while still rejecting unknown providers;
- forced Laya resolution with no API keys;
- default Laya base URL has no `/v1` suffix;
- `PI_JEV_BASE_URL` and `PI_JEV_MODEL` override Laya defaults;
- `PI_JEV_API_KEY` outranks `LAYA_API_KEY`, which outranks `laya_api_key`;
- no-auth Laya constructs the SDK client with the private placeholder but never exposes it;
- authenticated Laya sends the configured bearer value;
- `provider: auto` never selects Laya;
- Laya never falls back to TypeSafe/OpenRouter on 401, 404, connection failure, or 5xx;
- the hosted pair still falls back exactly as before and never chooses Laya;
- Laya requests are capped below 50,000 state characters and marked when truncated;
- Choice/Score/Noul response decoding remains identical with a Laya-shaped fixture;
- settings persistence round-trips `provider: "laya"`;
- the real settings list can cycle to Laya and immediately updates `JevClient`;
- local no-auth status is not presented as missing configuration;
- all existing 190 tests remain green.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| SDK refuses a missing key | Supply a private placeholder only at `TypeSafeClient` construction; never persist or display it |
| Selecting local unexpectedly sends data to cloud | Laya has no fallback; `auto` never selects it; explicit provider is required |
| Remote credentials leak to localhost or another custom endpoint | Laya uses only generic/Laya-specific credentials; do not borrow TypeSafe/OpenRouter keys |
| Laya is exposed on the LAN without auth | Docs use `LAYA_HOST=127.0.0.1`; SECURITY warns that non-loopback binding should use `LAYA_API_KEY` and network controls |
| First request times out while loading weights | Recommend preload and health-check before Pi; keep process management external |
| Preloading all checkpoints exhausts VRAM | Document `LAYA_MODELS` and CPU fallback; local smoke preloads only `english` |
| Smaller Laya context changes router quality | Apply provider-specific size cap, document checkpoint windows, and compare representative tool/skill routing fixtures before release |
| Laya server's 50k check differs from JSON serialization | Use a conservative 48k cap and an end-to-end oversized-state smoke |
| Expanding a two-provider union breaks fallback assumptions | Replace ternary “other provider” logic with explicit remote pairing and exhaustive tests |

## Definition of done

- `laya` is selectable through env, persisted settings, and `/jev-settings`.
- It works at `http://127.0.0.1:8000/v1/systemone` without a user-supplied key.
- Optional `LAYA_API_KEY` authentication works without storing secrets in settings/session data.
- TypeSafe and OpenRouter resolution, auth, and mutual fallback remain unchanged.
- Laya failures never cause an implicit cloud request.
- Status and connectivity UI distinguish “local/no auth” from “unconfigured”.
- Laya requests stay below the server's state limit and existing truncation observability remains intact.
- Typecheck and the full unit/integration suite pass.
- The installed Laya 0.3.20 service passes the manual health, `/jev test`, and typed-evaluation smoke on this machine.

## Sources

- Laya repository and self-hosting contract: <https://github.com/NandhaKishorM/laya>
- Laya installed server implementation:
  `/home/bond/dev/laya/.venv/lib/python3.13/site-packages/laya/serve.py`
- TypeSafe JavaScript SDK API: <https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient>
