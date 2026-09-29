import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROMPT_MAX_STATE_CHARS,
  SystemOneClient,
  capState,
  listClassifierModels,
  normalizeUsage,
  parseProvider,
  toAnswerResult,
  toClassifierQuestion,
} from '../src/system-one.js';
import { adjustProbability } from '../src/thresholds.js';
import {
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  renderInstruction,
  validateQuestion,
  wrapState,
  type QuestionConfig,
} from '../src/types.js';
import { fakeRegistry, fakeClassifierModel } from './support/registry.js';

const MANAGED_ENV = ['PI_SYSTEM_ONE_PROVIDER', 'PI_SYSTEM_ONE_MODEL', 'PI_SYSTEM_ONE_TEMPERATURE', 'PI_JEV_PROVIDER', 'PI_JEV_MODEL'] as const;

/** Wipe the selection env so a developer's own environment cannot decide a result. */
function isolateEnv(vars: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const CHOICE: QuestionConfig = {
  type: 'choice',
  instructions: 'Which tool?',
  criteria: { read: 'Read a file', write: 'Write a file' },
};

const BOOL: QuestionConfig = {
  type: 'bool',
  instructions: 'Is the change needed?',
  criteria: { true: 'Needed', false: 'Not needed' },
};

/** A state of many small fields, so the total budget is what is under test. */
function wideState(chars: number): Record<string, string> {
  const state: Record<string, string> = {};
  let written = 0;
  let index = 0;
  while (written < chars) {
    const value = 'x'.repeat(Math.min(1_000, chars - written));
    state[`field${index++}`] = value;
    written += value.length;
  }
  return state;
}

/* -------------------------------------------------------------------------- */
/* Instructions and state                                                     */
/* -------------------------------------------------------------------------- */

test('renderInstruction keeps a plain string intact', () => {
  assert.equal(renderInstruction('  judge the state  '), 'judge the state');
  assert.equal(renderInstruction(null), '');
  assert.equal(renderInstruction(undefined), '');
  assert.equal(renderInstruction(3), '3');
});

test('renderInstruction flattens the structured question shape without [object Object]', () => {
  const rendered = renderInstruction({
    question: 'Does `tools[i]` help?',
    inspect: 'tools[0]',
    note: 'Judge only this tool.',
  });
  assert.equal(rendered, 'Does `tools[i]` help? Inspect: tools[0] Judge only this tool.');
  assert.ok(!rendered.includes('[object'), 'never leaks a stringified object');
});

test('renderInstruction labels a pointer field so it is not read as prose', () => {
  assert.equal(
    renderInstruction({ question: 'Should this stay?', inspect: 'entries[3]', goal: '`goal`' }),
    'Should this stay? Inspect: entries[3] Goal: `goal`.',
  );
});

test('renderInstruction turns an examples array into a For example clause', () => {
  const rendered = renderInstruction({
    what: 'The entry is still needed',
    examples: ['a failing test error', 'a user constraint'],
  });
  assert.equal(rendered, 'The entry is still needed For example: a failing test error; a user constraint.');
});

test('renderInstruction labels an unknown field rather than dropping it', () => {
  assert.equal(renderInstruction({ question: 'How much?', weight: 'high' }), 'How much? Weight: high.');
});

test('wrapState passes an object through and wraps anything else', () => {
  const object = { task: 'fix the build' };
  assert.equal(wrapState(object), object);
  assert.deepEqual(wrapState('plain state'), { state: 'plain state' });
  assert.deepEqual(wrapState([1, 2]), { state: [1, 2] });
  assert.deepEqual(wrapState(null), {});
});

/* -------------------------------------------------------------------------- */
/* Question conversion and validation                                         */
/* -------------------------------------------------------------------------- */

test('toClassifierQuestion maps a choice question to pi criteria', () => {
  assert.deepEqual(toClassifierQuestion('q', CHOICE), {
    type: 'choice',
    instructions: 'Which tool?',
    criteria: { read: 'Read a file', write: 'Write a file' },
  });
});

test('toClassifierQuestion gives an unlabelled choice option its own key as label', () => {
  const question = toClassifierQuestion('q', {
    type: 'choice',
    instructions: 'Which?',
    criteria: { read: 'Read a file', write: null },
  });
  assert.equal(question.type === 'choice' && question.criteria.write, 'write');
});

test('toClassifierQuestion converts the legacy noul type to bool', () => {
  const question = toClassifierQuestion('q', {
    type: 'noul',
    instructions: 'Is it needed?',
    criteria: { true: 'Needed', false: 'Not needed' },
  });
  assert.equal(question.type, 'bool');
  assert.deepEqual(question.type === 'bool' ? question.criteria : null, {
    true: 'Needed',
    false: 'Not needed',
  });
});

test('toClassifierQuestion supplies Yes and No when bool criteria are missing', () => {
  const question = toClassifierQuestion('q', { type: 'bool', instructions: 'Is it needed?' });
  assert.deepEqual(question.type === 'bool' ? question.criteria : null, { true: 'Yes', false: 'No' });
});

test('toClassifierQuestion keeps a score rubric in order', () => {
  const question = toClassifierQuestion('q', {
    type: 'score',
    instructions: 'How severe?',
    criteria: ['low', 'medium', 'high'],
  });
  assert.deepEqual(question.type === 'score' ? question.criteria : null, ['low', 'medium', 'high']);
});

test('validateQuestion rejects a choice without enough options', () => {
  assert.match(
    validateQuestion('q', { type: 'choice', instructions: 'Which?', criteria: { only: 'One' } }) ?? '',
    /at least 2 choice options, got 1/,
  );
  assert.match(
    validateQuestion('q', { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', c: null } }) ?? '',
    /unlabelled choice options: c/,
  );
});

test('validateQuestion rejects a score outside the labelable level count', () => {
  const tooMany = Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_, i) => `level ${i}`);
  assert.match(
    validateQuestion('q', { type: 'score', instructions: 'How bad?', criteria: tooMany }) ?? '',
    /more than the 10 a classifier can label/,
  );
  assert.equal(
    validateQuestion('q', {
      type: 'score',
      instructions: 'How bad?',
      criteria: Array.from({ length: MAX_SCORE_LEVELS }, (_, i) => `level ${i}`),
    }),
    null,
    'the full labelable level count is allowed',
  );
});

test('validateQuestion rejects empty instructions', () => {
  assert.match(validateQuestion('q', { type: 'bool', instructions: '' }) ?? '', /no instructions/);
  assert.equal(validateQuestion('q', BOOL), null);
});

/* -------------------------------------------------------------------------- */
/* Answer conversion and usage                                                */
/* -------------------------------------------------------------------------- */

test('toAnswerResult maps a choice answer onto value, confidence and distribution', () => {
  const answer = toAnswerResult({
    type: 'choice',
    choice: 'read',
    probabilities: { read: 0.7, write: 0.3 },
    confidence: 0.4,
  });
  assert.equal(answer.type, 'choice');
  assert.equal(answer.value, 'read');
  assert.equal(answer.confidence, 0.4);
  assert.deepEqual(answer.distribution, { read: 0.7, write: 0.3 });
});

test('toAnswerResult maps a score answer without a legend or distribution', () => {
  const answer = toAnswerResult({ type: 'score', score: 1.4, confidence: 0.8 });
  assert.equal(answer.value, 1.4);
  assert.equal(answer.confidence, 0.8);
  assert.equal(answer.distribution, undefined);
});

test('toAnswerResult maps a bool answer to its probability', () => {
  const answer = toAnswerResult({ type: 'bool', probability: 0.9 });
  assert.equal(answer.type, 'bool');
  assert.equal(answer.value, 0.9);
});

test('normalizeUsage reads pi token counts and the catalog cost total', () => {
  const usage = normalizeUsage({
    input: 10,
    output: 5,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
  });
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.02 });
});

