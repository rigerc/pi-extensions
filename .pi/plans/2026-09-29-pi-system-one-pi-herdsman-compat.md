---
title: "Add pi-herdsman compatibility to pi-system-one"
status: draft
created: "2026-09-29T22:11:47.967Z"
type: feature
---

# Add pi-herdsman compatibility to pi-system-one

## Goal

Make `@rigerc/pi-system-one` work with the `pi-herdsman` subagent extension, alongside the
existing `pi-subagents` orchestration (which stays untouched). Compatibility is **additive
and model-invoked**: a new `system_one_orchestrate` tool lets the lead model turn a System
One topology judgment into pi-herdsman `agent_delegate` calls, plus a shipped
`system-one-judge` agent definition for typed judgments inside managed agents.

## Verified context (do not re-research)

- pi-herdsman `0.18.0` at `~/.pi/agent/npm/node_modules/pi-herdsman`; `herdr` is installed
  at `/home/bond/.local/bin/herdr`.
- pi-herdsman tools (`agent_delegate`, `agent_continue`, `agent_list`, `ask_owner`, …) are
  registered without explicit `exposure`, so they default to `direct` — "declared to the
  model while active, **and callable while active**" (`pi/docs/extensions.md:156`).
- Pi tool API: `ctx.executeTool(name, args, { signal, onUpdate })` exists **only** in tool
  execute context (`ExtensionToolContext`, `types.d.ts:263-280`). Nested calls run through
  the same validation and `tool_call`/`tool_result` hooks, carry `parentToolCallId`, and
  never reject for tool failures (`isError: true` instead). `ctx.tools` lists callable tools.
- `before_agent_start` and command handlers cannot call `executeTool` — auto-dispatch to
  pi-herdsman is therefore out of scope for v1.
- pi-herdsman agent definitions (Markdown + YAML frontmatter, schema at
  `pi-herdsman/docs/reference/agent-definition-schema.md`): sources `dist/agent-definitions/`
  (bundled) `< project .pi/agents/ < ~/.pi/agent/agents/`; fields include `model`,
  `thinking`, `tools`, `extensions`, `skills`, `agents`, `noSkills`, `noBuiltinTools`;
  unknown fields fail validation. Bundled definitions: `scout`, `implementer`,
  `researcher`, `reviewer`, `generalist`; `implementer` already has `agents: ["scout"]`.
- pi-herdsman appends `<active_agent name="<definition>"/>` interoperability metadata to a
  managed agent's system prompt; `ExtensionContext.getSystemPrompt()` is available in
  `session_start`.
- pi-herdsman has **no** `pi.events` RPC and no exported programmatic delegate API; its
  `tool_call` hook does not block nested calls (only Chief-mode restrictions and managed
  bash timeouts).
- Existing pi-system-one pieces to reuse: `determineTopology()` / `classifyTopologyFallback()`
  (`src/orchestrator.ts:17,33`), `registerSystemOneTools()` (`src/tools.ts:29`),
  `SYSTEM_ONE_TOOL_NAMES` (`src/types.ts:15`), `SettingsService.apply()` (`src/settings.ts:216`).

## Design decisions

1. **Additive, not a port.** Keep the pi-subagents event-bus path (`src/orchestrator.ts`)
   exactly as is. pi-herdsman support is a new, independently gated capability.
2. **One new tool, model-invoked.** `system_one_orchestrate` is registered with default
   `direct` exposure and dispatches through `ctx.executeTool('agent_delegate', …)`. It is
   active only when: not a managed agent, `agentOrchestration` is on, and pi-herdsman is
   detected.
3. **Topology → definition mapping** (no `workflowScript` equivalent exists):

   | Topology (System One) | pi-herdsman action |
   |---|---|
   | `implementation` | one `agent_delegate` to `implementer` (nested `scout` comes from its own `agents` list) |
   | `research` | parallel `agent_delegate` to `scout` + `researcher` |
   | `review` | one `agent_delegate` to `reviewer` |
   | `general` | one `agent_delegate` to `generalist` |
   | low confidence / unconfigured | existing local `classifyTopologyFallback()` result |

   `agent_delegate` returns on acceptance; results arrive asynchronously. No staging or
   chaining is possible from one tool call, and the tool must say so in its output.
