import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTING_THRESHOLDS } from '../src/thresholds.js';
import {
  NONE_OPTION,
  SKILL_CANDIDATE_LIMIT,
  SKILL_PRIMARY_QUESTION_ID,
  SKILL_QUESTION_PREFIX,
  SkillRouter,
  buildSkillPrimaryQuestion,
  selectSkills,
  type SkillMetadata,
} from '../src/skills.js';
import { SystemOneClient } from '../src/system-one.js';

const CANDIDATES: SkillMetadata[] = [
  { name: 'git-conflicts', description: 'Resolve git rebase and merge conflicts' },
  { name: 'tdd', description: 'Test-driven development' },
  { name: 'a11y', description: 'Audit WCAG accessibility' },
];

/** A fake client that answers the primary Choice with the first real candidate. */
function answeringClient(
  options: {
    noul?: number;
    coverage?: number;
    choiceProbability?: number;
    failAfter?: number;
    requests?: any[];
  } = {},
) {
  const noul = options.noul ?? 0.1;
  const coverage = options.coverage ?? 0.95;
  const choiceProbability = options.choiceProbability ?? 0.9;
  let call = 0;

  return {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      call += 1;
      options.requests?.push(request);
      if (options.failAfter !== undefined && call > options.failAfter) {
        throw new Error('simulated request failure');
      }
      return {
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]: [string, any]) => {
            if (id === SKILL_PRIMARY_QUESTION_ID) {
              const winner = Object.keys(question.criteria)[1] ?? NONE_OPTION;
              return [
                id,
                { type: 'choice', value: winner, distribution: { [winner]: choiceProbability } },
              ];
            }
            if (id.startsWith('coverage__')) return [id, { type: 'bool', value: coverage }];
            return [id, { type: 'bool', value: noul }];
          }),
        ),
        model: 'jev-latest',
        elapsedMs: 1,
      };
    },
  } as unknown as SystemOneClient;
}

test('SkillRouter normalizes Pi skill commands before recommending them', async () => {
  const location = '/skills/tdd/SKILL.md';
  const router = new SkillRouter(
    {
      getCommands: () => [
        {
          name: 'skill:tdd',
          description: 'Test-driven development',
          source: 'skill',
          sourceInfo: { path: location },
        },
        { name: 'jev', description: 'Manage Jev', source: 'extension' },
      ],
    } as any,
    { isConfigured: () => false } as SystemOneClient,
  );

  const result = await router.findSkills('Test-driven development');
  assert.deepEqual(result.candidates, ['tdd']);
  assert.equal(result.primary?.name, 'tdd');
  assert.equal(result.primary?.location, location);
});

test('SkillRouter deduplicates prompt skills and commands and preserves filePath', () => {
  const router = new SkillRouter(
    {
      getCommands: () => [
        { name: 'skill:tdd', description: 'Command description', source: 'skill' },
      ],
    } as any,
    { isConfigured: () => false } as SystemOneClient,
  );
  const skills = router.getAvailableSkills({
    getSystemPromptOptions: () => ({
      skills: [
        { name: 'tdd', description: 'Test-driven development', filePath: '/skills/tdd/SKILL.md' },
      ],
    }),
  } as any);

  assert.deepEqual(skills, [
    {
      name: 'tdd',
      description: 'Test-driven development',
      location: '/skills/tdd/SKILL.md',
    },
  ]);
});

test('SkillRouter shortlists skills based on query terms', () => {
  const mockSkills: SkillMetadata[] = [
    { name: 'tdd', description: 'Test-driven development and unit testing' },
    { name: 'frontend-design', description: 'Create distinctive production-grade UI interfaces' },
    { name: 'resolving-merge-conflicts', description: 'Resolve git rebase and merge conflicts' },
    { name: 'accessibility', description: 'Audit and improve WCAG accessibility' },
  ];

  const mockPi: any = {
    getCommands: () => [],
  };

  const systemOneClient = new SystemOneClient();
  const router = new SkillRouter(mockPi, systemOneClient);

  const candidates = router.shortlist(mockSkills, 'fix git rebase conflicts');
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].name, 'resolving-merge-conflicts');
});

test('SkillRouter fallback returns a keyword primary at zero probability', async () => {
  const mockSkills: SkillMetadata[] = [
    { name: 'tdd', description: 'Test-driven development' },
    { name: 'accessibility', description: 'Audit web accessibility' },
  ];

  const mockPi: any = {
    getCommands: () =>
      mockSkills.map((s) => ({
        name: s.name,
        description: s.description,
        source: 'skill',
      })),
  };

  // Stub unconfigured client: local runs may have a real API key or secret file.
  const systemOneClient = { isConfigured: () => false } as unknown as SystemOneClient;
  const router = new SkillRouter(mockPi, systemOneClient);

  const res = await router.findSkills('make web accessible');
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.escalated, false);
  assert.equal(res.primary?.name, 'accessibility');
  assert.equal(res.primary?.probability, 0);
  assert.deepEqual(res.runnersUp, [], 'a fallback hint is a primary only, never a crowd');
});