test('normalizeUsage reports no cost rather than guessing one', () => {
  const usage = normalizeUsage({ input: 3, output: 1, totalTokens: 4 });
  assert.equal(usage.costUsd, undefined);
  assert.equal(usage.totalTokens, 4);
});

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

test('parseProvider treats auto and blank as no explicit choice', () => {
  assert.equal(parseProvider('auto'), null);
  assert.equal(parseProvider('  '), null);
  assert.equal(parseProvider(undefined), null);
  assert.equal(parseProvider('TypeSafe'), 'typesafe');
});

test('parseProvider accepts a provider this package never heard of', () => {
  assert.equal(parseProvider('llama.cpp'), 'llama.cpp');
  assert.equal(parseProvider('cloudflare-workers-ai'), 'cloudflare-workers-ai');
});

test('listClassifierModels reports provider, id and the serving api', async () => {
  const { registry } = fakeRegistry({
    models: [{ provider: 'llama-cpp', id: 'qwen3-4b', api: 'llama-cpp-classify' }],
  });
  assert.deepEqual(await listClassifierModels(registry), [
    { provider: 'llama-cpp', id: 'qwen3-4b', name: 'qwen3-4b', api: 'llama-cpp-classify' },
  ]);
});

test('listClassifierModels lists only providers with working credentials', async () => {
  const { registry } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
    authenticated: ['typesafe'],
  });
  const models = await listClassifierModels(registry);
  assert.deepEqual(
    models.map((model) => model.provider),
    ['typesafe'],
  );
});

