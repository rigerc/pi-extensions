---
title: "pi-jev: harden the combined auto tool+skill Jev request"
status: draft
created: "2026-09-21T21:32:08.386Z"
type: refactor
---

# pi-jev: harden the combined auto tool+skill Jev request

## Goal

Keep auto mode at **exactly one Jev request per prompt** when both `autoToolRouting` and
`autoSkillRouting` are on, while the two paths stay independently toggleable. This is a
hardening + truthfulness pass over the combine that already exists in the working tree:
make the combined pass a named, testable unit, make the bounded widening pass **per-path**
so a tool-only recall shortfall does not re-judge skills, and remove copy that still claims
two requests.

Out of scope (decided): the manual agent tools (`jev_find_tools`, `jev_find_skill`) and
`/jev skills` keep one request each. No changes to `src/router.ts` / `src/skills.ts`
routing internals.

## Current state (verified in the working tree)

| Piece | State |
| --- | --- |
| `AutoJev.pass()` in `src/auto.ts` | Already merges `tools` + `available_skills` candidates, questions, and one coverage Noul per enabled path into **one** `jevClient.evaluate` call |
| Toggle-ability | `AutoJev.setToolsEnabled` / `setSkillsEnabled`, driven by `SettingsService.apply()` from `autoToolRouting` / `autoSkillRouting` |
| Tests for the 4 toggle combos | Already present in `test/auto.test.ts` (both on = 1 request; tools only; skills only; both off = `disabled`) |
| Gaps | (a) widening is all-or-nothing: one merged `sufficient` flag can send a second pass that judges **new skills too** when only tools fell short; (b) `/jev auto` still prints "Costs up to two Jev requests per prompt"; (c) `AutoRouteResult` reports only one `escalated` boolean |

## Approach

Do not introduce a second router. Extract the existing inline assembly in `AutoJev.pass()`
into a small pure-ish unit that builds the request body from `{toolCandidates, skillCandidates}`
and maps answers back, then teach it per-path coverage. Rely on the existing
`TOOL_QUESTION_PREFIX` / `SKILL_QUESTION_PREFIX` and `shortlistQuestionId()` so the two
paths never collide in one answer map.

Key invariant to protect in every test: **enabled paths share one request; a disabled path
contributes no candidates, no questions, and no tokens; widening adds at most one extra
request and only for the path(s) that answered "insufficient".**

## Phase 1 — Extract the combined pass (no behavior change)

- In `src/auto.ts`, pull the body of `pass()` into an explicit, named helper
  (`buildCombinedRequest(...)` + `readCombinedAnswers(...)`, or a small
  `CombinedRoutingPass` value). Keep it in `auto.ts` unless the file grows past ~300 lines,
  in which case move it to `src/auto-pass.ts` and import it only from `auto.ts`.
- The helper takes the two candidate lists plus `{prompt, recentContext}` and returns
  `{questions, state}`; the reader takes `response.answers` and returns per-path
  probabilities + per-path sufficiency.
- Guarantee: when both lists are empty, no request is issued (`pass` currently returns
  early — keep that).
- No API/behavior change. `AutoJev.pass` should read as: shortlist → build → evaluate →
  read → apply.

**Exit:** `node --test --import tsx test/auto.test.ts` passes unchanged.

## Phase 2 — Per-path widening

- Replace the single `sufficient` result with `toolSufficient` / `skillSufficient`.
- `pass()` gains an explicit `widen: { tools: boolean; skills: boolean }` input:
  - first pass: `{ tools: true, skills: true }`;
  - second pass: only the paths that answered insufficient, so a sufficient path
    contributes `[]` and therefore no questions/tokens.
- `route()`: run the second pass when either path fell short; merge results; set a new
  `widened: { tools: boolean; skills: boolean }` on `AutoRouteResult` and keep `escalated`
  as `widened.tools || widened.skills` (back-compat with `extensions/index.ts` and tests).
- A disabled path must stay disabled in the widening pass (`toolsEnabled`/`skillsEnabled`
  gate every shortlist, including the second pass).
- Keep the existing failure guarantee: a failed second request keeps first-pass verdicts;
  a disabled path must never be "widened into" existence.

**Exit:** new test (Phase 4) shows: tools insufficient + skills sufficient ⇒ second request
contains only new `tool__*` questions and no `skill__*` question; `widened.skills === false`.