test('SkillRouter shortlist can exclude skills a previous pass already judged', () => {
  const skills: SkillMetadata[] = [
    { name: 'tdd', description: 'Test-driven development' },
    { name: 'git-conflicts', description: 'Resolve git conflicts' },
  ];
  const router = new SkillRouter({ getCommands: () => [] } as any, new SystemOneClient());

  const all = router.shortlist(skills, 'git tdd', 10);
  assert.equal(all.length, 2);
  const remainder = router.shortlist(skills, 'git tdd', 10, new Set(['tdd']));
  assert.deepEqual(
    remainder.map((s) => s.name),
    ['git-conflicts'],
  );
});

test('buildSkillPrimaryQuestion puts none first and labels options with the name', () => {
  const question = buildSkillPrimaryQuestion(CANDIDATES);

  assert.equal(question.type, 'choice');
  assert.deepEqual(
    Object.keys(question.criteria),
    [NONE_OPTION, 'git-conflicts', 'tdd', 'a11y'],
    'the abstain option is sent first so it is not the trailing option',
  );
  assert.equal(question.criteria.tdd, 'tdd — Test-driven development');
});

test('buildSkillPrimaryQuestion falls back to index option ids when a skill is named none', () => {
  const question = buildSkillPrimaryQuestion([
    { name: NONE_OPTION, description: 'A skill literally named none' },
    { name: 'tdd', description: 'Test-driven development' },
  ]);

  assert.deepEqual(Object.keys(question.criteria), [NONE_OPTION, 's0', 's1']);
});

test('selectSkills abstains when the model chooses none', () => {
  const selection = selectSkills(
    { value: NONE_OPTION, distribution: { [NONE_OPTION]: 0.9, tdd: 0.1 } },
    { tdd: 0.95, a11y: 0.9 },
    CANDIDATES,
  );

  assert.equal(selection.abstained, true);
  assert.equal(selection.abstainReason, 'none-won');
  assert.equal(selection.primary, null);
  assert.deepEqual(
    selection.runnersUp,
    [],
    'high per-candidate values must not resurrect a skill the choice rejected',
  );
});

test('selectSkills abstains when none is nearly as likely as the winner', () => {
  const selection = selectSkills(
    { value: 'tdd', distribution: { tdd: 0.45, [NONE_OPTION]: 0.45 } },
    { tdd: 0.45 },
    CANDIDATES,
  );

  assert.equal(selection.abstained, true);
  assert.equal(selection.abstainReason, 'none-won');
});

test('selectSkills abstains when the winner is below the winner floor', () => {
  const selection = selectSkills(
    { value: 'tdd', distribution: { tdd: 0.1, [NONE_OPTION]: 0.05 } },
    { tdd: 0.1 },
    CANDIDATES,
  );

  assert.equal(selection.abstained, true);
  assert.equal(selection.abstainReason, 'below-threshold');
});

test('selectSkills treats a missing or unusable answer as no evidence, not as none', () => {
  const missing = selectSkills(undefined, { tdd: 0.99 }, CANDIDATES);
  assert.equal(missing.abstained, true);
  assert.equal(missing.abstainReason, 'no-answer');

  const unknown = selectSkills({ value: 'not-a-candidate' }, { tdd: 0.99 }, CANDIDATES);
  assert.equal(unknown.abstained, true);
  assert.equal(unknown.abstainReason, 'no-answer');

  const choseNone = selectSkills({ value: NONE_OPTION, distribution: {} }, { tdd: 0.99 }, CANDIDATES);
  assert.equal(choseNone.abstainReason, 'none-won');
});

test('selectSkills takes the primary from the choice, not the highest candidate value', () => {
  const selection = selectSkills(
    { value: 'a11y', distribution: { a11y: 0.4 } },
    { tdd: 0.95, a11y: 0.4 },
    CANDIDATES,
  );

  assert.equal(selection.primary?.name, 'a11y');
  assert.deepEqual(
    selection.runnersUp.map((r) => r.name),
    ['tdd'],
    'the candidate the choice passed over becomes a runner-up, not a second primary',
  );
});

test('selectSkills caps runner-ups so adjacent skills cannot all be injected', () => {
  const selection = selectSkills(
    { value: 'tdd', distribution: { tdd: 0.5 } },
    { tdd: 0.5, 'git-conflicts': 0.9, a11y: 0.8 },
    CANDIDATES,
  );

  assert.equal(selection.primary?.name, 'tdd');
  assert.deepEqual(
    selection.runnersUp.map((r) => r.name),
    ['git-conflicts', 'a11y'],
  );
  assert.equal(selection.runnersUp.length, DEFAULT_ROUTING_THRESHOLDS.maxRunnersUp);
});

test('selectSkills drops runner-ups below the runner-up threshold', () => {
  const selection = selectSkills(
    { value: 'tdd', distribution: { tdd: 0.5 } },
    { tdd: 0.5, 'git-conflicts': 0.59, a11y: 0.85 },
    CANDIDATES,
  );

  assert.deepEqual(
    selection.runnersUp.map((r) => r.name),
    ['a11y'],
  );
});