test('listClassifierModels is empty with no registry', async () => {
  assert.deepEqual(await new SystemOneClient().listAvailable(), []);
});

/* -------------------------------------------------------------------------- */
/* evaluate                                                                   */
/* -------------------------------------------------------------------------- */

test('an unattached client explains how to get a classifier', async () => {
  await assert.rejects(
    new SystemOneClient().evaluate({ state: 'x', questions: { ok: BOOL } }),
    /No System One classifier is available[\s\S]*\/login/,
  );
});

test('a client with no available classifier explains how to get one', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({ models: [{ provider: 'typesafe', id: 'jev-latest' }], authenticated: [] });
  client.attach(registry);
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }),
    /No System One classifier is available/,
  );
});

test('evaluate wraps a string state instead of sending bare text', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({ classify: () => ({ answers: { ok: { type: 'bool', probability: 1 } } }) });
  client.attach(registry);
  await client.evaluate({ state: 'plain state', questions: { ok: BOOL } });
  assert.deepEqual(calls[0].context.state, { state: 'plain state' });
});

test('evaluate sends the classifier question shape pi expects', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({ classify: () => ({ answers: { which: { type: 'choice', choice: 'read', probabilities: { read: 1, write: 0 }, confidence: 1 } } }) });
  client.attach(registry);
  const response = await client.evaluate({
    state: { tools: ['read'] },
    questions: { which: CHOICE, ok: BOOL },
  });
  assert.deepEqual(calls[0].context.questions.which, {
    type: 'choice',
    instructions: 'Which tool?',
    criteria: { read: 'Read a file', write: 'Write a file' },
  });
  assert.equal(response.answers.which.value, 'read');
  assert.deepEqual(response.answers.which.distribution, { read: 1, write: 0 });
  assert.equal(response.answers.which.confidence, 1);
});

test('evaluate rejects a malformed question before making a request', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry();
  client.attach(registry);
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { bad: { type: 'choice', instructions: 'Which?', criteria: { only: 'One' } } } }),
    /at least 2 choice options/,
  );
  assert.equal(calls.length, 0, 'nothing is sent when a question cannot be labelled');
});

test('evaluate records usage, model and provider in session stats', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({
    classify: () => ({ answers: { ok: { type: 'bool', probability: 0.5 } } }),
    usage: { input: 8, output: 2, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  client.attach(registry);
  await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.equal(client.stats.requestsCount, 1);
  assert.equal(client.stats.totalTokens, 10);
  assert.equal(client.stats.totalCostUsd, 0.01);
  assert.equal(client.stats.provider, 'typesafe');
  assert.equal(client.stats.model, 'jev-latest');
  assert.equal(client.stats.lastError, undefined);
});

/* -------------------------------------------------------------------------- */
/* Fallback                                                                   */
/* -------------------------------------------------------------------------- */

test('a failing classifier falls through to the next available one', async () => {
  const client = new SystemOneClient();
  const { registry, calledProviders } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
    classify: (_call, index) => {
      if (index === 0) throw new Error('upstream unavailable');
      return { answers: { ok: { type: 'bool', probability: 0.75 } } };
    },
  });
  client.attach(registry);
  const response = await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.deepEqual(calledProviders(), ['typesafe', 'openrouter']);
  assert.equal(response.answers.ok.value, 0.75);
  assert.deepEqual(client.stats.fallback, {
    from: 'typesafe/jev-latest',
    to: 'openrouter/typesafe/jev-1.13',
    reason: 'upstream unavailable',
  });
});

test('an error from every candidate surfaces the last reason', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({ classify: () => { throw new Error('no route to host'); } });
  client.attach(registry);
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }),
    /no route to host/,
  );
  assert.equal(client.stats.lastError, 'no route to host');
  assert.equal(client.stats.requestsCount, 0, 'a failed call is not counted as a request');
});

test('an abort stops the chain instead of spending the other providers', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
    classify: () => ({ stopReason: 'aborted', errorMessage: 'cancelled' }),
  });
  client.attach(registry);
  await assert.rejects(client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }), /cancelled/);
  assert.equal(calls.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Explicit selection                                                         */
/* -------------------------------------------------------------------------- */

test('an explicitly chosen classifier that is unavailable is reported, not silently replaced', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
  });
  client.attach(registry);
  client.setProviderOverrides({ provider: 'openrouter', model: 'not-a-model' });
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }),
    /No classifier available for openrouter\/not-a-model[\s\S]*\/login openrouter/,
  );
  assert.equal(calls.length, 0);
});

