# pi-system-one

Provider-agnostic semantic routing and typed System One decisions for the [Pi coding agent](https://pi.dev). Run the Jev model through [TypeSafe](https://typesafe.ai), [OpenRouter](https://openrouter.ai/typesafe), or a custom Jev-compatible endpoint such as a local [Laya](https://github.com/NandhaKishorM/laya) server.

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
- **Typed Judgments (`system_one_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Noul (yes/no probability), and Score primitives.
- **Dynamic Evaluations (`/system-one test <prompt>`)**: The active model designs a typed question schema for a free-form prompt, then the configured System One model evaluates it.
- **Automatic Mode (opt-in)**: auto tool routing and auto skill routing are independent paths with independent switches, so either can be enabled alone. `--system-one-auto` / `PI_SYSTEM_ONE_AUTO=1` / `/system-one auto on` sets both; `--system-one-auto-tools`, `--system-one-auto-skills`, `/system-one auto-tools`, and `/system-one auto-skills` control one path each. Off by default.
- **Automatic Model Mode (opt-in)**: `--system-one-auto-model` / `PI_SYSTEM_ONE_AUTO_MODEL=1` / `/system-one auto-model on` selects fast, balanced, reasoning, long-context, or vision models per prompt. Off by default.
- **Tool Call Guard (opt-in)**: `--system-one-tool-guard` / `PI_SYSTEM_ONE_TOOL_GUARD=1` / `/system-one tool-guard on` intercepts tool calls to detect hallucinations and enhance failed results. Existence is checked deterministically against the filesystem (no model request, works offline, `write` excluded so file creation stays valid); System One then judges argument shape against the tool's own description and schema. Off by default.
- **System One Compaction (opt-in)**: `--system-one-compact` / `PI_SYSTEM_ONE_COMPACT=1` / `/system-one compact on` uses the configured System One model to retain important tool history during `/compact`, while Pi's normal compaction remains the safe fallback.
- **Agent Orchestration & Typed Agent**: `/system-one agents <task>` dispatches `pi-subagents` orchestration; register `agent: "system-one"` in workflows for fast typed judgments without a general-purpose LLM process.
- **Post-Run Gate Check (`system-one-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx pi-system-one-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if the System One backend is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks; the tool-call guard's existence check is deterministic and still applies without a provider.
- **Cost Clarity**: Tool routing (`system_one_find_tools`, auto tool routing), skill discovery (`system_one_find_skill`, auto skill routing), evaluations (`system_one_evaluate`), typed agents (`agent: "system-one"`), and gate checks (`pi-system-one-gate`) each consume a System One request — auto mode asks every enabled routing question in one shared request, so both paths on still costs one request per prompt. A widening pass adds one more request, and only when the model answers that the first shortlist was incomplete. A tool call blocked by the deterministic path check costs nothing. Heuristic fast-paths like `/system-one auto-model` and topology fallback classify locally without spending model requests. Session token usage is tracked for every provider; OpenRouter cost is reported when available, while local Laya has no API charge.

## Installation

```bash
pi install npm:@rigerc/pi-system-one
```

Source: [pi-extensions/packages/pi-system-one](https://github.com/rigerc/pi-extensions/tree/master/packages/pi-system-one).

## Setup

pi-system-one talks to a Jev-compatible System One endpoint. TypeSafe and OpenRouter are
detected automatically from their credentials. Local Laya is selected explicitly so
choosing local execution can never silently route a failed request to the cloud.

| Provider           | API key                               | API root (`baseURL`, SDK appends `/v1/systemone`) |
| ------------------ | ------------------------------------- | ------------------------------------------------- |
| TypeSafe (default) | `TYPESAFE_API_KEY=ts_...`             | `https://api.typesafe.ai`                         |
| OpenRouter         | `OPENROUTER_API_KEY=sk-or-...`        | `https://openrouter.ai/api`                       |
| Laya (local)       | Not required; optional `LAYA_API_KEY` | `http://127.0.0.1:8000`                           |

```bash
export TYPESAFE_API_KEY=ts_...        # TypeSafe-direct
# or
export OPENROUTER_API_KEY=sk-or-...   # OpenRouter (prepaid credits required)
```

Or store a key in Pi's secret store file:

```bash
mkdir -p ~/.pi/agent/secrets
echo "ts_..." > ~/.pi/agent/secrets/typesafe_api_key
# or
echo "sk-or-..." > ~/.pi/agent/secrets/openrouter_api_key
```

### Local Laya

Install Laya's server extra, bind it to loopback, and then explicitly select it in the
Pi process:

```bash
python -m pip install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve

export PI_SYSTEM_ONE_PROVIDER=laya
```

The server process owns checkpoint downloads, device selection, preload policy, logs,
and restarts; pi-system-one only calls its Jev-compatible API. Do not include `/v1` in
`PI_SYSTEM_ONE_BASE_URL` because the SDK appends `/v1/systemone`.

`jev-latest` lets Laya route automatically. Set `PI_SYSTEM_ONE_MODEL=english`,
`multilingual`, or `typed-decisions` to pin a checkpoint. Laya's checkpoints have
smaller effective context windows than hosted Jev, so prefer compact state and test
large routing workloads locally. pi-system-one also keeps Laya state below the server's
50,000-character limit.

Authentication is optional on loopback. To require it, give the server and Pi process
the same token:

```bash
export LAYA_API_KEY="replace-with-a-random-token"
LAYA_HOST=127.0.0.1 laya-serve
export PI_SYSTEM_ONE_PROVIDER=laya
```

You may instead store the Pi-side token in
`~/.pi/agent/secrets/laya_api_key`. Run `/system-one status` and `/system-one test` to verify the
selected endpoint. A Laya failure is surfaced to the caller and never retried against
TypeSafe or OpenRouter.

### Provider configuration

Resolution order, first match wins:

1. `PI_SYSTEM_ONE_API_KEY` (with optional `PI_SYSTEM_ONE_PROVIDER`, `PI_SYSTEM_ONE_BASE_URL`, `PI_SYSTEM_ONE_MODEL`)
2. `PI_SYSTEM_ONE_PROVIDER=typesafe|openrouter|laya` — forces that provider; Laya may be keyless
3. Auto-detect: `TYPESAFE_API_KEY`, then `OPENROUTER_API_KEY` (env, then secret file)

| Variable                                      | Purpose                                                  | Default               |
| --------------------------------------------- | -------------------------------------------------------- | --------------------- |
| `PI_SYSTEM_ONE_PROVIDER`                      | Force `typesafe`, `openrouter`, or explicit local `laya` | `auto`                |
| `PI_SYSTEM_ONE_API_KEY`                       | Explicit bearer token, overriding provider-specific keys | —                     |
| `PI_SYSTEM_ONE_BASE_URL`                      | Override the API root (must not include `/v1`)           | per provider          |
| `PI_SYSTEM_ONE_MODEL`                         | Override the Jev model                                   | `jev-latest`          |
| `PI_SYSTEM_ONE_SECRETS_DIR`                   | Directory holding the secret files                       | `~/.pi/agent/secrets` |
| `LAYA_API_KEY`                                | Optional bearer token for a protected Laya server        | —                     |
| `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` | Legacy TypeSafe-only overrides                           | —                     |

`PI_SYSTEM_ONE_BASE_URL` (and the settings Base URL) that names OpenRouter also selects the
OpenRouter provider; a URL naming the other provider is ignored, so one provider's key
is never sent to the other's host. `PI_SYSTEM_ONE_MODEL` applies to the fallback provider too.

If TypeSafe or OpenRouter rejects a request with `401`, `402`, `403`, or `404` and the
other hosted provider has credentials, pi-system-one retries once against it and reports the
switch in `/system-one status`. Laya never participates in fallback in either direction.
Rate limits, timeouts, server errors, and cancellations never trigger a fallback.

**OpenRouter notes**

- The bare model id `jev-latest` is mapped server-side to `~typesafe/jev-latest`;
  pinned ids such as `typesafe/jev-1.13` pass through unchanged.
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

`/system-one-settings` opens a searchable editor for every mode and provider setting. Changes apply
immediately to the running session.

```text
/system-one-settings

  Modes · Auto tool routing     off
  Modes · Auto skill routing    off
  Modes · Auto-model            off
  Modes · Agent orchestration   off
  Modes · Tool guard            off
  Modes · System One compaction off
  Modes · System One tools      off
  Provider · Provider           auto
  Provider · Base URL           (provider default)
  Provider · Model              jev-latest
  Provider · API key            ••••••••  (read-only)
  Status · Session              live counters + provenance
  Actions · Test connectivity   one real request
  Actions · Persist to file     user / project / both
  Actions · Reset to defaults   clear overrides
```

### Layers

Settings resolve lowest → highest. `/system-one status` and the **Status · Session** row show which
layer supplied each value.

| Layer   | Source                                                                  |
| ------- | ----------------------------------------------------------------------- |
| default | built into the extension (`jev-latest`, provider `auto`, all modes off) |
| user    | `~/.pi/agent/pi-system-one.json`                                        |
| project | `<repo>/.pi/pi-system-one.json`                                         |
| env     | `PI_SYSTEM_ONE_*` variables                                             |
| flag    | `--system-one-*` CLI flags (on-only)                                    |
| session | edits from `/system-one-settings` and `/system-one <mode> on\|off`      |

A session override always wins, including over an env var, and is stored in the session
branch so it survives resuming that session.

### Persisting changes

Edits are **session-scoped by default** — they disappear in a new session. Use
**Actions · Persist to file** to write the current overrides to the user file, the project
file, or both:

```jsonc
// ~/.pi/agent/pi-system-one.json
{
  "version": 1,
  "provider": "openrouter",
  "model": "jev-latest",
  "autoRouting": false,
  "toolGuard": false,
}
```

**API keys are never written to these files or to session entries.** The provider is
editable, but a key always comes from `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`,
`LAYA_API_KEY`, or `~/.pi/agent/secrets/`. The **Provider · API key** row is read-only
and shows the source (for example `$OPENROUTER_API_KEY`), or “not required” for a
keyless local Laya endpoint.

Malformed values in a settings file are ignored rather than coerced, so a typo cannot
silently change behaviour. Writes are atomic (temp file + rename).

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
- skips slash commands, empty prompts, and prompts while System One is unconfigured or already evaluating;
- never throws — a backend failure leaves the turn untouched, and a failed widening pass keeps
  the first pass's verdicts.

`SYSTEM_ONE_THRESHOLD` (in `src/skills.ts`) is the one act/reject cutoff: raise it for precision, lower it for recall. Every path — tool router, skill router, `system_one_find_tools`, `system_one_find_skill`, `/system-one skills`, both auto paths — reads that same constant.

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

### System One Compaction

`/system-one compact on` enables System One-guided compaction. Tool-history entries are evaluated for retention; important paths, errors, constraints, and results stay in the custom summary. User and assistant intent is not rewritten. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when the backend is unconfigured, fails, or returns unusable data. It does not silently truncate context.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to choose the best available model. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Models that hit quota, rate-limit, timeout, or context-limit errors are temporarily avoided on later prompts; fallback is bounded and never loops. Provider failures do not silently truncate user context.

Auto-model and agent orchestration are independent opt-in modes. Either runs on its own,
without enabling auto tool or skill routing; only the auto routing pass is gated on the
routing switches.

## Commands

- `/system-one-settings` — Opens the interactive settings editor (modes, provider, live status, test/persist/reset actions).
- `/system-one status` — Shows System One configuration (active provider, API root, model, authentication mode, and key source when present, together with which config layer supplied it), any hosted-provider fallback, auto-mode state, session request count, total tokens, session cost, truncated-state counts, and available tool counts.
- `/system-one help` — Lists available subcommands.
- `/system-one skills [query]` — Discover and rank matching skills in the workspace using System One.
- `/system-one test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs typed questions for that prompt and the configured System One model evaluates them. Designed Noul questions may carry `true`/`false` descriptions, and Score rubrics need at least two levels ordered lowest → highest (index 0 is score 0), matching the SDK. Also accepts `/system-one eval` and `/system-one evaluate`.
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

## Tools Provided

### 1. `system_one_find_tools`

Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

```json
{
  "query": "inspect SQLite database schemas and run queries"
}
```

If System One answers that the local shortlist missed a capability, one widening pass judges the
remaining inactive tools and the result reports the expansion.

### 2. `system_one_find_skill`

Used by the agent to find relevant specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React"
}
```

Recommendations are thresholded, ranked, and returned as `/skill:<name>` with the judged
probability, so a skill the local term-overlap shortlist dropped can still surface (the
result marks that case as expanded).

### 3. `system_one_evaluate`

Used for structured decisions, classifications, triage, and scoring.

```json
{
  "state": { "diff": "..." },
  "questions": {
    "is_breaking": {
      "type": "noul",
      "instructions": "Does this change introduce any breaking API changes?"
    }
  }
}
```

## Upgrading from pi-jev

Version 0.8 renames the package and its public surface to describe the extension rather
than one provider or model. Install `@rigerc/pi-system-one`, then adopt the canonical
names below. Compatibility aliases remain available throughout the 0.8 release line.

| pi-jev name                               | Canonical pi-system-one name            |
| ----------------------------------------- | --------------------------------------- |
| `/jev`, `/jev-settings`                   | `/system-one`, `/system-one-settings`   |
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
