# pi-system-one

Semantic routing and typed System One decisions for the [Pi coding agent](https://pi.dev), running on pi's classifier API. Any classifier pi can reach answers the questions: the Jev models on [TypeSafe](https://typesafe.ai), [OpenRouter](https://openrouter.ai/typesafe), Cloudflare Workers AI, Vercel AI Gateway and OpenCode, plus every model you load on a local [llama.cpp](https://github.com/ggml-org/llama.cpp) router.

Requires **pi 0.99 or newer** and **Node 22.19 or newer**. Earlier pi releases have no classifier API, and this package will not fall back to one.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Setup](#setup)
- [Settings and persistence](#settings--persistence)
- [Automatic mode](#automatic-mode)
- [Commands](#commands)
- [Tools provided](#tools-provided)
- [Upgrading from pi-jev](#upgrading-from-pi-jev)
- [Development and testing](#development--testing)

## Features

- **Semantic Tool Router (`system_one_find_tools`)**: Automatically searches registered inactive tools and additively activates only the tools needed for the user's specific prompt or workflow. When the local shortlist is judged incomplete, one bounded widening pass searches the tools it never saw.
- **Skill Discovery (`system_one_find_skill`)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context. Routing questions also receive the tail of the previous turn, so an abbreviated follow-up is judged with the context it depends on.
- **Typed Judgments (`system_one_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Bool (yes/no probability), and Score primitives.
- **Dynamic Evaluations (`/system-one test <prompt>`)**: The active model designs a typed question schema for a free-form prompt, then the configured System One model evaluates it.
- **Automatic Mode (opt-in)**: auto tool routing and auto skill routing are independent paths with independent switches, so either can be enabled alone. `--system-one-auto` / `PI_SYSTEM_ONE_AUTO=1` / `/system-one auto on` sets both; `--system-one-auto-tools`, `--system-one-auto-skills`, `/system-one auto-tools`, and `/system-one auto-skills` control one path each. Off by default.
- **Automatic Model Mode (opt-in)**: `--system-one-auto-model` / `PI_SYSTEM_ONE_AUTO_MODEL=1` / `/system-one auto-model on` selects fast, balanced, reasoning, long-context, or vision models per prompt. Off by default.
- **Tool Call Guard (opt-in)**: `--system-one-tool-guard` / `PI_SYSTEM_ONE_TOOL_GUARD=1` / `/system-one tool-guard on` intercepts tool calls to detect hallucinations and enhance failed results. Existence is checked deterministically against the filesystem (no model request, works offline, `write` excluded so file creation stays valid); System One then judges argument shape against the tool's own description and schema. Off by default.
- **System One Compaction (opt-in)**: `--system-one-compact` / `PI_SYSTEM_ONE_COMPACT=1` / `/system-one compact on` uses the configured System One model to retain important tool history during `/compact`, while Pi's normal compaction remains the safe fallback.
- **Agent Orchestration & Typed Agent**: `/system-one agents <task>` dispatches `pi-subagents` orchestration; register `agent: "system-one"` in workflows for fast typed judgments without a general-purpose LLM process.
- **pi-herdsman Integration (opt-in)**: when pi-herdsman is loaded and agent orchestration is on, `system_one_orchestrate` maps a System One topology judgment onto pi-herdsman `agent_delegate` calls (`implementer`; `scout` + `researcher`; `reviewer`; `generalist`), and `/system-one install-herdsman` writes a `system-one-judge` definition for typed judgments inside managed agents. Requires pi-herdsman and a lead session running inside `herdr`.
- **Post-Run Gate Check (`system-one-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx pi-system-one-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if the System One backend is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks; the tool-call guard's existence check is deterministic and still applies without a provider.
- **Cost Clarity**: Tool routing (`system_one_find_tools`, auto tool routing), skill discovery (`system_one_find_skill`, auto skill routing), evaluations (`system_one_evaluate`), typed agents (`agent: "system-one"`), and gate checks (`pi-system-one-gate`) each consume a System One request — auto mode asks every enabled routing question in one shared request, so both paths on still costs one request per prompt. A widening pass adds one more request, and only when the model answers that the first shortlist was incomplete. A tool call blocked by the deterministic path check costs nothing. Heuristic fast-paths like `/system-one auto-model` and topology fallback classify locally without spending model requests. Token usage and cost come from pi's own accounting, using the catalog price of the classifier that served the request; a local classifier has no per-request charge.

## Installation

```bash
pi install npm:@rigerc/pi-system-one
```

Source: [pi-extensions/packages/pi-system-one](https://github.com/rigerc/pi-extensions/tree/master/packages/pi-system-one).

## Setup

This package makes no requests of its own. It calls `ctx.modelRegistry.classify()`, so pi
resolves the credential, the endpoint, the wire protocol, and the price. **Sign in the
normal way:**

```bash
/login typesafe              # jev-latest, the default
/login openrouter            # typesafe/jev-1.13, ~typesafe/jev-latest
/login cloudflare-workers-ai # needs CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID
/login vercel-ai-gateway     # typesafe-ai/jev
/login opencode              # jev-1.13, jev-1.13-free
```

Each provider also reads its own environment variable (`TYPESAFE_API_KEY`,
`OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, …), which is the better
choice in CI where pi should not write credentials. Either way, pi owns the secret: this
package never reads a key, never stores one, and never prints one.

`/system-one status` reports which classifier is selected, its serving API, and whether its
provider has working credentials.

### Local models with llama.cpp

Every chat model on a llama.cpp router is also a classifier. Start the server in **router
mode** — passing `--model`, `-m`, or `-hf` starts single-model mode and there is no router
to select from:

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Then connect pi and load a model:

```bash
/login llama.cpp             # or: export LLAMA_BASE_URL=http://127.0.0.1:8080
/llama                       # pick a model to load it
```

Keep `--host 127.0.0.1` for a local router. A loaded model appears as a classifier without
any further configuration; pin it with `PI_SYSTEM_ONE_PROVIDER=llama.cpp` and
`PI_SYSTEM_ONE_MODEL=<model-id>` when you want local judgement to be the only path.

Three things about local classification are worth knowing before you tune around them:

- **The state costs twice the context.** pi writes the state into every question's prompt,
  and writes it a second time with the questions in view. The second copy is what makes
  small models more accurate, and it is why this package caps a local request's state at
  half the hosted budget.
- **Local probabilities are overconfident.** The answer is the probability of a single
  next-token label, and pi's docs are explicit that such distributions read higher than
  they deserve. Every number a routing threshold compares is discounted by
  `PROMPT_CLASSIFIER_DISCOUNT` (0.8) before it is compared, and the classifier's own value
  stays available on `raw`. Set `PI_SYSTEM_ONE_TEMPERATURE=2` to soften the distribution at
  the source instead; it changes no answer, only how sharp the probabilities are.
- **Hybrid models need checkpoints.** A model such as Qwen3.5 cannot rewind a partially
  cached prompt. If each question reprocesses the whole state, start the router with
  `--ctx-checkpoints 32 --checkpoint-min-step 0`.

A small local model is also more likely to follow instructions that appear inside the state
it is judging. The prompt tells it to treat the state as data; that is not a guarantee, and
it is a further reason local answers are discounted rather than trusted at face value.

### Choosing a classifier

Resolution order, first match wins:

1. `PI_SYSTEM_ONE_PROVIDER` / `PI_SYSTEM_ONE_MODEL` (or a settings value) — pins one
   classifier exactly.
2. Otherwise, every classifier pi can reach is tried in catalog order until one answers.

A pinned classifier is all-or-nothing. If it is not available the request fails with the
provider and the remedy, rather than being quietly served by a differently priced model.
An unpinned request is resilient: if the first classifier errors, the next one is tried, and
`/system-one status` reports the switch. A cancellation is not a provider fault and stops
the chain instead of spending the alternatives.

| Variable                   | Purpose                                                            | Default      |
| -------------------------- | ------------------------------------------------------------------ | ------------ |
| `PI_SYSTEM_ONE_PROVIDER`   | Pin a provider (`typesafe`, `openrouter`, `llama.cpp`, …)            | `auto`       |
| `PI_SYSTEM_ONE_MODEL`      | Pin a model id, or `provider/model`                                 | `jev-latest` |
| `PI_SYSTEM_ONE_TEMPERATURE`| Label-logit temperature for a local classifier                      | provider default |

`PI_JEV_PROVIDER` and `PI_JEV_MODEL` are still read as legacy aliases, and the canonical
name wins when both are set. `PI_SYSTEM_ONE_BASE_URL`, `PI_SYSTEM_ONE_API_KEY`, and
`PI_SYSTEM_ONE_SECRETS_DIR` no longer do anything: pi resolves the endpoint and the
credential, and a stale `baseURL` in a settings file is dropped on read.

**OpenRouter notes**

- The model ids pi lists are `typesafe/jev-1.13` and `~typesafe/jev-latest`. On a gateway
  an id is not a `provider/model` reference: `typesafe/jev-1.13` is one model id, not a
  request for the `typesafe` provider. Write `openrouter/typesafe/jev-1.13` only when you
  want the provider stated explicitly — the two forms are distinguished by looking the
  value up in the catalog first, not by splitting on the first slash.
- Hosted Jev has a 32K context window, so requests stay bounded (at most 10 tool candidates
  and 6 designed questions).
- OpenRouter billing is prepaid; without credits requests fail with `402`.
- `client.models.list()` is unsupported on OpenRouter and is never called.
- String states are sent as-is (the API accepts a plain string), and requests carry the
  `HTTP-Referer` / `X-OpenRouter-Title` attribution headers.

Then check status inside Pi:

```text
/system-one status
```

## Settings & persistence

`/system-one-settings` opens a tabbed editor. Changes stay in a draft until you save.
**Ctrl+S** writes changed settings to `~/.pi/agent/pi-system-one.json` and applies them
to the running session. **Esc** discards the draft; if you changed anything, it asks
for confirmation first.

```text
/system-one-settings

  [Modes]  Provider  Status  Actions
  → Auto tool routing       off
    Auto skill routing      off
    Tool guard              off

  Draft only · Ctrl+S Save · Esc Discard
```

Use Tab and Shift+Tab to switch tabs. Up/Down moves through rows; Enter or Space changes
a setting (use Enter while a search is active). Type to search the current tab. Each tab
keeps its search and selection when you leave it. Esc returns from a detail view or
editor. The selected setting's description shows its source layer or marks an unsaved
draft value.

| Tab | Contents |
| --- | --- |
| Modes | Routing, model, agents, guard, compaction, and tool access switches |
| Classifier | Provider, Model, and Temperature, plus a read-only auth-status row |
| Status | Live session counters and effective values with source layers |

The **Classifier** tab's provider row lists every classifier pi can reach, grouped by
provider and annotated with the API that serves it. A provider with no working credentials
is still listed, marked unselectable, and carries the remedy — `run /login <provider>`, or
`load a model with /llama` for a local router.

### Layers

Settings resolve lowest → highest. `/system-one status` and the **Status → Session** row show which
layer supplied each value.

| Layer   | Source                                                                  |
| ------- | ----------------------------------------------------------------------- |
| default | built into the extension (`jev-latest`, provider `auto`, all modes off) |
| user    | `~/.pi/agent/pi-system-one.json`                                        |
| project | `<repo>/.pi/pi-system-one.json`                                         |
| env     | `PI_SYSTEM_ONE_*` variables                                             |
| flag    | `--system-one-*` CLI flags (on-only)                                    |
| session | saved edits and `/system-one <mode> on\|off` in the current session       |

After Save, a session override makes the new value effective immediately. Project files,
environment variables, and CLI flags keep their priority over the user file in a **new**
session. The current session's saved override survives resuming that session.

### Saving changes

Saving from the editor always writes the **user file**. It merges only the changed
settings, so unrelated values already in the file remain. A failed write leaves the
draft open and does not apply it. `/system-one <mode> on|off` also saves its change to
the user file immediately. The project file can still supply project-specific values,
but this editor does not write or delete it.

```jsonc
// ~/.pi/agent/pi-system-one.json
{
  "version": 1,
  "provider": "openrouter",
  "model": "jev-latest",
  "autoToolRouting": false,
  "toolGuard": false,
}
```

**API keys are never written to these files or to session entries, because this package
never holds one.** Authentication belongs to pi: `/login <provider>`, or the provider's own
environment variable. The **Classifier → Auth status** row is read-only and reports whether
the selected provider currently has working credentials, and where they came from.

Malformed values in a settings file are ignored rather than coerced, so a typo cannot
silently change behaviour. Writes are atomic (temp file + rename). A `baseURL` left over
from an earlier version is dropped on read, and a stored `provider: "laya"` falls back to
`auto`, so an old config cannot point at a classifier that no longer exists.

### Thresholds and limits

Activation threshold (`0.65`), compaction keep threshold (`0.55`), the tool-guard
hallucination cutoff (`0.85`), and the request-size caps remain code constants — they are
deliberately not editable, to keep the tuned safety/recall balance fixed.

The request caps live with the code that sends state, not in settings:

| Constant                                         | Value       | Where                            | Purpose                                                                          |
| ------------------------------------------------ | ----------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `SYSTEM_ONE_THRESHOLD`                           | `0.65`      | `src/skills.ts`                  | One act/reject cutoff for tools, skills, coverage, and compaction-adjacent paths |
| `TOOL_CANDIDATE_LIMIT` / `SKILL_CANDIDATE_LIMIT` | `10` / `12` | `src/router.ts`, `src/skills.ts` | Candidates per System One request                                                |
| `MAX_STATE_CHARS`                                | `60_000`    | `src/system-one.ts`              | Serialized state budget for every request                                        |
| `MAX_STATE_FIELD_CHARS`                          | `12_000`    | `src/system-one.ts`              | Longest single string field, so one value cannot displace the rest               |
| `MAX_GATE_STATE_CHARS`                           | `48_000`    | `src/gate.ts`                    | Diff / file / stdin evidence sent by `pi-system-one-gate`                        |
| `RECENT_CONTEXT_CHARS`                           | `1_500`     | `src/context.ts`                 | Tail of the previous assistant turn shared with the routers                      |

Every cut is marked in place with `…[truncated N chars]`, so a judge reading the state can
tell that it is partial, and the count of truncated requests is reported in `/system-one status`.

## Automatic Mode

Auto mode has two independent routing paths, sharing one System One request per prompt:

| Path              | What it does                                               | Flag                       | Env                           |
| ----------------- | ---------------------------------------------------------- | -------------------------- | ----------------------------- |
| **Tool routing**  | Activates inactive tools that clear `SYSTEM_ONE_THRESHOLD` | `--system-one-auto-tools`  | `PI_SYSTEM_ONE_AUTO_TOOLS=1`  |
| **Skill routing** | Injects matching skill recommendations into the turn       | `--system-one-auto-skills` | `PI_SYSTEM_ONE_AUTO_SKILLS=1` |

Enable both at once with the master switch:

```bash
pi --system-one-auto            # per-run CLI flag, sets both paths
export PI_SYSTEM_ONE_AUTO=1    # persistent via environment
```

Toggle at runtime:

```text
/system-one auto on|off         # master switch over both paths
/system-one auto-tools on|off   # tool routing only
/system-one auto-skills on|off  # skill routing only
```

Both paths travel in a single System One request, so enabling only one costs less in tokens but
not fewer requests. A specific setting always beats the
master: with `PI_SYSTEM_ONE_AUTO=1` and `PI_SYSTEM_ONE_AUTO_SKILLS=0`, tool routing stays on and skill
routing stays off. Both paths are also independent rows in `/system-one-settings`.

Automatic mode:

- activates inactive tools whose usefulness probability clears `SYSTEM_ONE_THRESHOLD` (0.65);
- injects matching skill recommendations into the turn;
- sends each candidate's prompt, the candidate lists, and the tail of the previous
  assistant turn (`recent_context`), so an abbreviated follow-up still carries its context;
- asks one coverage question per enabled path and, when the answer says the local
  shortlist was incomplete, runs **one** bounded widening pass over the candidates the
  first pass never saw — only for the path(s) judged incomplete, so a tool-only shortfall
  never re-judges skills (a second System One request, only in that case);
- skips slash commands, empty, too-short, and stall prompts, and prompts while System One is unconfigured or already evaluating;
- never throws — a backend failure leaves the turn untouched, and a failed widening pass keeps
  the first pass's verdicts.

Skill routing has its own thresholds in `src/thresholds.ts`, because one cutoff cannot serve
four different decisions. `noneThreshold` (0.4) decides whether anything is suggested at all,
`minWinnerProbability` (0.25) is the floor on the winning option, `runnerUpThreshold` (0.6) and
`maxRunnersUp` (2) bound the alternatives, and `coverageThreshold` (0.5) decides whether a
shortlist was complete. `SYSTEM_ONE_THRESHOLD` (0.65) remains the act/reject cutoff for the
**tool** router only, where a candidate is judged alone and activation is additive. Skill
selection is not a per-candidate cutoff: one primary Choice over the shortlist plus `none`
replaces it, so independent per-candidate answers can no longer inject several skills at once.

### Shortlist ranking (BM25)

The local shortlist is built by BM25 over names and descriptions (`src/retrieval/`), with
word-boundary tokenization and light plural normalization. It is the recall ceiling for both
routers: a candidate it drops cannot be chosen at any confidence, however obvious it is to the
judge. It replaces a term-overlap scorer that counted query terms found as **substrings** with
no inverse document frequency and no length normalisation, so generic English fragments decided
the order (`we` matched inside `po-w-e-red`, `are` inside `softw-are`).

Because ranking costs no model request, it can be measured exhaustively offline:

```bashnpm run eval:shortlist                       # scan installed skills, compare both rankers
npm run eval:shortlist -- --corpus ~/.agents/skills --limit 8
```

Measured on this machine (620 skills, 55 author-written development fixtures, K=12):
`recall@12` 45.5% → **69.1%**, MRR 0.239 → **0.441**, top-1 16.4% → 32.7%. The fixtures are a
development set whose targets were chosen from the same corpus, so the number shows direction,
not absolute quality, and it is not a held-out measurement.

### System One Gate CLI (`pi-system-one-gate` / `system-one-gate`)

Use `pi-system-one-gate` as a post-run gate check for subagents or CI/CD pipelines. It evaluates git diff, file, or stdin against natural language criteria using a System One probability. With `--diff` the state covers tracked changes **and untracked files** (paths plus contents), so a change made of new files is no longer judged as "no changes". Evidence larger than `MAX_GATE_STATE_CHARS` is truncated, the cut is marked in the state, `truncated` is reported in the result and `--json` output, and the judge is told to answer no when the criteria depend on the missing content.

- Exits `0` if evaluation probability meets threshold ($\ge 0.70$ by default).
- Exits `1` if rejected.
- Exits `2` on error (or `0` with `--fail-open`).

With `--fail-open`, a configuration or API error exits `0` **without a model judgment**. The
result reports `evaluated: false` and `probability: null` rather than a fabricated `1.0`,
so a policy decision to continue is never confused with a model verdict that the criteria
passed.

#### Subagent `gate` Example

Set a child subagent's `gate` parameter to run `pi-system-one-gate` immediately upon completion:

```json
{
  "agent": "worker",
  "task": "Refactor auth middleware to use jose",
  "gate": "npx pi-system-one-gate -c 'Middleware strictly refactored without breaking exports and no new any types' -d -p 0.8"
}
```

#### Pipeline / CLI Examples

```bash
# Check git diff against acceptance criteria
npx pi-system-one-gate -c "All exported functions have TypeScript type annotations" --diff

# Check piped test/linter output
npm test 2>&1 | npx pi-system-one-gate -c "Zero test failures and no unhandled promise rejections"

# JSON output with custom threshold
npx pi-system-one-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
```

### Typed System One Subagent (`agent: "system-one"`)

Register fast System One evaluations directly in `pi-subagents` workflows without spawning heavy LLM processes.

#### Workflow Example

```javascript
export const meta = { name: 'triage_workflow', description: 'Classify and route tasks' };

// 1. Fast typed classification with System One
const triage = await agent('Classify incoming issue', {
  agent: 'system-one',
  type: 'choice',
  criteria: {
    bug: 'Bug or regression in existing behavior',
    feature: 'New capability request',
    docs: 'Documentation or comment update',
  },
  state: args.issueBody,
});

// 2. Route dynamically based on System One verdict
if (triage.primaryValue === 'bug') {
  await agent('Fix reported bug and add test', { agent: 'worker', task: args.issueBody });
}
```

### Agent Orchestration

`/system-one agents <task>` uses System One to analyze task requirements and construct specialized multi-agent workflow scripts executed via `pi-subagents`:

- **Implementation tasks**: Staged `scout` (code context) $\rightarrow$ `worker` (changes) $\rightarrow$ `reviewer` (standards & tests).
- **Research tasks**: Parallel `scout` + `researcher` $\rightarrow$ `worker` synthesis.
- **Review / Security tasks**: Parallel `reviewer` + `evidence-auditor`.
- **General tasks**: `worker` $\rightarrow$ `reviewer`.

Execution is asynchronous; completion is reported back into the session. Automatic dispatch is opt-in via `--system-one-agents` / `PI_SYSTEM_ONE_AGENTS=1` or `/system-one auto-agents on`.

### pi-herdsman Integration

`pi-system-one` works with the [`pi-herdsman`](https://github.com/boadij/pi-herdsman) subagent extension in addition to `pi-subagents`. The lead session must run inside `herdr`, and agent orchestration must be on (`/system-one auto-agents on`, `--system-one-agents`, or `PI_SYSTEM_ONE_AGENTS=1`). When pi-herdsman is detected, `system_one_orchestrate` becomes available:

- **Implementation tasks**: one `agent_delegate` to `implementer` (its own definition delegates recon to `scout`).
- **Research tasks**: parallel `agent_delegate` to `scout` and `researcher`.
- **Review tasks**: one `agent_delegate` to `reviewer`.
- **General tasks**: one `agent_delegate` to `generalist`.

The tool accepts `task`, an optional `topology` override, and `dryRun` to return the plan without starting agents. Delegation is asynchronous: `agent_delegate` returns on acceptance and results arrive later as messages, so pi-herdsman has no staged workflow scripts and the lead must not poll.

`/system-one install-herdsman [--model <provider/model>] [--thinking <level>] [--project] [--force]` writes a `system-one-judge` agent definition (global `~/.pi/agent/agents/`, or the project's `.pi/agents/` with `--project`). The definition loads this extension, exposes only `system_one_evaluate`, and instructs the agent to return a typed judgment. Pin `--model` to a cheap classifier model: unlike the `pi-subagents` `agent: "system-one"` handler, a pi-herdsman agent is a Pi session, so each judgment costs a model turn. `--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Managed agents keep their definition's `tools` allowlist: pi-system-one detects the `PI_HERDSMAN_AGENT_DEFINITION` launch environment and does not add or remove tools or write the status footer in those sessions. The settings editor's **Status** tab shows a read-only `pi-herdsman` row with the detection state and whether `system_one_orchestrate` is active.

#### Gate Check with pi-herdsman

Any pi-herdsman definition with `bash` can run the same gate CLI:

```markdown
---
name: gated-implementer
tools: ["read", "bash", "edit", "write"]
---

Implement the assignment, then run `npx pi-system-one-gate -c "<acceptance criteria>" --diff` and
report its verdict with your result.
```

### System One Compaction

`/system-one compact on` enables System One-guided compaction. Tool-history entries are evaluated for retention; important paths, errors, constraints, and results stay in the custom summary. User and assistant intent is not rewritten. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when the backend is unconfigured, fails, or returns unusable data. It does not silently truncate context.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to choose the best available model. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Models that hit quota, rate-limit, timeout, or context-limit errors are temporarily avoided on later prompts; fallback is bounded and never loops. Provider failures do not silently truncate user context.

Auto-model and agent orchestration are independent opt-in modes. Either runs on its own,
without enabling auto tool or skill routing; only the auto routing pass is gated on the
routing switches.

## Commands

- `/system-one-settings` — Opens the tabbed settings editor. Ctrl+S saves changed values to the user file; Esc discards the draft.
- `/system-one status` — Shows the selected classifier as `provider/model`, the provider's display name and the API serving it (`typesafe-system-one`, `llama-cpp-classify`, …), its authentication status, whether the selection came from settings, the environment, or the default, the classifier that answered the last successful request, any fallback on that request, auto-mode state, session request count, tokens, cost, truncated-state counts, and available tool counts. When no classifier is available it says so and names the way to get one.
- `/system-one help` — Lists available subcommands.
- `/system-one skills [query]` — Discover and rank matching skills in the workspace using System One.
- `/system-one test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs typed questions for that prompt and the selected classifier evaluates them. Designed bool questions may carry `true`/`false` descriptions, and Score rubrics need at least two levels ordered lowest → highest (index 0 is score 0). Also accepts `/system-one eval` and `/system-one evaluate`.
- `/system-one enable` — Enables System One tools in the active session (equivalent to **Modes · System One tools** in `/system-one-settings`).
- `/system-one disable` — Disables System One tools for the active session.
- `/system-one auto [on|off]` — Master switch: turns both auto routing paths on or off (no argument flips both).
- `/system-one auto-tools [on|off]` — Auto tool routing only (no argument flips it).
- `/system-one auto-skills [on|off]` — Auto skill routing only (no argument flips it).
- `/system-one auto-model [on|off]` — Turns automatic model selection on or off (no argument flips it).
- `/system-one tool-guard [on|off]` — Turns tool call anti-hallucination validation and error guidance on or off.
- `/system-one compact [on|off]` — Turns System One-guided compaction on or off. Run `/compact` after enabling.
- `/system-one agents <task>` — Dispatches the task to `pi-subagents`, which selects and coordinates available agents.
- `/system-one auto-agents [on|off]` — Enables automatic orchestration for complex architecture, refactoring, security, repository-wide, and migration prompts.
- `/system-one install-herdsman [--model <id>] [--thinking <level>] [--project] [--force]` — Writes a `system-one-judge` pi-herdsman agent definition for typed judgments; refuses to overwrite without `--force`.

## Tools Provided

### 1. `system_one_find_tools`

Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

```json
{
  "query": "inspect SQLite database schemas and run queries"
}
```

If System One answers that the local shortlist missed a capability, one widening pass judges the
remaining inactive tools and the result reports the expansion. Candidates are ranked with BM25
over name, description and prompt snippet before any request is made.

### 2. `system_one_find_skill`

Used by the agent to find relevant specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React"
}
```

Recommendations are thresholded, ranked, and returned as at most one primary `/skill:<name>` plus
`maxRunnersUp` alternatives, each with the judged probability, so a skill the local BM25
shortlist dropped can still surface (the result marks that case as expanded). When the primary
Choice is `none` — or `none` is nearly as likely as the winner — nothing is recommended.

### 3. `system_one_evaluate`

Used for structured decisions, classifications, triage, and scoring.

```json
{
  "state": { "diff": "..." },
  "questions": {
    "is_breaking": {
      "type": "bool",
      "instructions": "Does this change introduce any breaking API changes?"
    }
  }
}
```

`"type"` accepts `choice`, `bool`, and `score`. `"noul"` is still accepted as the old name
for a yes/no question and is converted to `bool` before the request is sent. `instructions`
and each criterion are plain text; a question needs at least 2 choice options (at most 62)
or at least 2 score levels (at most 10), because the answer is chosen by a single label.

### 4. `system_one_orchestrate`

Available only when pi-herdsman is loaded, the session runs inside `herdr`, and agent
orchestration is on. It asks System One for a topology (unless `topology` is given) and
delegates the mapped pi-herdsman definitions.

```json
{
  "task": "investigate why the auth middleware leaks sessions",
  "topology": "research",
  "dryRun": false
}
```

`agent_delegate` returns when an agent accepts the assignment; results arrive later as
messages. `dryRun` returns the plan without starting an agent. When pi-herdsman is not
available the tool returns the install/`herdr` remedy instead of failing silently.

## Upgrading from pi-jev

Version 0.8 renames the package and its public surface to describe the extension rather
than one provider or model. Install `@rigerc/pi-system-one`, then adopt the canonical
names below. The old `/jev` and `/jev-settings` slash commands are no longer registered;
use `/system-one` and `/system-one-settings`.

| pi-jev name                               | Canonical pi-system-one name            |
| ----------------------------------------- | --------------------------------------- |
| `PI_JEV_*`                                | `PI_SYSTEM_ONE_*`                       |
| `--jev-*`                                 | `--system-one-*`                        |
| `pi-jev.json`                             | `pi-system-one.json`                    |
| `pi-jev-config` session entries           | `pi-system-one-config` session entries  |
| `agent: "jev"` or `agent: "typesafe-jev"` | `agent: "system-one"`                   |
| `pi-jev-gate`, `jev-gate`                 | `pi-system-one-gate`, `system-one-gate` |

Canonical environment variables, flags, files, and session entries win when both forms
exist. Legacy settings files and session entries are read for migration, but every new
write uses the canonical name. `/system-one status` reports when an effective value came
from a legacy input.

The three tools are intentionally exposed only under their canonical names:
`system_one_find_tools`, `system_one_find_skill`, and `system_one_evaluate`. Update saved
prompts or workflows that call the former `jev_*` tools directly. Jev model identifiers
such as `jev-latest` and `typesafe/jev-1.13` do not change.

## Development & Testing

```bash
npm install
npm run check
npm run test:pi-system-one
```

## License

MIT © Theophilo Damiao