test('a per-request model override pins the classifier for that call', async () => {
  const client = new SystemOneClient();
  const { registry, calledProviders } = fakeRegistry();
  client.attach(registry);
  await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL }, model: 'openrouter/typesafe/jev-1.13' });
  assert.deepEqual(calledProviders(), ['openrouter']);
});

test('PI_SYSTEM_ONE_MODEL accepts a provider/model reference', async () => {
  const env = isolateEnv({ PI_SYSTEM_ONE_MODEL: 'openrouter/typesafe/jev-1.13' });
  try {
    const client = new SystemOneClient();
    const { registry, calledProviders } = fakeRegistry();
    client.attach(registry);
    await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
    assert.deepEqual(calledProviders(), ['openrouter']);
  } finally {
    env.restore();
  }
});

test('a legacy PI_JEV_MODEL still selects a classifier', async () => {
  const env = isolateEnv({ PI_JEV_MODEL: 'openrouter/typesafe/jev-1.13' });
  try {
    const client = new SystemOneClient();
    const { registry, calledProviders } = fakeRegistry();
    client.attach(registry);
    await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
    assert.deepEqual(calledProviders(), ['openrouter']);
  } finally {
    env.restore();
  }
});

test('a gateway model id is read as an id, not as a provider reference', async () => {
  // `typesafe/jev-latest` on OpenRouter is a *model id*. Splitting it would send the
  // request to a typesafe provider instead, which is a different bill.
  const env = isolateEnv({
    PI_SYSTEM_ONE_PROVIDER: 'openrouter',
    PI_SYSTEM_ONE_MODEL: 'typesafe/jev-latest',
  });
  try {
    const client = new SystemOneClient();
    const { registry, calls } = fakeRegistry({
      models: [
        { provider: 'openrouter', id: 'typesafe/jev-latest' },
        { provider: 'typesafe', id: 'jev-latest' },
      ],
    });
    client.attach(registry);
    await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
    assert.equal(calls[0].model.provider, 'openrouter');
    assert.equal(calls[0].model.id, 'typesafe/jev-latest');
  } finally {
    env.restore();
  }
});

test('an explicit provider and model are both honoured', async () => {
  const env = isolateEnv({
    PI_SYSTEM_ONE_PROVIDER: 'openrouter',
    PI_SYSTEM_ONE_MODEL: 'typesafe/jev-1.13',
  });
  try {
    const client = new SystemOneClient();
    const { registry, calls } = fakeRegistry();
    client.attach(registry);
    await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
    assert.equal(calls[0].model.provider, 'openrouter');
    assert.equal(calls[0].model.id, 'typesafe/jev-1.13');
  } finally {
    env.restore();
  }
});

test('a thrown classify is a failed candidate, not the end of the chain', async () => {
  const client = new SystemOneClient();
  const { registry, calledProviders } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
    // pi throws before a request is made when a credential cannot be resolved.
    throwOn: (_call, index) =>
      index === 0 ? new Error('Provider is not configured: typesafe') : undefined,
    classify: () => ({ answers: { ok: { type: 'bool', probability: 0.8 } } }),
  });
  client.attach(registry);
  const response = await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.deepEqual(calledProviders(), ['typesafe', 'openrouter']);
  assert.equal(response.answers.ok.value, 0.8);
  assert.equal(client.stats.fallback?.reason, 'Provider is not configured: typesafe');
});

test('a thrown classify on the only candidate surfaces its reason', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({
    models: [{ provider: 'typesafe', id: 'jev-latest' }],
    throwOn: () => new Error('Provider is not configured: typesafe'),
  });
  client.attach(registry);
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }),
    /Provider is not configured: typesafe/,
  );
  assert.equal(client.stats.lastError, 'Provider is not configured: typesafe');
});

test('a caller cancellation does not spend the remaining candidates', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({
    models: [
      { provider: 'typesafe', id: 'jev-latest' },
      { provider: 'openrouter', id: 'typesafe/jev-1.13' },
    ],
    throwOn: () => new Error('aborted by caller'),
  });
  client.attach(registry);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } }, controller.signal),
    /aborted by caller/,
  );
  assert.equal(calls.length, 1, 'an abort is the caller decision, not a provider fault');
});

test('temperature is passed through only when configured', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({ classify: () => ({ answers: { ok: { type: 'bool', probability: 1 } } }) });
  client.attach(registry);
  await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.equal(calls[0].options?.temperature, undefined);

  client.setProviderOverrides({ temperature: 2 });
  await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.equal(calls[1].options?.temperature, 2);
});

