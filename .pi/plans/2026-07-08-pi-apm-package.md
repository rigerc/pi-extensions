---
title: "Pi package for managing APM"
status: draft
created: "2026-07-08T18:51:46.095Z"
updated: "2026-07-08T19:08:01.623Z"
type: feature
---

## Goal
Ship Pi package that gives end users UI to manage APM from inside Pi.

## Product promise
Install package, run `/apm`, manage common APM workflows from tabbed TUI backed by real `apm` CLI subprocesses.

Immediate user value:
- discover current APM state without leaving Pi
- install, update, uninstall packages from UI
- run health/status actions from one place
- avoid memorizing `apm` command matrix

V1 out of scope:
- no agent skill as primary surface
- no docs-only wrapper
- no custom APM reimplementation
- no background daemon
- no registry publish flows
- no deep MCP authoring wizard

## Chosen surface
Use **extension-first package** for v1.

Why:
- end-user UI means commands + TUI, not agent guidance
- Pi extensions support custom commands, status updates, confirm dialogs, tabbed custom UI
- existing repo packages `packages/pi-skillshare` and `packages/pi-tick` already show command + panel patterns
- `apm` already exists as source of truth; wrapper should shell out, not clone logic

Package surface:
- `pi.extensions`: `./src/index.ts`
- optional tiny prompt/skill later for help text only, not needed in v1

## V1 scope
Core manage only:
- list installed APM packages / deps state
- install package
- update package(s)
- uninstall package
- show targets / doctor / deps tree summary

Backed by real subprocess calls to `apm` CLI.

Primary UX:
- `/apm` opens tabbed TUI
- one-shot commands for direct actions: `/apm-install`, `/apm-update`, `/apm-uninstall`, `/apm-doctor`

