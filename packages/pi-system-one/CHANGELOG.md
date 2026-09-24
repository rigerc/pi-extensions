# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - Unreleased

### Renamed

- **pi-jev is now pi-system-one.** The package is published as `@rigerc/pi-system-one`, the workspace moved to `packages/pi-system-one`, and the repository, commands, configuration, binaries, agent ID, tools, and internal APIs now use provider-agnostic System One naming.
- Canonical tools are `system_one_find_tools`, `system_one_find_skill`, and `system_one_evaluate`. The former `jev_*` tool names are not registered, preventing duplicate tools from consuming prompt context.

### Migration

- The 0.8 release line accepts legacy `/jev` and `/jev-settings` commands, `PI_JEV_*` variables, `--jev-*` flags, `pi-jev.json` files, `pi-jev-config` session entries, `jev`/`typesafe-jev` agent IDs, and `pi-jev-gate`/`jev-gate` binaries. Canonical inputs win when both names are present; legacy files are read-only fallbacks and all new writes use `pi-system-one` names.
- `/system-one status` reports effective legacy inputs so users can migrate without guessing which compatibility path is still active.

### Added

- **Local Laya provider.** Set `PI_SYSTEM_ONE_PROVIDER=laya` or choose Laya in `/system-one-settings` to use a Jev-compatible server at `http://127.0.0.1:8000`. Keyless loopback operation and optional `LAYA_API_KEY` bearer auth are supported; Laya is explicit-only and never falls back to a hosted provider. Requests use a 48,000-character state cap below Laya's server limit, and status/settings distinguish local no-auth from missing configuration.
- **Bounded widening pass for routing.** Each route now asks one coverage Noul ("does this list cover the task?"); when the answer says no, exactly one more request judges the candidates the lexical shortlist never saw. This removes the recall ceiling the local term-overlap filter imposed on both routers, where a candidate that shared no token with the prompt was unreachable at any confidence.
- **Conversation context for routing judgments.** `recent_context` carries the capped tail (1500 chars) of the previous assistant turn, so abbreviated follow-ups ("do the same for X") are judged with the context they depend on instead of the bare prompt.
- **Deterministic tool-call path check.** Tool-guard verifies path arguments against the filesystem (`fs.existsSync`, resolved against `ctx.cwd`) rather than asking a model whether a path exists. `write` is excluded so creating a file stays valid, and globs/URLs/home-relative values are skipped. Runs with or without a provider, and costs no request.
- **Request-state caps.** `MAX_STATE_CHARS` (60k) and `MAX_STATE_FIELD_CHARS` (12k) bound any state sent to Jev; every cut is marked in place with `…[truncated N chars]` and totals are reported in `/system-one status`, so silent evidence loss is observable.
- **Gate evidence includes untracked files** with `--diff`, plus explicit truncation reporting (`truncated` in the result and `--json` output, and a warning from the CLI).
- Tests for widening (including per-path widening), exclusion, state caps, conversation context, the deterministic path check, and gate truncation.

### Changed

- Tool-guard's `references_missing_path` Noul is gone: existence is not a model judgment. The remaining `invalid_parameters` question now receives the tool's `description` and `parameters` schema, so argument shape is judged against the tool's real contract.
- Tool-guard runs the deterministic check even when Jev is unconfigured, and only asks Jev for what the filesystem cannot answer.
- Gate state is now `{ output, criteria, truncated }`, and the instruction requires answering no when the criteria depend on content that may have been cut. A truncated evaluation is never silently treated as complete evidence.
- `shortlist()` on both routers accepts an exclusion set, so a widening pass adds only candidates an earlier pass did not judge.
- **Auto mode now spends one System One request per prompt instead of two.** Auto tool routing and auto skill routing share a single request: their relevance questions read the same prompt state and the model evaluates questions in parallel, so the second request only added cost. A disabled path still contributes no candidates and no tokens.
- **The widening pass is now per-path.** Auto mode carries `toolSufficient` and `skillSufficient` separately and widens only the path(s) the model judged incomplete, so a tool-only shortfall no longer spends questions on new skills. `AutoRouteResult` gains `widened: { tools, skills }` (`escalated` remains `widened.tools || widened.skills`). `/system-one auto`, `/system-one auto-tools`, `/system-one auto-skills`, and the settings descriptions no longer claim two requests.
- Every relevance question now names its candidate by state path (for example `tools[0]`, `available_skills[2]`, `entries[3]`) instead of interpolating the name into prose, per the Jev guidance to reference specific state fields.
- **Noul criteria are now sent to Jev.** The client previously accepted a Noul `criteria` field and silently dropped it, so yes/no clarifications never reached the model. `instructions` and criteria may now be structured JSON, not just strings.
- `tool_guard` splits its single three-property hallucination question into two independent judgments (`references_missing_path`, `invalid_parameters`) and blocks when either clears the cutoff; the policy stays in code.
- The `error_category` Choice gained an `other` option so an unmatched failure is not forced into a neighbouring category.
- `pi-system-one-gate` evaluates `{ output, criteria }` as structured state instead of embedding the criteria inside the instruction text.
- Jev compaction judges `entries[i]` by path rather than pasting each entry into the instruction, which removes the duplicated payload.

