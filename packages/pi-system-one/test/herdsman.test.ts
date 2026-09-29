import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HERDSMAN_HINT,
  buildHerdsmanJudgeDefinition,
  herdsmanJudgeDefinitionPath,
  isHerdsmanAvailable,
  isManagedHerdsmanAgent,
  mapTopologyToPlan,
} from '../src/herdsman.js';
import { classifyTopologyFallback } from '../src/orchestrator.js';

const fakePi = (tools: Array<{ name: string }>): any => ({ getAllTools: () => tools });

test('isHerdsmanAvailable detects the agent_delegate tool only', () => {
  assert.equal(isHerdsmanAvailable(fakePi([{ name: 'agent_delegate' }])), true);
  assert.equal(isHerdsmanAvailable(fakePi([{ name: 'read' }, { name: 'ask_owner' }])), false);
  assert.equal(isHerdsmanAvailable(fakePi([])), false);
});

test('isManagedHerdsmanAgent detects the pi-herdsman managed-agent environment', () => {
  assert.equal(isManagedHerdsmanAgent({}, [], { PI_HERDSMAN_AGENT_DEFINITION: 'reviewer' }), true);
  assert.equal(isManagedHerdsmanAgent({}, [], { PI_HERDSMAN_AGENT_DEFINITION: '  ' }), false);
});

test('isManagedHerdsmanAgent falls back to the active_agent tag and ask_owner', () => {
  const managed = { getSystemPrompt: () => 'base <active_agent name="reviewer"/> tail' };
  assert.equal(isManagedHerdsmanAgent(managed, ['read', 'ask_owner'], {}), true);
  assert.equal(isManagedHerdsmanAgent(managed, ['read'], {}), false);
  assert.equal(
    isManagedHerdsmanAgent({ getSystemPrompt: () => 'plain prompt' }, ['ask_owner'], {}),
    false,
  );
  assert.equal(isManagedHerdsmanAgent({}, ['ask_owner'], {}), false);
  assert.equal(
    isManagedHerdsmanAgent(
      {
        getSystemPrompt: () => {
          throw new Error('no prompt');
        },
      },
      ['ask_owner'],
      {},
    ),
    false,
  );
});

test('mapTopologyToPlan maps single-agent topologies onto pi-herdsman definitions', () => {
  assert.deepEqual(mapTopologyToPlan('implementation', 'add a feature'), [
    { definition: 'implementer', task: 'add a feature' },
  ]);
  assert.deepEqual(mapTopologyToPlan('review', 'audit the parser'), [
    { definition: 'reviewer', task: 'audit the parser' },
  ]);
  assert.deepEqual(mapTopologyToPlan('general', 'explain this'), [
    { definition: 'generalist', task: 'explain this' },
  ]);
});

test('mapTopologyToPlan fans research out to scout and researcher', () => {
  const plan = mapTopologyToPlan('research', 'how does auth work');
  assert.deepEqual(
    plan.map((assignment) => assignment.definition),
    ['scout', 'researcher'],
  );
  assert.ok(plan.every((assignment) => assignment.task.includes('how does auth work')));
});

test('the local fallback classifier feeds the plan map', () => {
  const prompt = 'fix the login bug';
  assert.equal(classifyTopologyFallback(prompt), 'implementation');
  assert.deepEqual(mapTopologyToPlan(classifyTopologyFallback(prompt), prompt), [
    { definition: 'implementer', task: prompt },
  ]);
});

test('HERDSMAN_HINT names the remedy', () => {
  assert.match(HERDSMAN_HINT, /pi-herdsman/);
  assert.match(HERDSMAN_HINT, /herdr/);
});

test('buildHerdsmanJudgeDefinition renders schema-valid frontmatter', () => {
  const definition = buildHerdsmanJudgeDefinition({
    extensionPath: '/pkg/extensions/index.ts',
    model: 'openrouter/typesafe/jev-1.13',
    thinking: 'off',
  });
  assert.match(definition, /^---\n/);
  assert.match(definition, /name: system-one-judge/);
  assert.match(definition, /tools: \["system_one_evaluate"\]/);
  assert.match(definition, /extensions: \["\/pkg\/extensions\/index\.ts"\]/);
  assert.match(definition, /model: "openrouter\/typesafe\/jev-1\.13"/);
  assert.match(definition, /thinking: off/);
  assert.match(definition, /system_one_evaluate/);

  // pi-herdsman fails discovery on unknown frontmatter fields, so keep this closed.
  const allowed = new Set([
    'name',
    'description',
    'model',
    'thinking',
    'tools',
    'extensions',
    'noSkills',
    'noBuiltinTools',
    'inheritProjectContext',
    'inheritGlobalContext',
  ]);
  const frontmatter = definition.split('---')[1] ?? '';
  const keys = frontmatter
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(':')[0].trim());
  assert.ok(
    keys.every((key) => allowed.has(key)),
    `unexpected frontmatter keys: ${keys.filter((key) => !allowed.has(key)).join(', ')}`,
  );
});

test('buildHerdsmanJudgeDefinition omits model and thinking when not provided', () => {
  const definition = buildHerdsmanJudgeDefinition({ extensionPath: '/pkg/extensions/index.ts' });
  assert.ok(!definition.includes('\nmodel:'), 'model inherits the spawner');
  assert.ok(!definition.includes('\nthinking:'), 'thinking inherits the spawner');
});

test('herdsmanJudgeDefinitionPath targets the global and project agent dirs', () => {
  assert.equal(
    herdsmanJudgeDefinitionPath('global', '/work', '/home/me/.pi/agent'),
    '/home/me/.pi/agent/agents/system-one-judge.md',
  );
  assert.equal(
    herdsmanJudgeDefinitionPath('project', '/work', '/home/me/.pi/agent'),
    '/work/.pi/agents/system-one-judge.md',
  );
});