4. **Managed-agent sessions never fight the definition's tool allowlist.** pi-herdsman
   passes `tools` as Pi's name allowlist; `SettingsService.apply()` currently deletes all
   `SYSTEM_ONE_TOOL_NAMES` unless `systemOneTools` is true, which would strip an explicit
   grant. In a detected managed-agent session, skip tool grant management entirely.
5. **Typed judgments become a definition, not a zero-LLM agent.** Ship
   `system-one-judge.md` (loads this extension, `tools: ["system_one_evaluate"]`) and an
   installer command. This costs a model turn — document that it is *not* the pi-subagents
   RPC handler, which cannot be ported.
6. **Out of scope (documented):** automatic dispatch from `before_agent_start`, staged
   `workflowScript` pipelines, the zero-LLM `agent: "system-one"` handler, and any pi-herdsman
   runtime work (herdr install/launch stays the user's responsibility).

## Phase 1: Herdsman adapter module

New `src/herdsman.ts` (pure logic, no Pi side effects — unit-testable):

- `isHerdsmanAvailable(pi)`: `pi.getAllTools().some(t => t.name === 'agent_delegate')`.
- `isManagedHerdsmanAgent(ctx)`: `ctx.getSystemPrompt?.().includes('<active_agent ')` **and**
  active tools include `ask_owner` (both signals, to avoid false positives).
- `HERDSMAN_DEFINITIONS` + `mapTopologyToPlan(topology, task): Array<{ definition: string; task: string }>`
  implementing the table above.
- `HERDSMAN_HINT`: user-facing string when the tool is unavailable
  ("pi-herdsman not detected: install it and run this session inside herdr").

Also export a new `SYSTEM_ONE_GRANTABLE_TOOL_NAMES` (the existing three) from `src/types.ts`
and add `system_one_orchestrate` to `SYSTEM_ONE_TOOL_NAMES` so the router keeps excluding
System One tools; update `settings.ts` to use the grantable list for the `systemOneTools`
toggle. Update affected tests (`test/settings.test.ts`, `test/settings-harness.ts`).

**Verification:** `npm run typecheck`; new `test/herdsman.test.ts` covers detection,
managed-agent detection, mapping, and fallback.

## Phase 2: `system_one_orchestrate` tool

Register in `src/tools.ts` (or a new `src/orchestrate-tool.ts` wired from
`registerSystemOneTools`):

- Parameters: `{ task: string, topology?: 'implementation'|'research'|'review'|'general', dryRun?: boolean }`.
- `execute(_id, params, signal, onUpdate, ctx)`:
  1. Guard `ctx.executeTool` exists and `ctx.tools` contains `agent_delegate`; otherwise
     return an actionable error using `HERDSMAN_HINT`.
  2. Topology = explicit param → System One via `determineTopology(task, client, signal)` →
     fallback classifier.
  3. `dryRun` returns the plan only.
  4. Dispatch via `ctx.executeTool('agent_delegate', { definition, task }, { signal })`;
     use `Promise.all` for the parallel `research` plan. Check `isError` per outcome.
  5. Return `content` summarizing accepted/failed assignments, and `details` with
     `{ topology, plan, outcomes }` for session history.
- `promptSnippet` + `promptGuidelines` naming the tool; guidelines must state that results
  arrive asynchronously and that the lead should not poll.

Activation: in `SettingsService.apply()`, add `system_one_orchestrate` to the active set only
when `!managedAgent && values.agentOrchestration && controllers.agents.herdsmanAvailable`.
Extend `ModeControllers['agents']` with `herdsmanAvailable: boolean` (set by
`extensions/index.ts` before `settings.init(ctx)`).

**Verification:** `test/orchestrate-tool.test.ts` with a fake `ctx.executeTool` asserting:
single call for `implementation`/`review`/`general`, two for `research`, no call when
unavailable, error propagation on `isError`, `dryRun` short-circuit.

## Phase 3: Managed-agent compatibility

- `extensions/index.ts` `session_start`: compute `managedAgent = isManagedHerdsmanAgent(ctx)`
  and `herdsmanAvailable = isHerdsmanAvailable(pi)`; pass both to `SettingsService` (new
  options) and to the orchestrator controller **before** `settings.init(ctx)`.
- `SettingsService.apply()`: when `managedAgent`, skip the System One tool add/remove block
  and skip orchestrate-tool activation, so the definition's `tools` allowlist stays
  authoritative. Also skip the `/system-one` status footer writes in managed agents.
- Do not auto-enable auto-routing, auto-model, tool guard, or compaction in managed agents;
  settings defaults already do this — add a regression test rather than new code.

**Verification:** extend `test/settings.test.ts` (managed-agent flag keeps
`system_one_evaluate` active despite `systemOneTools: false`) and a harness option for the
flag; `test/gating.test.ts`-style unit test for detection.

## Phase 4: `system-one-judge` definition + installer

- Template renderer `buildHerdsmanJudgeDefinition({ model?, extensionPath }): string` in
  `src/herdsman.ts` producing valid schema frontmatter:

  ```markdown
  ---
  name: system-one-judge
  description: Fast typed System One judgments; use for classification, ranking, verification, and scoring
  tools: ["system_one_evaluate"]
  extensions: ["<resolved extension path>"]
  noSkills: true
  noBuiltinTools: true
  inheritProjectContext: false
  inheritGlobalContext: false
  ---
  <body instructing the agent to call system_one_evaluate and return the typed result>
  ```

  `model`/`thinking` lines are emitted only when `--model`/`--thinking` are passed; omitting
  them inherits the spawner (document the cost difference).
- New command `/system-one install-herdsman [--model <id>] [--thinking <level>] [--project] [--force]`:
  writes `~/.pi/agent/agents/system-one-judge.md` by default, `<cwd>/.pi/agents/` with
  `--project`; refuses to overwrite without `--force`; resolves `extensionPath` from
  `import.meta.url` (works for npm-installed and workspace runs); reports the written path.
- Update `src/commands.ts` usage string and `extensions/index.ts` registration.

**Verification:** `test/herdsman.test.ts` snapshots the rendered definition and validates
frontmatter keys against the schema field list; command test with a temp HOME asserts file
path, idempotence, and `--force`.

## Phase 5: Docs, changelog, gate note

- `README.md`: new "pi-herdsman" subsection covering `system_one_orchestrate`, the judge
  definition + install command, the async/no-chaining limitation, the herdr requirement,
  and the existing `pi-system-one-gate` CLI as a post-run check any pi-herdsman definition
  with `bash` can call (include a minimal definition example).
- `CHANGELOG.md`: `## [0.8.0] - Unreleased → ### Added` entries for the tool, the definition
  installer, and managed-agent tool-grant preservation.
- Update `CODE-REVIEW.md` only if a finding is directly contradicted (leave historical items).

## Verification (end-to-end)

1. `npm run typecheck` and `npm test` in `packages/pi-system-one` — all green.
2. Fake-context unit tests prove dispatch, gating, and managed-agent preservation.
3. Manual smoke in herdr: run `herdr`, start pi with pi-herdsman + pi-system-one, ask the
   model to call `system_one_orchestrate` for a research prompt; confirm two managed agents
   appear via `agent_list` and results return asynchronously.
4. Manual managed-agent smoke: `agent_delegate` to `system-one-judge`; confirm
   `system_one_evaluate` is callable inside the managed session (not stripped) and a typed
   answer is returned.
5. Regression: existing pi-subagents orchestration tests (`test/orchestrator.test.ts`) and
   `--system-one-agents` behavior are unchanged.

## Risks / open questions

- **Runtime pin:** pi-herdsman declares `piHerdsman.runtime.pi: 0.87.1`, workspace targets
  `>=0.99`. Confirm in step 3 of end-to-end before promoting the feature.
- **Nested-call acceptance:** proven by inspection only (tool handler takes `ctx`, no
  model-provenance check). If `agent_delegate` rejects nested calls, fall back to injecting a
  `promptGuidelines` instruction telling the lead to call `agent_delegate` directly.
- **`ctx.tools` contents** depend on Pi's exposure rules; if `agent_delegate` is absent,
  fail with `HERDSMAN_HINT` rather than throwing.
- **Cost:** the judge definition is an LLM turn; only the gate CLI keeps zero-LLM semantics.
- **Future pi-herdsman versions** may change tool names/exposure — centralize names in
  `src/herdsman.ts`.

## ⏸️ Checkpoint after Phase 1

Pause for review: confirm detection logic and mapping table before wiring the tool.
