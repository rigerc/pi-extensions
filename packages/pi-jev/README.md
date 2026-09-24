# pi-jev

Semantic tool routing and typed decisions for the [Pi coding agent](https://pi.dev) powered by [TypeSafe](https://typesafe.ai) Jev (System One), served either TypeSafe-direct or through [OpenRouter](https://openrouter.ai/typesafe).

## Features

- **Semantic Tool Router (`jev_find_tools`)**: Automatically searches registered inactive tools and additively activates only the tools needed for the user's specific prompt or workflow. When the local shortlist is judged incomplete, one bounded widening pass searches the tools it never saw.
- **Skill Discovery (`jev_find_skill`)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context. Routing questions also receive the tail of the previous turn, so an abbreviated follow-up is judged with the context it depends on.
- **Typed Judgments (`jev_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Noul (yes/no probability), and Score primitives.
- **Dynamic Evaluations (`/jev test <prompt>`)**: The active model designs the Jev question schema for a free-form prompt, then Jev evaluates it.
- **Automatic Mode (opt-in)**: auto tool routing and auto skill routing are independent paths with independent switches, so either can be enabled alone. `--jev-auto` / `PI_JEV_AUTO=1` / `/jev auto on` sets both; `--jev-auto-tools`, `--jev-auto-skills`, `/jev auto-tools`, and `/jev auto-skills` control one path each. Off by default.
- **Automatic Model Mode (opt-in)**: `--jev-auto-model` / `PI_JEV_AUTO_MODEL=1` / `/jev auto-model on` selects fast, balanced, reasoning, long-context, or vision models per prompt. Off by default.
- **Tool Call Guard (opt-in)**: `--jev-tool-guard` / `PI_JEV_TOOL_GUARD=1` / `/jev tool-guard on` intercepts tool calls to detect hallucinations and enhance failed results. Existence is checked deterministically against the filesystem (no Jev request, works offline, `write` excluded so file creation stays valid); Jev then judges argument shape against the tool's own description and schema. Off by default.
- **Jev Compaction (opt-in)**: `--jev-compact` / `PI_JEV_COMPACT=1` / `/jev compact on` uses Jev to retain important tool history during `/compact`, while Pi's normal compaction remains the safe fallback.
- **Agent Orchestration & Typed Agent**: `/jev agents <task>` dispatches `pi-subagents` orchestration; register `agent: "jev"` in workflows for instant sub-second typed judgments without LLM overhead.
- **Post-Run Gate Check (`jev-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx pi-jev-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if Jev is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks; the tool-call guard's existence check is deterministic and still applies without a provider.
- **Cost Clarity**: Tool routing (`jev_find_tools`, auto tool routing), skill discovery (`jev_find_skill`, auto skill routing), evaluations (`jev_evaluate`), Jev subagents (`agent: "jev"`), and gate checks (`pi-jev-gate`) each consume a Jev System One request — auto mode asks every enabled routing question in one shared request, so both paths on still costs one request per prompt. A widening pass adds one more request, and only when Jev answers that the first shortlist was incomplete. A tool call blocked by the deterministic path check costs nothing. Heuristic fast-paths like `/jev auto-model` and topology fallback classify locally without spending Jev requests. Works against either TypeSafe-direct or OpenRouter (session token usage is tracked for both, and OpenRouter cost is reported when available).

## Installation

```bash
pi install npm:pi-jev
```

Or install directly from GitHub:

```bash
pi install git:github.com/TheoOliveira/pi-jev
```

## Setup

pi-jev talks to a Jev System One endpoint, either TypeSafe-direct or through
[OpenRouter](https://openrouter.ai/typesafe). Set whichever key you have and the
provider is detected automatically.

| Provider | API key | API root (`baseURL`, SDK appends `/v1/systemone`) |
| --- | --- | --- |
| TypeSafe (default) | `TYPESAFE_API_KEY=ts_...` | `https://api.typesafe.ai` |
| OpenRouter | `OPENROUTER_API_KEY=sk-or-...` | `https://openrouter.ai/api` |

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

### Provider configuration

Resolution order, first match wins:

1. `PI_JEV_API_KEY` (with optional `PI_JEV_PROVIDER`, `PI_JEV_BASE_URL`, `PI_JEV_MODEL`)
2. `PI_JEV_PROVIDER=typesafe|openrouter` — forces that provider
3. Auto-detect: `TYPESAFE_API_KEY`, then `OPENROUTER_API_KEY` (env, then secret file)

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_JEV_PROVIDER` | Force `typesafe` or `openrouter` | `auto` |
| `PI_JEV_API_KEY` | Explicit key, overriding both providers | — |
| `PI_JEV_BASE_URL` | Override the API root (must not include `/v1`) | per provider |
| `PI_JEV_MODEL` | Override the Jev model | `jev-latest` |
| `PI_JEV_SECRETS_DIR` | Directory holding the secret files | `~/.pi/agent/secrets` |
| `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` | Legacy TypeSafe-only overrides | — |

`PI_JEV_BASE_URL` (and the settings Base URL) that names OpenRouter also selects the
OpenRouter provider; a URL naming the other provider is ignored, so one provider's key
is never sent to the other's host. `PI_JEV_MODEL` applies to the fallback provider too.

If the active provider rejects a request with `401`, `402`, `403`, or `404` and the
other provider also has credentials, pi-jev retries once against it and reports the
switch in `/jev status`. Rate limits, timeouts, server errors, and cancellations
never trigger a fallback.

**OpenRouter notes**

- The bare model id `jev-latest` is mapped server-side to `~typesafe/jev-latest`;
  pinned ids such as `typesafe/jev-1.13` pass through unchanged.
- Jev has a 32K context window, so requests stay bounded (at most 10 tool candidates
  and 6 designed questions).
- OpenRouter billing is prepaid; without credits requests fail with `402`.
- `client.models.list()` is unsupported on OpenRouter and is never called.
- String states are sent as-is (the API accepts a plain string), and requests carry the
  `HTTP-Referer` / `X-OpenRouter-Title` attribution headers.

Then check status inside Pi:

```text
/jev status
```

## Settings & persistence

`/jev-settings` opens a searchable editor for every mode and provider setting. Changes apply
immediately to the running session.

```text
/jev-settings

  Modes · Auto tool routing     off
  Modes · Auto skill routing    off
  Modes · Auto-model            off
  Modes · Agent orchestration   off
  Modes · Tool guard            off
  Modes · Jev compaction        off
  Modes · Jev tools granted     off
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

Settings resolve lowest → highest. `/jev status` and the **Status · Session** row show which
layer supplied each value.

| Layer | Source |
| --- | --- |
| default | built into the extension (`jev-latest`, provider `auto`, all modes off) |
| user | `~/.pi/agent/pi-jev.json` |
| project | `<repo>/.pi/pi-jev.json` |
| env | `PI_JEV_*` variables |
| flag | `--jev-*` CLI flags (on-only) |
| session | edits from `/jev-settings` and `/jev <mode> on\|off` |

A session override always wins, including over an env var, and is stored in the session
branch so it survives resuming that session.

### Persisting changes

Edits are **session-scoped by default** — they disappear in a new session. Use
**Actions · Persist to file** to write the current overrides to the user file, the project
file, or both:

```jsonc
// ~/.pi/agent/pi-jev.json
{
  "version": 1,
  "provider": "openrouter",
  "model": "jev-latest",
  "autoRouting": false,
  "toolGuard": false
}
```

**API keys are never written to these files or to session entries.** The provider is
editable, but the key always comes from `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, or
`~/.pi/agent/secrets/`. The **Provider · API key** row is read-only and shows the source
(e.g. `$OPENROUTER_API_KEY`).

Malformed values in a settings file are ignored rather than coerced, so a typo cannot
silently change behaviour. Writes are atomic (temp file + rename).

### Thresholds and limits

Activation threshold (`0.65`), compaction keep threshold (`0.55`), the tool-guard
hallucination cutoff (`0.85`), and the request-size caps remain code constants — they are
deliberately not editable, to keep the tuned safety/recall balance fixed.

The request caps live with the code that sends state, not in settings:

| Constant | Value | Where | Purpose |
| --- | --- | --- | --- |
| `JEV_THRESHOLD` | `0.65` | `src/skills.ts` | One act/reject cutoff for tools, skills, coverage, and compaction-adjacent paths |
| `TOOL_CANDIDATE_LIMIT` / `SKILL_CANDIDATE_LIMIT` | `10` / `12` | `src/router.ts`, `src/skills.ts` | Candidates per Jev request |
| `MAX_STATE_CHARS` | `60_000` | `src/jev.ts` | Serialized state budget for every request |
| `MAX_STATE_FIELD_CHARS` | `12_000` | `src/jev.ts` | Longest single string field, so one value cannot displace the rest |
| `MAX_GATE_STATE_CHARS` | `48_000` | `src/gate.ts` | Diff / file / stdin evidence sent by `pi-jev-gate` |
| `RECENT_CONTEXT_CHARS` | `1_500` | `src/context.ts` | Tail of the previous assistant turn shared with the routers |

Every cut is marked in place with `…[truncated N chars]`, so a judge reading the state can
tell that it is partial, and the count of truncated requests is reported in `/jev status`.

## Automatic Mode

Auto mode has two independent routing paths, sharing one Jev request per prompt:

| Path | What it does | Flag | Env |
| --- | --- | --- | --- |
| **Tool routing** | Activates inactive tools that clear `JEV_THRESHOLD` | `--jev-auto-tools` | `PI_JEV_AUTO_TOOLS=1` |
| **Skill routing** | Injects matching skill recommendations into the turn | `--jev-auto-skills` | `PI_JEV_AUTO_SKILLS=1` |

Enable both at once with the master switch:

```bash
pi --jev-auto            # per-run CLI flag, sets both paths
export PI_JEV_AUTO=1    # persistent via environment
```

Toggle at runtime:

```text
/jev auto on|off         # master switch over both paths
/jev auto-tools on|off   # tool routing only
/jev auto-skills on|off  # skill routing only
```

Both paths travel in a single Jev request, so enabling only one costs less in tokens but
not fewer requests. A specific setting always beats the
master: with `PI_JEV_AUTO=1` and `PI_JEV_AUTO_SKILLS=0`, tool routing stays on and skill
routing stays off. Both paths are also independent rows in `/jev-settings`.

Automatic mode:

- activates inactive tools whose usefulness probability clears `JEV_THRESHOLD` (0.65);
- injects matching skill recommendations into the turn;
- sends each candidate's prompt, the candidate lists, and the tail of the previous
  assistant turn (`recent_context`), so an abbreviated follow-up still carries its context;
- asks one coverage question per enabled path and, when the answer says the local
  shortlist was incomplete, runs **one** bounded widening pass over the candidates the
  first pass never saw — only for the path(s) judged incomplete, so a tool-only shortfall
  never re-judges skills (a second Jev request, only in that case);
- skips slash commands, empty prompts, and prompts while Jev is unconfigured or already evaluating;
- never throws — a Jev failure leaves the turn untouched, and a failed widening pass keeps
  the first pass's verdicts.

`JEV_THRESHOLD` (in `src/skills.ts`) is the one act/reject cutoff: raise it for precision, lower it for recall. Every path — tool router, skill router, `jev_find_tools`, `jev_find_skill`, `/jev skills`, both auto paths — reads that same constant.

### Jev Gate CLI (`pi-jev-gate` / `jev-gate`)

Use `pi-jev-gate` as a post-run gate check for subagents or CI/CD pipelines. Evaluates git diff, file, or stdin against natural language criteria using Jev System One probability. With `--diff` the state covers tracked changes **and untracked files** (paths plus contents), so a change made of new files is no longer judged as "no changes". Evidence larger than `MAX_GATE_STATE_CHARS` is truncated, the cut is marked in the state, `truncated` is reported in the result and `--json` output, and the judge is told to answer no when the criteria depend on the missing content.

- Exits `0` if evaluation probability meets threshold ($\ge 0.70$ by default).
- Exits `1` if rejected.
- Exits `2` on error (or `0` with `--fail-open`).

With `--fail-open`, a configuration or API error exits `0` **without a Jev judgment**. The
result reports `evaluated: false` and `probability: null` rather than a fabricated `1.0`,
so a policy decision to continue is never confused with a model verdict that the criteria
passed.

#### Subagent `gate` Example
Set a child subagent's `gate` parameter to run `pi-jev-gate` immediately upon completion:

```json
{
  "agent": "worker",
  "task": "Refactor auth middleware to use jose",
  "gate": "npx pi-jev-gate -c 'Middleware strictly refactored without breaking exports and no new any types' -d -p 0.8"
}
```

#### Pipeline / CLI Examples
```bash
# Check git diff against acceptance criteria
npx pi-jev-gate -c "All exported functions have TypeScript type annotations" --diff

# Check piped test/linter output
npm test 2>&1 | npx pi-jev-gate -c "Zero test failures and no unhandled promise rejections"

# JSON output with custom threshold
npx pi-jev-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
```

### Typed Jev Subagent (`agent: "jev"`)

Register fast System One evaluations directly in `pi-subagents` workflows without spawning heavy LLM processes.

#### Workflow Example
```javascript
export const meta = { name: "triage_workflow", description: "Classify and route tasks" };

// 1. Instant typed classification with Jev
const triage = await agent("Classify incoming issue", {
  agent: "jev",
  type: "choice",
  criteria: {
    bug: "Bug or regression in existing behavior",
    feature: "New capability request",
    docs: "Documentation or comment update"
  },
  state: args.issueBody
});

// 2. Route dynamically based on System One verdict
if (triage.primaryValue === "bug") {
  await agent("Fix reported bug and add test", { agent: "worker", task: args.issueBody });
}
```

### Agent Orchestration

`/jev agents <task>` uses Jev System One to analyze task requirements and construct specialized multi-agent workflow scripts executed via `pi-subagents`:
- **Implementation tasks**: Staged `scout` (code context) $\rightarrow$ `worker` (changes) $\rightarrow$ `reviewer` (standards & tests).
- **Research tasks**: Parallel `scout` + `researcher` $\rightarrow$ `worker` synthesis.
- **Review / Security tasks**: Parallel `reviewer` + `evidence-auditor`.
- **General tasks**: `worker` $\rightarrow$ `reviewer`.

Execution is asynchronous; completion is reported back into the session. Automatic dispatch is opt-in via `--jev-agents` / `PI_JEV_AGENTS=1` or `/jev auto-agents on`.

### Jev Compaction

`/jev compact on` enables Jev-guided compaction. Tool-history entries are evaluated for retention; important paths, errors, constraints, and results stay in the custom summary. User and assistant intent is not rewritten. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when Jev is unconfigured, fails, or returns unusable data. It does not silently truncate context.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to choose the best available model. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Models that hit quota, rate-limit, timeout, or context-limit errors are temporarily avoided on later prompts; fallback is bounded and never loops. Provider failures do not silently truncate user context.

Auto-model and agent orchestration are independent opt-in modes. Either runs on its own,
without enabling auto tool or skill routing; only the auto routing pass is gated on the
routing switches.

## Commands

- `/jev-settings` — Opens the interactive settings editor (modes, provider, live status, test/persist/reset actions).
- `/jev status` — Shows Jev configuration (active provider, API root, model, and where the API key came from together with which config layer supplied it), any cross-provider fallback, auto-mode state, session request count, total tokens, session cost, truncated-state counts, and available tool counts.
- `/jev help` — Lists available subcommands.
- `/jev skills [query]` — Discover and rank matching skills in the workspace using Jev.
- `/jev test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs the Jev questions for that prompt and Jev evaluates them. Designed Noul questions may carry `true`/`false` descriptions, and Score rubrics need at least two levels ordered lowest → highest (index 0 is score 0), matching the SDK. Also accepts `/jev eval` and `/jev evaluate`.
- `/jev enable` — Enables Jev tools in the active session (equivalent to **Modes · Jev tools granted** in `/jev-settings`).
- `/jev disable` — Disables Jev tools for the active session.
- `/jev auto [on|off]` — Master switch: turns both auto routing paths on or off (no argument flips both).
- `/jev auto-tools [on|off]` — Auto tool routing only (no argument flips it).
- `/jev auto-skills [on|off]` — Auto skill routing only (no argument flips it).
- `/jev auto-model [on|off]` — Turns automatic model selection on or off (no argument flips it).
- `/jev tool-guard [on|off]` — Turns tool call anti-hallucination validation and error guidance on or off.
- `/jev compact [on|off]` — Turns Jev-guided compaction on or off. Run `/compact` after enabling.
- `/jev agents <task>` — Dispatches the task to `pi-subagents`, which selects and coordinates available agents.
- `/jev auto-agents [on|off]` — Enables automatic orchestration for complex architecture, refactoring, security, repository-wide, and migration prompts.

## Tools Provided

### 1. `jev_find_tools`
Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

```json
{
  "query": "inspect SQLite database schemas and run queries"
}
```

If Jev answers that the local shortlist missed a capability, one widening pass judges the
remaining inactive tools and the result reports the expansion.

### 2. `jev_find_skill`
Used by the agent to find relevant specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React"
}
```

Recommendations are thresholded, ranked, and returned as `/skill:<name>` with the judged
probability, so a skill the local term-overlap shortlist dropped can still surface (the
result marks that case as expanded).

### 3. `jev_evaluate`
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

## Development & Testing

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © Theophilo Damiao
