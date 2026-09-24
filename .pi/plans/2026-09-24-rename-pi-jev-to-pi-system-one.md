---
title: 'Rename pi-jev to pi-system-one'
status: draft
created: '2026-09-24T19:51:00+02:00'
type: feature
---

# Rename pi-jev to pi-system-one

## Goal

Rename `packages/pi-jev` to `packages/pi-system-one` and make **System One** the
canonical name throughout the package. The new name should describe the extension's
actual boundary: it sends typed Choice, Noul, and Score requests to a System One-compatible
backend, which may be TypeSafe, OpenRouter, local Laya, or another compatible model/endpoint.

This is a naming and migration change. It must not alter request semantics, provider
selection, fallback policy, thresholds, routing behavior, or the `/v1/systemone` wire
contract.

## Verified starting point

- The workspace is tracked directly by the monorepo at `packages/pi-jev`; it is not a
  submodule and the working tree was clean when this plan was written.
- The package is version `0.7.0` and currently identifies itself as
  `@rigerc/pi-jev`, with `pi-jev-gate` and `jev-gate` binaries.
- Generic branding and public identifiers appear across the package, including `/jev`,
  `/jev-settings`, `jev_*` tools, `PI_JEV_*` variables, `--jev-*` flags,
  `pi-jev.json`, `pi-jev-config`, status keys, TypeScript symbols, docs, and tests.
- Root workspace scripts, `package-lock.json`, and release-please configuration all name
  `packages/pi-jev`.
- `pi-system-one` is already an unrelated unscoped npm package (`1.2.0`), so this project
  must use the available scoped identity `@rigerc/pi-system-one`.
- `@rigerc/pi-system-one` is not currently published. `@rigerc/pi-jev` is also not
  currently published, so no scoped npm deprecation/redirect package is required.
- `rigerc/pi-jev` exists on GitHub; `rigerc/pi-system-one` does not. The repository rename
  is therefore available but is an explicit external migration step.
- Baseline validation on 2026-09-24: package typecheck passes, all **202 package tests
  pass**, and the dry-run tarball contains 28 files.
- The root `npm test` command currently finds no tests because its Vitest include pattern
  does not cover this package's `node:test` suites; validation must continue to invoke the
  package test script directly.

## Naming decisions

### Canonical identity

| Surface             | Current                                            | Canonical after rename                                                  |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| Directory           | `packages/pi-jev`                                  | `packages/pi-system-one`                                                |
| npm package         | `@rigerc/pi-jev`                                   | `@rigerc/pi-system-one`                                                 |
| GitHub repository   | `rigerc/pi-jev`                                    | `rigerc/pi-system-one`                                                  |
| Primary binary      | `pi-jev-gate`                                      | `pi-system-one-gate`                                                    |
| Short binary        | `jev-gate`                                         | `system-one-gate`                                                       |
| Main command        | `/jev`                                             | `/system-one`                                                           |
| Settings command    | `/jev-settings`                                    | `/system-one-settings`                                                  |
| Environment prefix  | `PI_JEV_*`                                         | `PI_SYSTEM_ONE_*`                                                       |
| Flag prefix         | `--jev-*`                                          | `--system-one-*`                                                        |
| User/project config | `pi-jev.json`                                      | `pi-system-one.json`                                                    |
| Session entry       | `pi-jev-config`                                    | `pi-system-one-config`                                                  |
| Agent id            | `jev`                                              | `system-one`                                                            |
| Tools               | `jev_find_tools`, `jev_find_skill`, `jev_evaluate` | `system_one_find_tools`, `system_one_find_skill`, `system_one_evaluate` |

Use `@rigerc/pi-system-one`, not the occupied unscoped `pi-system-one` name. Publish the
rename as `0.8.0`: this is a breaking public-surface change while the package remains
pre-1.0.

### What should still say Jev

Keep `Jev` only when it refers to the TypeSafe model or an immutable compatibility
contract:

- the `jev-latest` default model id and pinned `typesafe/jev-*` model ids;
- provider-specific explanations about Jev models;
- the TypeSafe SDK's API vocabulary where it is upstream-defined;
- old changelog entries and completed historical plans;
- the existing `.agents/skills/jev` skill, which specifically teaches Jev model usage;
- deprecated aliases during the compatibility window.

Generic messages should say “System One request”, “System One backend”, or the resolved
provider/model name rather than “Jev request”.

### Compatibility window

