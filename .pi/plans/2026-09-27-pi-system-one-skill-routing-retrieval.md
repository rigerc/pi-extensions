---
title: "pi-system-one: skill routing retrieval (steps 2-4)"
status: draft
created: "2026-09-27T19:01:13.339Z"
updated: "2026-09-27T19:03:50.816Z"
type: feature
---

## Context

Step 1 is done and merged into the working tree: skill routing can abstain, its output is
bounded to one primary plus two alternatives, thresholds are separated, and the automatic path
skips prompts that carry no routing signal. See `CHANGELOG.md` 0.8.0 → Added/Changed and
`src/thresholds.ts`.

Step 1's open problem — the shortlist — is now also done and measured.
`SkillRouter.shortlist` and `ToolRouter.shortlist` rank with BM25 over word-boundary tokens
with light plural normalization, sharing one implementation (`src/retrieval/`), and an offline
harness (`npm run eval:shortlist`) measures them against the skills installed on the machine.
`recall@12` went 45.5% → 69.1%. Phases 2-4 below remain.

Source of the approach and the numbers: `tmp/jev-skillful`, a capability router that measured
this exact problem. Its README is the evidence base.

## Phase 1: BM25 shortlist — DONE

Done and measured. See `src/retrieval/{tokenize,bm25,shortlist}.ts`, `src/eval/`,
`scripts/shortlist-eval.ts`, `bench/shortlist-queries.json`, and `npm run eval:shortlist`.

**Measured** on 620 skills installed on this machine and 55 author-written development
fixtures, K = 12 (the production `SKILL_CANDIDATE_LIMIT`):

| Metric | substring (before) | BM25 + plural normalization (after) |
|---|---|---|
| recall@12 | 45.5% | **69.1%** |
| MRR | 0.239 | **0.441** |
| top-1 | 16.4% | **32.7%** |

BM25 alone reached recall@12 63.0%; light plural normalization (`plan`/`plans`,
`index`/`indexes`) added the remaining 6.1pp and was measured separately before being kept. Top-1
moved 35.2% → 32.7% across that second step, so the plural rule is a recall/MRR win that costs a
little precision — worth re-checking if top-1 is ever the metric that matters.

**Be honest about what this is.** The fixtures are author-written and their targets were chosen
from the same corpus, so this is a development set. It shows direction. It is not a held-out
measurement and must not be quoted as one. The corpus is machine-specific too, so the absolute
numbers are not comparable across machines.

**Known regressions, all lexical-vocabulary gaps.** The remaining large rank drops
(`shadcn`, `supabase-postgres-best-practices`, `uniprot-skill`) are queries whose words simply do
not occur in the target's description — `add accessible dialog…` against a description saying
`adding, searching, fixing`; `policies and indexes` against `optimization … queries, schema`. No
lexical ranker can bridge that; it is precisely the case the coverage question and bounded
widening pass exist to recover, and they already do.

**Follow-up worth measuring, not guessing:** a gerund rule (`adding` → `add`, `searching` →
`search`) would recover part of the `shadcn` regression, but a naive `-ing` strip also turns
`string` into `str` and `bring` into `br`. Not shipped without evidence. The harness is in place,
so it is a ten-minute experiment.

## Phase 2: candidate text and request payload

**Files:** `src/skills.ts`, `src/router.ts`, `src/types.ts`.

- Bound each candidate description sent to the model (Skillful uses 200 chars) and fold
  "use when" text into it, so one long description cannot dominate.
- Stop sending `location` (an absolute filesystem path) in request state. It is needed for the
  injected message and for the caller, not for the judgment.
- Include the name in the candidate label — `[skill] name — description` — because the name is
  often the only signal available, and the current fallback `Skill for ${name}` is signal-free.
- Read SKILL.md frontmatter directly where possible so the description is not whatever Pi's
  command list exposes.

**Verification:**
- A test asserting request state contains no absolute paths.
- A test asserting every candidate description is bounded.
- `npm run test`, `npm run check`.

## Phase 3: deduplicate indistinguishable candidates

The same skill is installed under `.agents/skills/` and `node_modules/*/skills/`. The current
name-keyed map collapses exact names only.

**Files:** `src/skills.ts`.

- Collapse by `kind + description` before the shortlist cut, keeping the first occurrence as
  representative and recording the others as alternates.

**Verification:** a test with two byte-identical descriptions under different names yields one
candidate and one alternate.

## Phase 4: route cache

Every turn currently re-asks System One. Skillful measures a cold route at 1446ms and a cached
route at 221ms.

**Files:** new `src/cache.ts`, `src/auto.ts`.

- Cache by prompt hash plus a catalog fingerprint (names + descriptions), so an installed-skill
  change invalidates entries.
- Store no prompt text and no credential; bound the cache and expire it.

**Verification:** a test that a repeated prompt is served from cache and makes zero requests, and
that changing the skill set forces a fresh request.

## Measurement

The harness exists: `npm run eval:shortlist` scores a ranker over installed skills with no API
key and no model call, reporting recall@K, MRR, top-1 and the largest rank changes. Phase 1 was
measured with it before shipping, and the pre-BM25 scorer survives as `substringRanker`, so every
comparison is against what actually ran.

Phases 2-4 change what the model receives or what is cached, so each needs a before and after
number too; the harness makes that cheap. Two honesty constraints carry over from Phase 1:

- **These are development fixtures, not a holdout set.** The prompts are author-written and
  their targets were chosen from the same corpus, so the numbers show direction only. A real
  holdout means collecting prompts whose correct answer was decided before looking at the corpus —
  worth doing before any of these numbers is published as a quality claim.
- **The corpus is machine-specific.** Absolute recall depends on how many skills are installed,
  so compare before/after on one machine, never one machine against another.

## Known trade-offs from step 1

- **Runner-ups use a different measure from the primary.** The primary carries the Choice
  probability; an alternative carries its own Noul relevance. The display names them
  differently (`P=` vs `relevance=`) rather than implying they are comparable, but the two
  numbers still come from different questions. A future simplification is to drop the
  per-candidate Nouls entirely and rank runner-ups from the Choice distribution with its own
  lower threshold: that would make both numbers one measure and remove 12 questions per
  request, at the cost of losing the independent per-candidate signal. Skillful deliberately
  kept the Nouls, so do not make this change without measuring it.
- **Tool routing still activates additively from `SYSTEM_ONE_THRESHOLD`.** Abstention and
  bounding were applied to skills only. Additive activation is reversible, so this is
  defensible; revisit only if tool over-activation is observed.
- **`minPromptChars` is 12** and gates the automatic path only. An explicit
  `system_one_find_skill` call is never skipped, because that is a deliberate request.

## Out of scope

- Adopting Skillful's CLI + generated-hook architecture. Pi runs the router in-process; a child
  process would add latency for nothing.
- Multi-runtime catalog scanning (`~/.claude`, `~/.codex`, OMP). Pi exposes `getAllTools()` and
  `getCommands()`, and the two paths already cover what routing needs.
- Its telemetry subsystem. Session stats already cover tokens, cost and truncations.
- Its hardcoded TypeSafe endpoint. The provider-agnostic client with OpenRouter and Laya
  fallback is strictly better and stays.
- Quota groups per kind. Skillful needs them because it routes four kinds from one catalog; Pi
  routes tools and skills on separate paths, so one ranked list per path is already correct.