test('a non-numeric temperature is ignored rather than sent as NaN', async () => {
  const env = isolateEnv({ PI_SYSTEM_ONE_TEMPERATURE: 'warm' });
  try {
    const client = new SystemOneClient();
    const { registry, calls } = fakeRegistry({ classify: () => ({ answers: { ok: { type: 'bool', probability: 1 } } }) });
    client.attach(registry);
    await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
    assert.equal(calls[0].options?.temperature, undefined);
  } finally {
    env.restore();
  }
});

/* -------------------------------------------------------------------------- */
/* State capping                                                              */
/* -------------------------------------------------------------------------- */

test('a prompt-rendered classifier gets a smaller state budget', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({
    models: [{ provider: 'llama-cpp', id: 'qwen3-4b', api: 'llama-cpp-classify' }],
    classify: () => ({ answers: { ok: { type: 'bool', probability: 1 } } }),
  });
  client.attach(registry);
  // Many small fields, not one big one: a single field over MAX_STATE_FIELD_CHARS is
  // cut for every backend, which would not exercise the total budget.
  const state = wideState(PROMPT_MAX_STATE_CHARS * 2);
  await client.evaluate({ state, questions: { ok: BOOL } });
  assert.ok(
    JSON.stringify(calls[0].context.state).length <= PROMPT_MAX_STATE_CHARS,
    'pi writes the state twice into a prompt, so it is capped lower',
  );
  assert.equal(client.stats.truncations, 1);
});

test('a hosted classifier keeps the full state budget', async () => {
  const client = new SystemOneClient();
  const { registry, calls } = fakeRegistry({ classify: () => ({ answers: { ok: { type: 'bool', probability: 1 } } }) });
  client.attach(registry);
  const state = wideState(PROMPT_MAX_STATE_CHARS + 1_000);
  await client.evaluate({ state, questions: { ok: BOOL } });
  assert.deepEqual(
    calls[0].context.state,
    state,
    'a hosted classifier is sent the state whole under the hosted cap',
  );
  assert.equal(client.stats.truncations, undefined);
});

test('capState still bounds an oversized state', () => {
  const capped = capState({ blob: 'x'.repeat(10_000) }, 1_000);
  assert.ok(JSON.stringify(capped.value).length <= 1_000);
  assert.ok(capped.truncatedChars > 0);
});

test('a local models probabilities are discounted before a threshold sees them', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({
    models: [{ provider: 'llama-cpp', id: 'qwen3-4b', api: 'llama-cpp-classify' }],
    classify: () => ({
      answers: {
        which: { type: 'choice', choice: 'read', probabilities: { read: 1, write: 0 }, confidence: 1 },
        ok: { type: 'bool', probability: 0.9 },
      },
    }),
  });
  client.attach(registry);
  const response = await client.evaluate({
    state: { a: 1 },
    questions: { which: CHOICE, ok: BOOL },
  });

  assert.ok(
    Math.abs(Number(response.answers.ok.value) - 0.72) < 1e-9,
    '0.9 from a local model is trusted as 0.72',
  );
  assert.ok(Math.abs(Number(response.answers.which.confidence) - 0.8) < 1e-9);
  assert.deepEqual(response.answers.which.distribution, { read: 0.8, write: 0 });
  assert.equal(
    (response.answers.ok.raw as { probability: number }).probability,
    0.9,
    "the classifier's own value stays on raw",
  );
});

test('a hosted classifier answer is never discounted', async () => {
  const client = new SystemOneClient();
  const { registry } = fakeRegistry({
    classify: () => ({ answers: { ok: { type: 'bool', probability: 0.9 } } }),
  });
  client.attach(registry);
  const response = await client.evaluate({ state: { a: 1 }, questions: { ok: BOOL } });
  assert.equal(response.answers.ok.value, 0.9);
});

test('adjustProbability leaves a hosted api alone and clamps the result', () => {
  assert.equal(adjustProbability(0.9, 'typesafe-system-one'), 0.9);
  assert.equal(adjustProbability(1, 'llama-cpp-classify'), 0.8);
  assert.equal(adjustProbability(0, 'llama-cpp-classify'), 0);
  assert.equal(adjustProbability(0.9, undefined), 0.9);
});

test('the default classifier is pi own Jev model', () => {
  assert.equal(DEFAULT_PROVIDER, 'typesafe');
  assert.equal(DEFAULT_MODEL, 'jev-latest');
});

test('a model list entry keeps its display name', () => {
  const model = fakeClassifierModel({ provider: 'llama-cpp', id: 'qwen3-4b', name: 'Qwen3 4B' });
  assert.equal(model.name, 'Qwen3 4B');
});