Keep the following aliases for one minor release and document removal no earlier than
`0.9.0`:

- `/jev` and `/jev-settings` dispatch to the canonical command handlers;
- `--jev-*` flags are accepted below canonical `--system-one-*` flags;
- `PI_JEV_*` variables are accepted below canonical `PI_SYSTEM_ONE_*` variables;
- `pi-jev.json` is read only when the corresponding new settings file is absent, while
  all writes go to `pi-system-one.json`;
- `pi-jev-config` session entries are read, while new entries use
  `pi-system-one-config`;
- `pi-jev-gate` and `jev-gate` remain binary aliases pointing to the renamed runner;
- subagent targets `jev` and `typesafe-jev` continue to route to the canonical
  `system-one` handler.

When old and new inputs coexist, the new name wins. Status output should report legacy
input use once, without logging secrets or rewriting/deleting user files.

Do **not** register duplicate legacy `jev_*` tools: duplicate tools enlarge the prompt,
complicate activation state, and can be selected interchangeably. Rename the three tools
to their canonical `system_one_*` names as the deliberate breaking portion of `0.8.0`,
and call it out prominently in the changelog.

## Implementation plan

### Phase 1 — Rename workspace and release identity

1. Use `git mv packages/pi-jev packages/pi-system-one` so history follows the package.
2. Change the package name to `@rigerc/pi-system-one`, keep version `0.7.0` in the code
   change, and let release-please produce the `0.8.0` release bump.
3. Update root `check`/`test` scripts and rename the package-specific script names to
   `check:pi-system-one` and `test:pi-system-one`.
4. Move the release-please package and manifest keys from the old workspace path to the
   new one without resetting version history.
5. Regenerate `package-lock.json` through npm so both the workspace path and package name
   change coherently; do not hand-edit lockfile internals.
6. Update repository, bugs, and homepage metadata after renaming `rigerc/pi-jev` to
   `rigerc/pi-system-one`. Perform the GitHub rename immediately before landing metadata
   so published links never target a nonexistent repository.
7. Stop tracking `tsconfig.tsbuildinfo` and ignore `*.tsbuildinfo`; it is generated build
   state that embeds old paths and should not be part of the renamed package.

### Phase 2 — Introduce the System One core vocabulary

1. Rename `src/jev.ts` to `src/system-one.ts` and rename generic exported/internal
   symbols, including `JevClient`, provider/config/info types, request/response/stats
   types, environment/threshold/tool constants, and generic helper names.
2. Rename generic mode classes and registration functions (`AutoJev`, `JevCompactor`,
   `JevAgentHandler`, `registerJev*`) to `SystemOne*` equivalents. Files such as
   `router.ts`, `skills.ts`, and `gate.ts` may keep their functional filenames.
3. Replace generic labels, status keys, custom entry types, orchestration source labels,
   OpenRouter attribution headers, temporary-directory prefixes, and test fixture names.
4. Preserve provider values (`typesafe`, `openrouter`, `laya`), the default
   `jev-latest` model, the `@typesafe-ai/sdk` transport, request shapes, and fallback
   rules exactly.
5. Treat arbitrary model ids as configuration values, not as new provider adapters. A
   custom backend remains supported only when it implements the current System One wire
   contract; adding a new protocol is out of scope.

### Phase 3 — Rename public controls with bounded migration support

1. Register `/system-one` and `/system-one-settings` as canonical commands, then register
   the two old commands as thin aliases around the same handlers.
2. Define `PI_SYSTEM_ONE_*` and `--system-one-*` as canonical configuration names. Extend
   the registry so each setting can have legacy env/flag aliases and resolve precedence
   as `new > legacy` within the same layer.
3. Rename the internal `jevTools` setting to `systemOneTools` and migrate the old JSON key
   while reading legacy config/session data.
4. Read new settings files first. If a new file is absent, read its old counterpart and
   mark the provenance as legacy; persist and reset only the new paths unless the user
   explicitly requests cleanup.
5. Rename the RPC agent id and result id prefix to `system-one`, while accepting the old
   `jev` and `typesafe-jev` targets as input aliases.
6. Rename the three tool identifiers and update activation/exclusion logic atomically so
   the router never offers its own tools as candidates.
7. Rename the gate runner files and expose both new and legacy binary names from one
   implementation.

### Phase 4 — Documentation and migration guidance

1. Rewrite the README title, install commands, examples, configuration matrix, settings
   paths, command/tool references, and positioning around a provider-agnostic System One
   interface.