⏸️ Pause: confirm the `AutoRouteResult` shape change (`widened`) is acceptable before
editing consumers.

## Phase 3 — Truthful copy

- `src/commands.ts` (~line 302): `/jev auto on` message must say the two paths share one
  request, e.g. *"each prompt routes tools and suggests skills in one shared Jev request."*
  Remove "Costs up to two Jev requests per prompt."
- `src/commands.ts` (~lines 318/333): keep "(1 Jev request per prompt)" for a single path,
  but note the save when both are on, e.g. *"shares the prompt's single Jev request."*
- `src/config.ts` (~lines 74/83): descriptions for `autoToolRouting` / `autoSkillRouting`
  should state that the two paths' questions travel in one request when both are enabled
  (so the settings TUI does not imply additive cost).
- Verify `README.md` / `CHANGELOG.md` already state one shared request (they do in the
  working tree) and reconcile the older "Corrected the documented auto-mode cost … two
  requests" 0.7.0 entry by leaving history intact — the Unreleased entry supersedes it.

**Exit:** `grep -rn "two Jev\|up to two" src/` returns nothing.

## Phase 4 — Tests (`test/auto.test.ts`)

Keep the existing four toggle-combination tests. Add:

1. **Per-path widening.** Tools pool > `TOOL_CANDIDATE_LIMIT`, tool coverage = low, skill
   coverage = high. Assert `requests === 2`, `widened` = `{tools:true, skills:false}`,
   second request has only `tool__*` questions, and `skillRouter.applyRecommendations`
   was not called for the second pass.
2. **Mirror case.** Skills insufficient, tools sufficient ⇒ second request has only new
   `skill__*` questions.
3. **Disabled path untouched by widening.** Tools-only mode with an insufficient tool
   shortlist ⇒ both requests contain zero `skill__*` questions and `state.available_skills`
   stays `[]`.
4. **Single-request invariant, both on, sufficient.** Already covered — extend an assertion
   that `requests === 1` and that the answer map's questions include both prefixes.
5. **Failure keeps first pass.** Extend the existing failed-widening test to assert
   `widened` stays false.

**Exit:** `npm run test` (or `node --test --import tsx test/*.test.ts`) green, with
`calls.requests` asserted in every combo.

## Phase 5 — Full verification

```bash
cd packages/pi-jev
npm run typecheck        # tsc --noEmit
npm run test             # node --test --import tsx test/*.test.ts
grep -rn "two Jev\|up to two" src/   # expect no matches
npm run smoke            # optional: pi -ne -e ./extensions/index.ts -p --no-session
```

- [ ] Both paths on ⇒ exactly 1 request when shortlists are sufficient, 2 only when one
      path is judged incomplete.
- [ ] Either path alone ⇒ 1 request, the disabled path issues no shortlist/activation call.
- [ ] Both off ⇒ `reason: "disabled"`, 0 requests.
- [ ] `widened` reports the path(s) that actually widened.
- [ ] No user-facing text claims two requests.
- [ ] `AutoRouteResult.escalated` still present for existing consumers.

## Risks

- **Token growth from widening.** Per-path widening can only reduce the number of
  questions in the second request, never increase it; the request itself is still bounded
  by `TOOL_CANDIDATE_LIMIT` / `SKILL_CANDIDATE_LIMIT`.
- **Answer-map collisions.** Safe as long as question ids come from
  `buildToolRelevanceQuestions` / `buildSkillRelevanceQuestions` /
  `shortlistQuestionId`; do not hand-build ids in the new helper.
- **Shape change.** Adding `widened` is additive; keep `escalated` to avoid touching
  `extensions/index.ts` behavior.

## Files touched

| File | Change |
| --- | --- |
| `src/auto.ts` | Extract combined pass; per-path `widen`; `widened` result field |
| `src/commands.ts` | Truthful cost text for `/jev auto`, `auto-tools`, `auto-skills` |
| `src/config.ts` | Accurate descriptions for the two routing settings |
| `test/auto.test.ts` | Per-path widening, disabled-path, failure, single-request assertions |
| `README.md` / `CHANGELOG.md` | Verify (already updated); no new claim needed |

No changes to `src/router.ts`, `src/skills.ts`, `src/tools.ts`, or `src/settings.ts`.