## Source material
Pi docs:
- `/home/bond/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `/home/bond/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/home/bond/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`

Implementation references in repo:
- `packages/pi-skillshare/src/index.ts`
- `packages/pi-skillshare/src/panels.ts`
- `packages/pi-tick/src/index.ts`

APM docs / command mapping:
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/commands.md`
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/workflow.md`
- `docs/context/apm/docs/src/content/docs/guides/operating-installed-context.md`

## Recommended package shape
Target new workspace package `packages/pi-apm`.

Minimal tree:
- `packages/pi-apm/package.json`
- `packages/pi-apm/README.md`
- `packages/pi-apm/LICENSE`
- `packages/pi-apm/src/index.ts`
- `packages/pi-apm/src/panels.ts`
- `packages/pi-apm/src/utils.ts`
- optional `packages/pi-apm/src/types.ts`

Package metadata draft:
- `name`: `@rigerc/pi-apm`
- `keywords`: `pi-package`, `pi-extension`, `apm`
- `pi.extensions`: `./src/index.ts`
- peer deps: Pi runtime packages only if imported

## UX plan
### `/apm` tabbed TUI
Tabs:
1. **Packages**
   - list installed packages
   - install from source string
   - uninstall selected package
   - update selected/all
2. **Status**
   - `apm doctor`
   - `apm targets --json`
   - current cwd / lockfile / manifest presence
3. **Project**
   - project vs global mode only where command supports it
   - `apm deps list` summary
   - optional `apm deps tree` raw output preview

Likely controls:
- arrows/tab switch tabs
- enter confirm action
- `i` install
- `u` update
- `x` uninstall selected
- `r` refresh
- `d` doctor
- `t` targets
- `g` toggle global/project only for supported commands

### Secondary commands
- `/apm` main dashboard
- `/apm-install <source>`
- `/apm-update [source]`
- `/apm-uninstall <source>`
- `/apm-doctor`

## Backend approach
Use thin async subprocess wrapper around real `apm` binary.

Guidelines:
- use `spawn` / async child-process helper with exact argv, not shell strings
- never block TUI render loop with `spawnSync` / `execFileSync` for install/update/uninstall
- capture stdout/stderr separately
- parse JSON only where confirmed supported
- keep text parsing shallow; display raw output when structure is not stable
- no duplicated package-resolution logic

Preliminary command matrix:

| Flow | Command | Structured output | Scope flag | V1 parse strategy |
|---|---|---:|---:|---|
| list deps | `apm deps list` | unknown | `-g` documented | shallow text / raw output |
| targets | `apm targets --json` | yes | project-only | JSON |
| doctor | `apm doctor` | unknown | no | raw output + exit code |
| install | `apm install <pkg>` | no | `-g` documented | raw output + exit code |
| update all | `apm update` | no | `-g` documented | raw output + exit code |
| update one | `apm update <pkg>` | no | `-g` documented | raw output + exit code |
| uninstall | `apm uninstall <pkg>` | no | `-g` documented | raw output + exit code |
| deps tree | `apm deps tree` | no | unknown | raw preview only |

Known corrections:
- use `apm uninstall`, not `apm remove`
- use `apm update` for all deps, `apm update <pkg>` for one dep; do not assume `apm update --all`
- expose global mode only for commands with documented `-g`

Phase 1 must verify matrix against local `apm --help` before scaffold.

## Open decisions
1. **Package name**
   - default: `@rigerc/pi-apm`
   - fallback: `@rigerc/pi-apm-manager`
2. **Install source entry UX**
   - default: `ctx.ui.input()` prompt from tab action
   - fallback: separate `/apm-install` only if in-panel text input costs too much
3. **Text parsing**
   - default: raw output except `targets --json`
   - add parsing only after stable output confirmed

## Implementation phases
### Phase 1: CLI contract map
- read APM command docs / help for exact commands, flags, JSON support
- choose smallest stable command set for core manage
- define normalized result types for package list, doctor, targets, action result
- ⏸️ pause: lock command matrix before coding

### Phase 2: UI contract
- sketch tab model from `pi-skillshare` pattern
- map each user action to one subprocess call
- keep 3 tabs: Packages / Status / Project
- define keybindings and confirm flows
- ⏸️ pause: review for overbuild

### Phase 3: Package scaffold
- add workspace package dir
- add `package.json` with Pi extension manifest
- add `src/index.ts`, `src/panels.ts`, `src/utils.ts`
- add README with honest install story and command list

### Phase 4: Thin subprocess layer
- implement `apm` executable detection
- add async helper to run exact argv
- add supported global/project mode per command
- normalize success/error results
- handle missing CLI with clear UI error

### Phase 5: TUI implementation
- build `/apm` tabbed panel
- build package list + actions
- build status/doctor panel
- add one-shot commands for smoke path and fallback UX

### Phase 6: Validation prep
- repo check: targeted typecheck for new package
- Pi package manifest preflight
- confirm same `pi` binary used for install validation
- confirm `apm` binary presence in validation env

### Phase 7: Install-path validation
- `pi install` into temporary `PI_CODING_AGENT_DIR`
- confirm `pi list` shows package
- smoke one-shot commands: `/apm-doctor`, `/apm-install <fixture>`, `/apm-update`, `/apm-uninstall`
- capture manual TUI proof for `/apm`
- ⏸️ pause: only dogfood after temp install passes

### Phase 8: Dogfood
- run package in this repo against real `apm` workspace or safe fixture
- verify wrapper mirrors CLI outcomes, not stale cached state
- trim UI if any action needs too much parsing or brittle heuristics

## Verification
Required evidence before done:
- package manifest passes path preflight
- targeted typecheck passes
- `pi install <local-path>` succeeds in temp Pi dir
- `pi list` shows package in temp dir
- one-shot command smoke logs succeed against real `apm`
- `/apm` manual TUI proof works for package list + doctor + one mutating action on safe fixture
- README matches exact validated commands

## Risks
- `apm` text output may be unstable where JSON not available; keep parsers minimal
- interactive text entry inside tabbed TUI can bloat v1; fall back to standalone commands if needed
- mutating real project state during validation risky; use temp Pi dir and safe fixture repo

## Simplest viable v1
Extension package with `/apm` tabbed TUI plus `/apm-install`, `/apm-update`, `/apm-uninstall`, `/apm-doctor`. Thin async wrapper over real `apm` subprocess.

## Next step
Plan mode blocks implementation. Exit plan mode, then implement Phase 1 + scaffold.

## Previous Version

## Goal
Ship Pi package that gives end users UI to manage APM from inside Pi.

## Product promise

## Product promise
Install package, run `/apm`, manage common APM workflows from tabbed TUI backed by real `apm` CLI subprocesses.

Immediate user value:
- discover current APM state without leaving Pi
- install, update, uninstall packages from UI
- run health/status actions from one place
- avoid memorizing `apm` command matrix

V1 out of scope:
- no agent skill as primary surface
- no docs-only wrapper
- no custom APM reimplementation
- no background daemon
- no registry publish flows
- no deep MCP authoring wizard

## Chosen surface
Use **extension-first package** for v1.

Why:
- end-user UI means commands + TUI, not agent guidance
- Pi extensions support custom commands, status updates, confirm dialogs, tabbed custom UI
- existing repo packages `packages/pi-skillshare` and `packages/pi-tick` already show command + panel patterns
- `apm` already exists as source of truth; wrapper should shell out, not clone logic

Package surface:
- `pi.extensions`: `./src/index.ts`
- optional tiny prompt/skill later for help text only, not needed in v1

## V1 scope

Core manage only:
- list installed APM packages / deps state
- install package
- update package(s)
- uninstall package
- show targets / doctor / maybe deps tree summary

Backed by real subprocess calls to `apm` CLI.

Primary UX:
- `/apm` opens tabbed TUI
- one-shot commands for direct actions still useful (`/apm-install`, `/apm-update`, `/apm-uninstall`, `/apm-doctor`) but secondary

## Source material
Pi docs:
- `docs/packages.md`
- `docs/extensions.md`
- `docs/tui.md`

Implementation references in repo:
- `packages/pi-skillshare/src/index.ts`
- `packages/pi-skillshare/src/panels.ts`
- `packages/pi-tick/src/index.ts`

APM docs / command mapping:
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/commands.md`
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/workflow.md`
- `docs/context/apm/docs/src/content/docs/guides/operating-installed-context.md`
- `docs/context/apm/docs/src/content/docs/concepts/package-anatomy.md`
- `docs/context/apm/docs/src/content/docs/concepts/primitives-and-targets.md`

## Recommended package shape
Target new workspace package `packages/pi-apm`.

Minimal tree:
- `packages/pi-apm/package.json`
- `packages/pi-apm/README.md`
- `packages/pi-apm/LICENSE`
- `packages/pi-apm/src/index.ts`
- `packages/pi-apm/src/panels.ts`
- `packages/pi-apm/src/utils.ts`
- optional `packages/pi-apm/src/types.ts`

Package metadata draft:
- `name`: `@rigerc/pi-apm`
- `keywords`: `pi-package`, `pi-extension`, `apm`
- `pi.extensions`: `./src/index.ts`
- peer deps: Pi runtime packages only if imported

## UX plan

### `/apm` tabbed TUI
Tabs:
1. **Packages**
   - list installed packages
   - install from source string
   - uninstall selected package
   - update selected/all
2. **Status**
   - `apm doctor`
   - `apm targets --json`
   - current cwd / lockfile / manifest presence
3. **Project**
   - project vs global mode only where command supports it
   - `apm deps list` summary
   - optional `apm deps tree` raw output preview

Likely controls:
- arrows/tab switch tabs
- enter confirm action
- `i` install
- `u` update
- `x` uninstall selected
- `r` refresh
- `d` doctor
- `t` targets
- `g` toggle global/project only for supported commands

### Secondary commands
- `/apm` main dashboard
- `/apm-install <source>`
- `/apm-update [source]`
- `/apm-uninstall <source>`
- `/apm-doctor`

Reason: shorter path for power users, easier smoke tests.

## Backend approach


Use thin async subprocess wrapper around real `apm` binary.

Guidelines:
- use `spawn` / async child-process helper with exact argv, not shell strings
- never block TUI render loop with `spawnSync` / `execFileSync` for install/update/uninstall
- capture stdout/stderr separately
- parse JSON only where confirmed supported
- keep text parsing shallow; display raw output when structure is not stable
- keep wrapper thin: command mapping, result normalization, error formatting
- no duplicated package-resolution logic

Preliminary command matrix:

| Flow | Command | Structured output | Scope flag | V1 parse strategy |
|---|---|---:|---:|---|
| list deps | `apm deps list` | unknown | `-g` documented | shallow text / raw output |
| targets | `apm targets --json` | yes | project-only | JSON |
| doctor | `apm doctor` | unknown | no | raw output + exit code |
| install | `apm install <pkg>` | no | `-g` documented | raw output + exit code |
| update all | `apm update` | no | `-g` documented | raw output + exit code |
| update one | `apm update <pkg>` | no | `-g` documented | raw output + exit code |
| uninstall | `apm uninstall <pkg>` | no | `-g` documented | raw output + exit code |
| deps tree | `apm deps tree` | no | unknown | raw preview only |

Known corrections:
- use `apm uninstall`, not `apm remove`
- use `apm update` for all deps, `apm update <pkg>` for one dep; do not assume `apm update --all`
- expose global mode only for commands with documented `-g`

Phase 1 must verify matrix against local `apm --help` before scaffold.

## Backend approach
Use thin async subprocess wrapper around real `apm` binary.

Guidelines:
- use `spawn` / async child-process helper with exact argv, not shell strings
- never block TUI render loop with `spawnSync` / `execFileSync` for install/update/uninstall
- capture stdout/stderr separately
- parse JSON only where confirmed supported
- keep text parsing shallow; display raw output when structure is not stable
- keep wrapper thin: command mapping, result normalization, error formatting
- no duplicated package-resolution logic

Initial command candidates:
- `apm deps list`
- `apm targets --json`
- `apm doctor`
- `apm install <pkg>`
- `apm update [pkg]`
- `apm uninstall <pkg>`

Known corrections:
- use `apm uninstall`, not `apm remove`
- use `apm update` for all deps, `apm update <pkg>` for one dep; do not assume `apm update --all`
- confirm `-g/--global` support per command before exposing global mode

Phase 1 must produce command matrix before scaffold.

## Open decisions
1. **Package name**
   - default: `@rigerc/pi-apm`
   - fallback: `@rigerc/pi-apm-manager`
2. **Tab set**
   - default: Packages / Status / Project
   - fallback: Packages / Actions / Logs if status parsing gets messy
3. **Install source entry UX**
   - default: `ctx.ui.input()` prompt from tab action
   - fallback: separate `/apm-install` only for v1 if in-panel text input costs too much
4. **JSON vs text parsing**
   - default: use JSON where available, text parser otherwise

## Implementation phases
### Phase 1: CLI contract map
- read APM command docs / help for exact commands, flags, JSON support
- choose smallest stable command set for core manage
- define normalized result types for package list, doctor, targets, action result
- ⏸️ pause: lock command matrix before coding

### Phase 2: UI contract
- sketch tab model from `pi-skillshare` pattern
- map each user action to one subprocess call
- keep no more than 3 tabs in v1
- define keybindings and confirm flows
- ⏸️ pause: review for overbuild

### Phase 3: Package scaffold
- add workspace package dir
- add `package.json` with Pi extension manifest
- add `src/index.ts`, `src/panels.ts`, `src/utils.ts`
- add README with honest install story and command list

### Phase 4: Thin subprocess layer
- implement `apm` executable detection
- add helpers to run commands in project/global mode
- normalize success/error results
- handle missing CLI with clear UI error

### Phase 5: TUI implementation
- build `/apm` tabbed panel
- build package list + actions
- build status/doctor panel
- add one-shot commands for smoke path and fallback UX

### Phase 6: Validation prep
- repo check: targeted typecheck for new package
- Pi package manifest preflight
- confirm same `pi` binary used for install validation
- confirm `apm` binary presence in validation env

### Phase 7: Install-path validation
- `pi install` into temporary `PI_CODING_AGENT_DIR`
- confirm `pi list` shows package
- smoke `/apm` in print/interactive-compatible way as far as Pi supports
- smoke one-shot commands first: `/apm-doctor`, `/apm-install <fixture>`, `/apm-update`, `/apm-remove`
- if full tabbed UI cannot be smoke-tested headless, capture command-path proof plus manual TUI proof notes
- ⏸️ pause: only dogfood after temp install passes

### Phase 8: Dogfood
- run package in this repo against real `apm` workspace or safe fixture
- verify wrapper mirrors CLI outcomes, not stale cached state
- trim UI if any action needs too much parsing or brittle heuristics

## Verification
Required evidence before done:
- package manifest passes path preflight
- targeted typecheck passes
- `pi install <local-path>` succeeds in temp Pi dir
- `pi list` shows package in temp dir
- one-shot command smoke logs succeed against real `apm`
- `/apm` manual TUI proof works for package list + doctor + one mutating action on safe fixture
- README matches exact validated commands

## Risks
- `apm` text output may be unstable where JSON not available; keep parsers minimal
- interactive text entry inside tabbed TUI can bloat v1; fall back to standalone commands if needed
- mutating real project state during validation risky; use temp Pi dir and safe fixture repo

## Simplest viable v1

Extension package with `/apm` tabbed TUI plus `/apm-install`, `/apm-update`, `/apm-uninstall`, `/apm-doctor`. Thin async wrapper over real `apm` subprocess.

## Next step
Map exact `apm` commands/flags/JSON support for core-manage flows, then freeze tab/action matrix.

## Previous Version

## Goal
Ship narrow Pi package that helps users manage APM from inside Pi, grounded in `docs/context/apm/docs/src/content/docs/` and existing APM package assets under `docs/context/apm/packages/apm-guide/`.

## Package promise
One-sentence promise: install package, ask Pi any APM usage / authoring / troubleshooting question, get docs-grounded guidance and concrete `apm` command paths.

Immediate user value:
- explicit Pi skill for APM tasks
- bundled reference files distilled from APM docs

V1 out of scope:
- no shell-executing Pi extension
- no direct `apm` process wrapper or TUI panel
- no auto-sync from upstream docs
- no registry publishing flow beyond local-path / workspace validation
- no agent surface in package manifest

## Chosen surface
Use **skills only** for v1.

Why:
- Pi package docs support `extensions`, `skills`, `prompts`, `themes` in `package.json` `pi` manifest; no documented `agents` key in packages surface
- Pi skill docs already give exact runtime behavior needed: `/skill:name`, on-demand `read` of bundled references, recursive `SKILL.md` discovery
- existing source package `docs/context/apm/packages/apm-guide/` already has strongest value in skill corpus `apm-usage/**`
- shortest path: adapt proven docs-grounded skill, skip extension / agent plumbing

Consequence:
- do not ship `agents/apm-expert.agent.md` in v1 package manifest
- if expert-agent workflow still desired later, add separate extension or future package surface only after Pi docs support path is proven

## Source material
Primary docs corpus:
- `docs/context/apm/docs/src/content/docs/concepts/what-is-apm.md`
- `docs/context/apm/docs/src/content/docs/concepts/primitives-and-targets.md`
- `docs/context/apm/docs/src/content/docs/concepts/package-anatomy.md`
- `docs/context/apm/docs/src/content/docs/guides/operating-installed-context.md`
- `docs/context/apm/docs/src/content/docs/enterprise/apm-policy.md`

Existing reusable package:
- `docs/context/apm/packages/apm-guide/apm.yml`
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/**`

## Recommended package shape
Target new workspace package `packages/pi-apm`.

Minimal tree:
- `packages/pi-apm/package.json`
- `packages/pi-apm/README.md`
- `packages/pi-apm/LICENSE`
- `packages/pi-apm/skills/apm-usage/SKILL.md`
- `packages/pi-apm/skills/apm-usage/{installation,workflow,commands,dependencies,authentication,governance,package-authoring,troubleshooting}.md`

Package metadata draft:
- `name`: `@rigerc/pi-apm`
- `keywords`: include `pi-package`, `apm`
- `pi.skills`: `./skills`
- no `pi.agents` in v1
- tight `files` list only for shipped assets

## Open decisions
1. **Raw port vs Pi-tuned rewrite**
   - default: port existing `apm-guide` corpus, then trim wording for Pi
2. **Package name**
   - default: `@rigerc/pi-apm`
   - fallback: `@rigerc/pi-apm-guide` if scope should signal docs-first package
3. **Docs subset**
   - default: ship current `apm-usage` split plus only highest-value references
   - trim spec-heavy material if package gets noisy or redundant

## Implementation phases
### Phase 1: Lock package boundary
- done: confirmed package surface is skills-only
- finalize shipped docs subset from `apm-usage/**`
- ⏸️ pause: approve package name + subset before scaffold

### Phase 2: Map APM corpus into Pi skill
- reuse `apm-guide` skill structure
- rewrite activation language for Pi user intents
- trim references that assume APM runtime instead of Pi runtime
- keep docs-grounded file split for commands / deps / governance / authoring
- ⏸️ pause: review copied corpus for Pi fit and scope creep

### Phase 3: Package scaffold
- add workspace package dir
- add `package.json` with Pi manifest
- add README with honest install story: local path first, Pi-only, what package does not do
- add LICENSE / CHANGELOG if repo conventions require

### Phase 4: Validation prep
- repo checks: none unless package adds TS extension code
- manifest preflight per Pi package creator validation flow
- locate same `pi` binary used for validation
- confirm install path from Pi docs

### Phase 5: Install-path validation
- install package into temporary `PI_CODING_AGENT_DIR`
- confirm `pi list` shows package
- smoke public surface:
  - explicit `/skill:apm-usage` invocation
  - realistic prompt: ask how to install package, inspect deps, troubleshoot policy block
- ⏸️ pause: only dogfood after temp install passes

### Phase 6: Dogfood in repo
- run package in this repo against `docs/context/apm/**` questions
- verify answers route to bundled references, not generic memory
- adjust README examples to exactly match working smoke flow

## Verification
Required evidence before done:
- package manifest passes path preflight
- `pi install <local-path>` succeeds in temp Pi dir
- `pi list` shows package only in temp dir
- successful `/skill:apm-usage ...` smoke log
- README install / usage examples match exact validated flow

## Risks
- blindly copying APM corpus could overshoot package size; trim to highest-value docs
- extension layer tempting but unnecessary for v1; skip unless user explicitly wants command execution

## Simplest viable v1
Skill-only package that ports `apm-guide` corpus into Pi package format. No extension code. No new dependency.

## Next step
Choose package name and docs subset, then scaffold `packages/pi-apm`.

## Previous Version

## Goal
Ship narrow Pi package that helps users manage APM from inside Pi, grounded in `docs/context/apm/docs/src/content/docs/` and existing APM package assets under `docs/context/apm/packages/apm-guide/`.

## Package promise
One-sentence promise: install package, ask Pi any APM usage / authoring / troubleshooting question, get docs-grounded guidance and concrete `apm` command paths.

Immediate user value:
- explicit Pi skill for APM tasks
- optional expert agent for focused APM sessions
- bundled reference files distilled from APM docs

V1 out of scope:
- no shell-executing Pi extension
- no direct `apm` process wrapper or TUI panel
- no auto-sync from upstream docs
- no registry publishing flow beyond local-path / workspace validation

## Chosen surface

## Chosen surface
Use **skills only** for v1.

Why:
- Pi package docs support `extensions`, `skills`, `prompts`, `themes` in `package.json` `pi` manifest; no documented `agents` key in packages surface
- Pi skill docs already give exact runtime behavior needed: `/skill:name`, on-demand `read` of bundled references, recursive `SKILL.md` discovery
- existing source package `docs/context/apm/packages/apm-guide/` already has strongest value in skill corpus `apm-usage/**`
- shortest path: adapt proven docs-grounded skill, skip extension / agent plumbing

Consequence:
- do not ship `agents/apm-expert.agent.md` in v1 package manifest
- if expert-agent workflow still desired later, add separate extension or future package surface only after Pi docs support path is proven

## Source material
Primary docs corpus:
- `docs/context/apm/docs/src/content/docs/concepts/what-is-apm.md`
- `docs/context/apm/docs/src/content/docs/concepts/primitives-and-targets.md`
- `docs/context/apm/docs/src/content/docs/concepts/package-anatomy.md`
- `docs/context/apm/docs/src/content/docs/guides/operating-installed-context.md`
- `docs/context/apm/docs/src/content/docs/enterprise/apm-policy.md`
- `docs/context/apm/docs/src/content/docs/specs/openapm-v0.1.md`

Existing reusable package:
- `docs/context/apm/packages/apm-guide/apm.yml`
- `docs/context/apm/packages/apm-guide/.apm/skills/apm-usage/**`
- `docs/context/apm/packages/apm-guide/.apm/agents/apm-expert.agent.md`

## Recommended package shape

## Recommended package shape
Target new workspace package `packages/pi-apm`.

Minimal tree:
- `packages/pi-apm/package.json`
- `packages/pi-apm/README.md`
- `packages/pi-apm/LICENSE`
- `packages/pi-apm/skills/apm-usage/SKILL.md`
- `packages/pi-apm/skills/apm-usage/{installation,workflow,commands,dependencies,authentication,governance,package-authoring,troubleshooting}.md`

Package metadata draft:
- `name`: `@rigerc/pi-apm`
- `keywords`: include `pi-package`, `apm`
- `pi.skills`: `./skills`
- no `pi.agents` in v1
- tight `files` list only for shipped assets

## Open decisions

## Open decisions
1. **Raw port vs Pi-tuned rewrite**
   - default: port existing `apm-guide` corpus, then trim wording for Pi
2. **Package name**
   - default: `@rigerc/pi-apm`
   - fallback: `@rigerc/pi-apm-guide` if scope should signal docs-first package
3. **Docs subset**
   - default: ship current `apm-usage` split plus only highest-value references
   - trim spec-heavy material if package gets noisy or redundant

## Implementation phases
### Phase 1: Confirm Pi package surface
- read Pi package docs for supported manifest keys, install layout, agent support
- inspect repo package patterns in `packages/pi-*`
- decide final manifest surface: skills only or skills + agents
- ⏸️ pause: lock package boundary before scaffolding

### Phase 2: Map APM corpus into Pi skill
- reuse `apm-guide` skill structure
- rewrite activation language for Pi user intents
- trim references that assume APM runtime instead of Pi runtime
- keep docs-grounded file split for commands / deps / governance / authoring
- ⏸️ pause: review copied corpus for Pi fit and scope creep

### Phase 3: Package scaffold
- add workspace package dir
- add `package.json` with Pi manifest
- add README with honest install story: local path first, Pi-only, what package does not do
- add LICENSE / CHANGELOG if repo conventions require

### Phase 4: Validation prep
- repo checks: targeted typecheck only if package adds TS extension code; otherwise none
- manifest preflight per Pi package creator validation flow
- locate same `pi` binary used for validation
- confirm package manager install path docs

### Phase 5: Install-path validation
- install package into temporary `PI_CODING_AGENT_DIR`
- confirm `pi list` shows package
- smoke public surface:
  - explicit `/skill:apm-usage` invocation
  - realistic prompt: ask how to install package, inspect deps, troubleshoot policy block
- if agent ships, smoke agent discovery separately
- ⏸️ pause: only dogfood after temp install passes

### Phase 6: Dogfood in repo
- run package in this repo against `docs/context/apm/**` questions
- verify answers route to bundled references, not generic memory
- adjust README examples to exactly match working smoke flow

## Verification
Required evidence before done:
- package manifest passes path preflight
- `pi install <local-path>` succeeds in temp Pi dir
- `pi list` shows package only in temp dir
- successful `/skill:apm-usage ...` smoke log
- README install / usage examples match exact validated flow

## Risks
- Pi manifest may not support agents as standalone package surface; verify before copying `apm-expert`
- blindly copying APM corpus could overshoot Pi package size; trim to highest-value docs
- extension layer tempting but unnecessary for v1; skip unless user explicitly wants command execution

## Simplest viable v1
Skill-only package that ports `apm-guide` corpus into Pi package format. No extension code. No new dependency.

## Next step
Read Pi package docs, confirm supported manifest keys for skills and agents, then lock final package surface.