### Fixed

- `pi-jev-gate --diff` no longer reports "No git changes detected" for a change made entirely of new untracked files, which previously let criteria pass against evidence that was never sent.
- Tool-guard and gate criteria can no longer be silently discarded: a bare string Noul criterion is rejected instead of being accepted and dropped.
- **A base URL can no longer leak one provider's key onto the other's host.** A `PI_SYSTEM_ONE_BASE_URL`/settings Base URL naming OpenRouter is ignored for TypeSafe (and vice versa), and a base URL naming a provider now selects that provider in auto-detect instead of having the other provider's key sent to it. An explicit provider choice still wins.
- The cross-provider fallback now honours the layered `model` override (previously it used the fallback provider's default), while still guarding the base URL against a mismatch.
- A string `state` is sent to the API as a plain string; it was previously wrapped as `{ text }`, deviating from the documented `state: string` contract.
- OpenRouter requests now send the current `X-OpenRouter-Title` attribution header instead of the legacy `X-Title`.
- **Auto-model and agent orchestration no longer depend on auto routing.** `before_agent_start` returned early unless auto tool/skill routing was on, so `--system-one-auto-model` and `--system-one-agents` did nothing on their own; each facility is now gated on its own switch.
- **`PI_SYSTEM_ONE_API_KEY` is honoured when a provider is selected through settings.** `SystemOneClient.getConfig()` re-resolved the selected provider without the cross-provider override, so `PI_SYSTEM_ONE_API_KEY` + `PI_SYSTEM_ONE_PROVIDER=openrouter` could report unconfigured. Credential resolution is centralized, and the fallback provider also honours the override.
- **`/system-one test` designs valid Score and Noul questions.** The designer now asks for Score rubrics of at least two levels ordered lowest → highest (index 0 is score 0) and validates that minimum, and it keeps Noul `true`/`false` criteria instead of dropping them.
- **`capState` now guarantees `MAX_STATE_CHARS`.** When no string leaves remained to shrink, the old loop returned an oversized payload unchanged; it now truncates the largest arrays/objects (marking each cut) and throws `state too large after truncation` if the cap still cannot be met. Structurally dropped items are reported separately in `/system-one status`.
- **Score answers expose `distribution` and `legend`.** The calibrated score probabilities and rubric were previously only reachable through `raw`; they now map onto `JevAnswerResult`.
- **`pi-system-one-gate --fail-open` no longer fabricates `probability: 1.0`.** A pass without a model judgment reports `evaluated: false` and `probability: null`, so a policy decision is not mistaken for a model verdict.
- Tool and skill names are now separate namespaces during routing widening, so a tool and a skill that share a name no longer exclude one another; coverage questions moved to a reserved `coverage__` id namespace so no candidate name can overwrite them.

## [0.7.0] - 2026-09-21

### Added

- **`/jev-settings`**: searchable `SettingsList` editor for every mode toggle and provider setting, with live session status, a real test-connectivity action, persist-to-file, and reset-to-defaults. Changes apply immediately.
- **Layered persistent config**: `~/.pi/agent/pi-jev.json` (user) → `<repo>/.pi/pi-jev.json` (project) → `PI_JEV_*` env → `--jev-*` flags → session overrides. `/jev status` reports which layer supplied each value.
- **Session overrides** are stored in the session branch, so TUI edits and `/jev <mode> on|off` survive resuming a session.
- Atomic settings-file writes with a `version` field; malformed values are ignored rather than coerced.
- **Auto routing is split into two independent paths**: auto tool routing and auto skill routing have their own settings, flags (`--jev-auto-tools`, `--jev-auto-skills`), env vars (`PI_JEV_AUTO_TOOLS`, `PI_JEV_AUTO_SKILLS`), commands (`/jev auto-tools`, `/jev auto-skills`), and `/jev-settings` rows. Enabling only one path spends one Jev request per prompt instead of two.

### Changed

- Modes are now driven by the settings layer instead of in-memory booleans that reset every session. `--jev-*` flags are on-only forcing switches; `PI_JEV_*` env vars are read by the env layer.
- `PI_JEV_AUTO`, `--jev-auto`, and `/jev auto` are now **master switches** over both auto-routing paths. A specific setting always beats the master, so `PI_JEV_AUTO=1 PI_JEV_AUTO_SKILLS=0` leaves tool routing on and skill routing off.
- `/jev <mode> on|off` writes a session override rather than only mutating the live object, so the TUI and commands stay in sync.
- `/jev status` shows per-setting provenance and reports the two auto paths separately, e.g. `Auto tool routing: on (session)`.
- Corrected the documented auto-mode cost: the two paths issue separate Jev requests, so both paths on costs up to two per prompt (not one).

### Security

- API keys are never written to config files or session entries. The provider, base URL, and model are editable; the key remains env/secret-store only and is shown read-only with its source.

### Notes

- Activation/compaction thresholds, the tool-guard cutoff, and request-size caps stay code constants by design.

## [0.6.0] - 2026-09-21

### Added

- **OpenRouter provider**: pi-jev now works against TypeSafe-direct or OpenRouter (`https://openrouter.ai/api`, SDK path `/v1/systemone`). Provider selection is automatic: `TYPESAFE_API_KEY` first, then `OPENROUTER_API_KEY` (env or secret file).
- `PI_JEV_PROVIDER` forces `typesafe` or `openrouter`; `PI_JEV_API_KEY`, `PI_JEV_BASE_URL`, and `PI_JEV_MODEL` override both; `PI_JEV_SECRETS_DIR` relocates the secret store.
- One-shot cross-provider fallback: a `401`/`402`/`403`/`404` from the active provider retries once against the other when it is also configured. `/jev status` reports the switch.
- `/jev status` now shows the active provider, API root, model, and session cost.

### Fixed

- **Token accounting**: `stats.totalTokens` never accumulated because the SDK reports `usage.input_tokens`/`usage.output_tokens`, not `totalTokens`. Usage is now normalized across the SDK's snake_case, OpenRouter's `usage.cost`, and legacy camelCase.
- Choice answers now populate `distribution` from the SDK's `probabilities` field (previously only the legacy `distribution` name was read).
- OpenRouter cost is accumulated into session stats when the provider reports it.

## [0.5.0] - 2026-09-20

### Added

- **Tool Guard**: Opt-in tool call validation and anti-hallucination interceptor (`--jev-tool-guard`, `PI_JEV_TOOL_GUARD=1`, `/jev tool-guard [on|off]`). Evaluates tool parameters with Jev System One to block hallucinated paths/flags and enhances error output with targeted recovery hints.

### Fixed

- **Safe Fallback**: When Jev is unreachable or unconfigured, tool router no longer auto-activates tools blindly and reports 0 probability rather than false certainty (1.0). Skill router only surfaces keyword matches with 0 probability (closes #1: "A failed request activates three tools and reports them at probability 1.0").
- Removed outdated reference to nonexistent `/jev login` in `jev_evaluate` error message.
- Documentation clarifies that heuristic routing (`/jev auto-model`, topology fallback) executes locally without spending Jev requests.

## [0.4.0] - 2026-09-18

### Added

- Jev Gate CLI binary (`bin/jev-gate.js`, exposed as `pi-jev-gate` and `jev-gate`) for subagent post-run `gate` checks and CI/CD validation. Evaluates git diff, stdin, or files against acceptance criteria with fast System One noul probability.
- Typed Jev Subagent (`agent: "jev"` / `agentType: "jev"`) handler in `pi-subagents` RPC for sub-second, zero-LLM-overhead choice, score, and probability decisions inside workflows.

### Fixed

- `/jev agents <task>` now directly constructs multi-agent `workflowScript` topologies delegating to builtin agents (`scout`, `worker`, `reviewer`, `researcher`, `evidence-auditor`), replacing single `delegate` subagent calls.

## [0.3.0] - 2026-09-17

### Added

- Opt-in automatic model routing via `--jev-auto-model`, `PI_JEV_AUTO_MODEL=1`, and `/jev auto-model [on|off]`.
- Model profiles for fast, balanced, reasoning, long-context, and vision tasks. Selection respects scoped models and attached images.
- Provider-limit handling: quota, rate-limit, timeout, unavailable, auth, and context-limit errors are classified; retry-prone models are temporarily avoided on later prompts without loops or silent truncation.
- Opt-in Jev-guided `/compact` via `--jev-compact`, `PI_JEV_COMPACT=1`, or `/jev compact on`. Important tool history is retained in a custom compaction summary, with Pi's built-in summary as fail-open fallback.
- Explicit agent orchestration via `/jev agents <task>` and opt-in automatic orchestration via `--jev-agents`, `PI_JEV_AGENTS=1`, or `/jev auto-agents on`, using the installed `pi-subagents` RPC.

## [0.2.1] - 2026-09-17

### Documentation

- Add secret store key resolution option (`~/.pi/agent/secrets/typesafe_api_key`) to Setup section in README.

## [0.2.0] - 2026-09-17

### Added

- Dynamic evaluation command: `/jev test <prompt>` (aliases `/jev eval`, `/jev evaluate`) asks the session's active model to design the Jev question schema from the user's prompt, then runs it on TypeSafe Jev. `/jev test` alone still runs the fixed smoke test.
- Automatic mode: `--jev-auto` flag / `PI_JEV_AUTO=1` env var and `/jev auto [on|off]` command run one Jev routing pass before each prompt, activating tools and surfacing matching skills.

### Changed

- Single activation threshold `JEV_THRESHOLD` (0.65) in `src/skills.ts`, used by the router, both tools, `/jev skills`, and auto mode. `/jev skills` previously used 0.6, so manual skill search could show matches auto mode hid.

### Fixed

- Router no longer offers `pi-jev`'s own tools as routing candidates. After `/jev disable`, automatic routing used to re-activate `jev_find_skill` and `jev_evaluate`.
- `/jev` subcommands now match exactly, so `/jev autofoo on` and `/jev skillsfoo` report an error instead of silently toggling or searching.
- `/jev skills` discloses local heuristic fallback instead of presenting 1.00 probabilities as Jev judgments.
- `/jev status` reports where the API key came from (`$TYPESAFE_API_KEY` vs `~/.pi/agent/secrets/typesafe_api_key`) and counts only genuinely routable tools.
- `/jev help` lists usage at info level instead of warn-as-unknown-command.
- Router and skill fallback tests no longer depend on the machine being unconfigured.
- `npm run smoke` passes `-ne` so it no longer collides with an already-installed `pi-jev` copy.

## [0.1.1] - 2026-09-17

### Added

- `jev_find_skill` tool and `/jev skills [query]` command for semantic skill discovery and recommendation.

## [0.1.0] - 2026-09-17

### Added

- Initial public release of `pi-jev` package for the Pi coding agent.
- `jev_find_tools` tool for semantic candidate shortlisting and additive tool activation.
- `jev_evaluate` tool exposing typed TypeSafe Jev decisions (Choice, Noul, Score).
- `/jev` slash commands (`status`, `enable`, `disable`, `test`).
- Bounded TypeSafe client integration with safe error handling and usage accounting.
- Comprehensive unit test suite and CI workflows.