test('SkillRouter turns a reported over-injection into one primary plus bounded alternatives', async () => {
  // Regression, from a real prompt: three thematically adjacent skills were injected as peers
  // (jev 0.86, typesafe-ai 0.84, pi 0.76) because each independent bool question cleared one
  // activation threshold and nothing arbitrated between them. The choice now picks one, and
  // the rest are capped alternatives. The shortlist is unchanged here; ordering is a separate fix.
  const skills = [
    { name: 'jev', description: 'Write programs that call Jev' },
    { name: 'typesafe-ai', description: 'Build AI-powered software with TypeSafe' },
    { name: 'pi', description: 'Pi-specific guidance for extensions and skills' },
  ];
  const nouls: Record<string, number> = { jev: 0.86, 'typesafe-ai': 0.84, pi: 0.76 };
  const client = {
    isConfigured: () => true,
    evaluate: async (request: any) => ({
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id]: [string, any]) => {
          if (id === SKILL_PRIMARY_QUESTION_ID) {
            return [
              id,
              {
                type: 'choice',
                value: 'jev',
                distribution: { [NONE_OPTION]: 0.04, jev: 0.5, 'typesafe-ai': 0.3, pi: 0.16 },
              },
            ];
          }
          if (id.startsWith('coverage__')) return [id, { type: 'bool', value: 0.9 }];
          return [id, { type: 'bool', value: nouls[id.replace('skill__', '')] ?? 0 }];
        }),
      ),
      model: 'jev-latest',
      elapsedMs: 1,
    }),
  } as unknown as SystemOneClient;

  const router = new SkillRouter(
    {
      getCommands: () =>
        skills.map((s) => ({ name: s.name, description: s.description, source: 'skill' })),
    } as any,
    client,
  );

  const result = await router.findSkills('compare and rework skill routing');

  assert.equal(result.primary?.name, 'jev');
  assert.equal(result.primary?.probability, 0.5, 'the primary carries the choice probability');
  assert.deepEqual(
    result.runnersUp.map((r) => r.name),
    ['typesafe-ai', 'pi'],
    'the other two are alternatives, in judged order',
  );
  assert.equal(result.abstained, false);
});

test('SkillRouter widens once when coverage says the shortlist was incomplete', async () => {
  // The lexical shortlist is the recall ceiling: without this second pass a skill it
  // dropped is unreachable no matter how obvious it is to a semantic judge.
  const pool = Array.from({ length: SKILL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
    name: `skill_${i}`,
    description: `Unrelated specialty number ${i}`,
  }));
  const requests: any[] = [];
  const mockPi = {
    getCommands: () =>
      pool.map((s) => ({ name: s.name, description: s.description, source: 'skill' })),
  };
  const router = new SkillRouter(
    mockPi as any,
    answeringClient({ requests, coverage: 0.05, noul: 0.1, choiceProbability: 0.9 }),
  );

  const res = await router.findSkills('something entirely novel');

  assert.equal(res.escalated, true);
  assert.equal(requests.length, 2, 'widening costs exactly one extra request');
  assert.equal(requests[0].state.available_skills.length, SKILL_CANDIDATE_LIMIT);
  assert.equal(requests[0].questions[`${SKILL_QUESTION_PREFIX}skill_0`].type, 'bool');
  assert.deepEqual(
    requests[1].state.available_skills.map((s: any) => s.name),
    [`skill_${SKILL_CANDIDATE_LIMIT}`],
  );
  assert.ok(SKILL_PRIMARY_QUESTION_ID in requests[0].questions, 'the choice is asked');
  assert.equal(
    Object.keys(requests[0].questions[SKILL_PRIMARY_QUESTION_ID].criteria)[1],
    'skill_0',
  );
  assert.equal(res.primary?.name, 'skill_0');
  assert.deepEqual(
    res.runnersUp.map((r) => r.name),
    [`skill_${SKILL_CANDIDATE_LIMIT}`],
    'the widening pass primary is demoted to a runner-up rather than dropped',
  );
  assert.equal(
    res.runnersUp.length <= DEFAULT_ROUTING_THRESHOLDS.maxRunnersUp,
    true,
    'the injection stays bounded however many candidates were judged',
  );
});

test('SkillRouter keeps first-pass verdicts when the widening pass fails', async () => {
  const pool = Array.from({ length: SKILL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
    name: `skill_${i}`,
    description: 'specialty',
  }));
  const mockPi = {
    getCommands: () => pool.map((s) => ({ ...s, source: 'skill' })),
  };
  const router = new SkillRouter(
    mockPi as any,
    answeringClient({ coverage: 0.01, noul: 0.1, failAfter: 1 }),
  );

  const res = await router.findSkills('specialty');

  assert.equal(res.escalated, false);
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.primary?.name, 'skill_0', 'the first pass verdict survives a failed retry');
});
