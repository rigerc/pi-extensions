import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillRouter, SKILL_CANDIDATE_LIMIT, type SkillMetadata } from '../src/skills.js';
import { SystemOneClient } from '../src/system-one.js';

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
  assert.equal(result.recommended[0].name, 'tdd');
  assert.equal(result.recommended[0].location, location);
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

test('SkillRouter fallback returns matching keyword candidates with 0 probability', async () => {
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
  assert.equal(res.recommended.length, 1);
  assert.equal(res.recommended[0].name, 'accessibility');
  assert.equal(res.recommended[0].probability, 0);
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
  const mockJev = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      requests.push(request);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: 'noul', value: id.startsWith('coverage__') ? 0.05 : 0.9 },
          ]),
        ),
        model: 'jev-latest',
        elapsedMs: 1,
      };
    },
  } as unknown as SystemOneClient;
  const router = new SkillRouter(mockPi as any, mockJev);

  const res = await router.findSkills('something entirely novel');

  assert.equal(res.escalated, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].state.available_skills.length, SKILL_CANDIDATE_LIMIT);
  assert.deepEqual(
    requests[1].state.available_skills.map((s: any) => s.name),
    [`skill_${SKILL_CANDIDATE_LIMIT}`],
  );
  assert.equal(res.recommended.length, SKILL_CANDIDATE_LIMIT + 1);
});

test('SkillRouter keeps first-pass verdicts when the widening pass fails', async () => {
  const pool = Array.from({ length: SKILL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
    name: `skill_${i}`,
    description: 'specialty',
  }));
  let call = 0;
  const mockPi = {
    getCommands: () => pool.map((s) => ({ ...s, source: 'skill' })),
  };
  const mockJev = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      call += 1;
      if (call > 1) throw new Error('second pass failed');
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: 'noul', value: id.startsWith('coverage__') ? 0.01 : 0.9 },
          ]),
        ),
        model: 'jev-latest',
        elapsedMs: 1,
      };
    },
  } as unknown as SystemOneClient;

  const res = await new SkillRouter(mockPi as any, mockJev).findSkills('specialty');
  assert.equal(res.escalated, false);
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.recommended.length, SKILL_CANDIDATE_LIMIT);
});
