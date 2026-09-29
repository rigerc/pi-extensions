import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateText, rankCandidates } from '../src/retrieval/shortlist.js';

const skills = [
  { name: 'tdd', description: 'Test-driven development and unit testing' },
  { name: 'frontend-design', description: 'Create distinctive production-grade UI interfaces' },
  { name: 'resolving-merge-conflicts', description: 'Resolve git rebase and merge conflicts' },
  { name: 'accessibility', description: 'Audit and improve WCAG accessibility' },
];
const textOf = (skill: (typeof skills)[number]): string => candidateText(skill);

test('rankCandidates puts the candidate that owns the query term first', () => {
  const ranked = rankCandidates(skills, 'fix git rebase conflicts', textOf);
  assert.equal(ranked[0]?.candidate.name, 'resolving-merge-conflicts');
  assert.ok((ranked[0]?.score ?? 0) > 0);
});

test('rankCandidates scores the text its caller provides', () => {
  // The tool path scores a prompt snippet the skill path has no equivalent for, so the text
  // function is required rather than defaulted; a silent default would drop that signal.
  const tools = [
    { name: 'docker_logs', description: 'Read container output', promptSnippet: 'inspect services' },
    { name: 'read', description: 'Read a file from disk', promptSnippet: 'open files' },
  ];
  const ranked = rankCandidates(
    tools,
    'inspect running services',
    (tool) => `${tool.name} ${tool.description} ${tool.promptSnippet}`,
  );
  assert.equal(ranked[0]?.candidate.name, 'docker_logs');
});

test('rankCandidates keeps unmatched candidates, in their original order', () => {
  // An empty shortlist would turn a vocabulary miss into no judgment at all, when the model
  // can still usefully answer `none`.
  const ranked = rankCandidates(skills, 'kubernetes helm chart', textOf);
  assert.equal(ranked.length, skills.length);
  assert.deepEqual(
    ranked.map((entry) => entry.candidate.name),
    skills.map((skill) => skill.name),
  );
  assert.ok(ranked.every((entry) => entry.score === 0));
});

test('rankCandidates preserves input order for unmatched candidates at any corpus size', () => {
  // Regression: with unpadded index ids, a 12-candidate all-zero-score corpus came back as
  // 0, 1, 10, 11, 2, 3, … because ids are compared as strings. Real corpora are far larger
  // than ten entries, so this decided what the model saw.
  const many = Array.from({ length: 12 }, (_, index) => ({
    name: `skill_${index}`,
    description: 'unrelated',
  }));
  const ranked = rankCandidates(many, 'kubernetes helm chart', textOf);
  assert.deepEqual(
    ranked.map((entry) => entry.candidate.name),
    many.map((candidate) => candidate.name),
  );
});

test('rankCandidates handles an empty candidate list and a stopword-only query', () => {
  assert.deepEqual(rankCandidates([], 'anything', textOf), []);
  assert.equal(rankCandidates(skills, 'the and of', textOf).length, skills.length);
});

test('rankCandidates does not let a substring inside another word decide the order', () => {
  // The regression that motivated BM25: `we` inside `powered` and `are` inside `software`
  // used to count as matches, so generic English fragments ranked candidates.
  const candidates = [
    { name: 'notes', description: 'notes about paddling and rowing' },
    { name: 'arithmetic', description: 'add two numbers together' },
  ];
  const ranked = rankCandidates(candidates, 'add', textOf);
  assert.equal(ranked[0]?.candidate.name, 'arithmetic');
  assert.equal(ranked[1]?.score, 0, 'a term inside another word is not a match');
});

test('candidateText folds name and description into one scored string', () => {
  assert.equal(candidateText({ name: 'tdd', description: 'unit testing' }), 'tdd unit testing');
  assert.equal(candidateText({ name: 'tdd' }), 'tdd');
  assert.equal(candidateText({ name: 'tdd', description: '  ' }), 'tdd');
});