2. Add a `0.8.0` changelog entry with a compact old-to-new migration table. Do not rewrite
   historical changelog entries or completed plan files.
3. Update `SECURITY.md` and live help/error text to use the new config names while showing
   legacy names only in migration notes.
4. Add a short upgrade section: change package install source, rename config/env/flags,
   replace explicit tool calls, and note which aliases still work temporarily.
5. Update the package description and keywords around `system-one`, typed decisions,
   OpenRouter, Laya, and custom compatible models; retain `jev` as a discovery keyword.

### Phase 5 — Tests and release verification

Add or update tests for:

- canonical package/workspace metadata and all three canonical tool names;
- new command, settings command, flags, env variables, config files, session entries,
  binaries, and subagent id;
- every promised legacy alias;
- precedence when both old and new env/flag/file/session forms exist;
- migration reads never overwrite or delete old config files;
- own-tool filtering after the tool rename;
- unchanged provider selection, custom model pass-through, state caps, usage accounting,
  and hosted/local fallback behavior;
- help/status output preferring System One language and disclosing legacy input use;
- the packed tarball containing renamed binaries and no stale `packages/pi-jev` path.

Run:

```bash
npm ci
npm run check
npm --prefix packages/pi-system-one test
npm pack --workspace @rigerc/pi-system-one --dry-run
npm run publish:dry
npm --prefix packages/pi-system-one run smoke
```

Finish with a tracked-reference audit. Remaining `pi-jev`, `PI_JEV`, `/jev`, and `jev_*`
matches must be limited to compatibility code/tests, migration documentation, historical
plans/changelog entries, model ids, and the Jev-specific skill.

## Files and areas

| Area                                                         | Planned change                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/pi-jev/`                                           | Rename directory and all package identity/docs/tests                  |
| `src/jev.ts`, `src/types.ts`                                 | System One client, types, providers, constants, compatibility aliases |
| `src/config*.ts`, `src/settings*.ts`                         | New namespace, layered legacy precedence, file/session migration      |
| `src/commands.ts`, `src/tools.ts`, `extensions/index.ts`     | Commands, tools, flags, status, UI branding                           |
| `src/agent.ts`, `src/orchestrator.ts`, `src/gate.ts`, `bin/` | Agent and binary canonical names plus aliases                         |
| root `package.json`, `package-lock.json`                     | Workspace scripts and lockfile identity                               |
| `.github/release-please-*.json`                              | Preserve release history under the new path                           |
| package `README.md`, `SECURITY.md`, `CHANGELOG.md`           | Naming, upgrade guide, release note                                   |

## Acceptance criteria

- The workspace is `packages/pi-system-one` and the packed package is
  `@rigerc/pi-system-one`; no live build/release configuration references the old path.
- UI, help, docs, npm metadata, commands, flags, env vars, config paths, tool names, and
  internal generic types use System One as the canonical name.
- Jev wording remains only for actual Jev models, historical records, the Jev-specific
  skill, and documented compatibility paths.
- Legacy commands, settings controls, files, binaries, and agent ids work for the stated
  compatibility window, with deterministic new-over-old precedence.
- The three old `jev_*` tools are replaced—not duplicated—by `system_one_*` tools.
- All 202 baseline package tests still pass after their rename, with new migration tests
  added; typecheck, smoke test, install, and package dry run pass.
- Release-please carries `0.7.0` history forward and prepares `0.8.0` for the renamed
  package.
- No provider, model, request-shape, routing, threshold, fallback, privacy, or failure-mode
  behavior changes as part of the rename.

## Risks and mitigations

- **Name collision:** unscoped `pi-system-one` is occupied. Always use
  `@rigerc/pi-system-one` in metadata and install examples.
- **Split configuration:** deterministic new-over-old precedence and legacy provenance
  prevent silent ambiguity; writes converge on the new filename.
- **Duplicate tools:** do not register aliases for the old tool names; make their rename
  the explicit pre-1.0 breaking change.
- **Release history reset:** move the release-please manifest key in the same commit as the
  directory rename and verify the proposed release version before merging.
- **Broken external links:** coordinate the GitHub repository rename with metadata/docs;
  do not publish while the new URL is absent.
- **Accidental semantic refactor:** keep provider/protocol behavior frozen and use the
  existing provider, state-cap, routing, gate, and fallback tests as regression coverage.
