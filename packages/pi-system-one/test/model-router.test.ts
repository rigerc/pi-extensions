import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError, classifyModelNeed, AutoModelRouter } from '../src/model-router.js';

const model = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    provider: 'test',
    name: id,
    api: 'test',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 1 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...extra,
  }) as any;

test('classifies model needs by task signals', () => {
  assert.equal(classifyModelNeed('plan a security decision').profile, 'reasoning');
  assert.equal(classifyModelNeed('inspect this screenshot', 0, true).profile, 'vision');
  assert.equal(classifyModelNeed('review the entire codebase').profile, 'long-context');
  assert.equal(classifyModelNeed('hi, list files').profile, 'fast');
});

test('classifies provider limit errors', () => {
  assert.equal(classifyModelError(new Error('429 rate limit')), 'rate-limit');
  assert.equal(classifyModelError(new Error('context window exceeded')), 'context-limit');
  assert.equal(classifyModelError(new Error('quota exceeded')), 'quota');
});

test('selects available model and skips unchanged selection', async () => {
  let selected = 0;
  const fast = model('fast');
  const reasoning = model('reasoning', { reasoning: true, contextWindow: 200000 });
  const pi: any = {
    setModel: async () => {
      selected++;
    },
  };
  const ctx: any = {
    model: fast,
    modelRegistry: { getAvailable: () => [fast, reasoning] },
    getSystemPrompt: () => '',
  };
  const router = new AutoModelRouter(pi, true);
  const result = await router.route('plan a safe migration', ctx);
  assert.equal(result.model?.id, 'reasoning');
  assert.equal(selected, 1);
  ctx.model = reasoning;
  const unchanged = await router.route('plan a safe migration', ctx);
  assert.equal(unchanged.changed, false);
  assert.equal(selected, 1);
});

test('blocks quota model for future fallback', () => {
  const current = model('quota-model');
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal(router.recordProviderResponse(429, current), 'rate-limit');
});

for (const scoped of [false, true]) {
  test(`preserves the current model when ${scoped ? 'scoped' : 'available'} models cannot accept images`, async () => {
    const current = model('current', { input: ['text', 'image'] });
    const textOnly = model('text-only');
    let switches = 0;
    const router = new AutoModelRouter(
      {
        setModel: async () => {
          switches++;
          return true;
        },
      } as any,
      true,
    );
    const ctx: any = {
      model: current,
      getSystemPrompt: () => '',
      // A compatible registry model must not override the user's text-only scope.
      modelRegistry: { getAvailable: () => (scoped ? [textOnly, current] : [textOnly]) },
      ...(scoped ? { scopedModels: [{ model: textOnly }] } : {}),
    };

    const result = await router.route('inspect this attachment', ctx, { hasImages: true });
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'no-model');
    assert.equal(switches, 0);
    assert.equal(ctx.model, current);
  });
}

test('selects an image-capable model for image input', async () => {
  const current = model('text-only', { reasoning: true });
  const vision = model('vision', { input: ['text', 'image'] });
  const selected: unknown[] = [];
  const router = new AutoModelRouter(
    {
      setModel: async (target: unknown) => {
        selected.push(target);
        return true;
      },
    } as any,
    true,
  );
  const ctx: any = {
    model: current,
    getSystemPrompt: () => '',
    modelRegistry: { getAvailable: () => [current, vision] },
  };

  const result = await router.route('inspect this attachment', ctx, { hasImages: true });
  assert.equal(result.changed, true);
  assert.equal(result.model, vision);
  assert.deepEqual(selected, [vision]);
});

test('does not fall back to a text-only model when the image model is blocked', async () => {
  const current = model('vision', { input: ['text', 'image'] });
  let switches = 0;
  const router = new AutoModelRouter(
    {
      setModel: async () => {
        switches++;
        return true;
      },
    } as any,
    true,
  );
  router.recordProviderResponse(429, current);

  const result = await router.route(
    'inspect this attachment',
    {
      model: current,
      getSystemPrompt: () => '',
      modelRegistry: { getAvailable: () => [current, model('text-only')] },
    } as any,
    { hasImages: true },
  );
  assert.equal(result.changed, false);
  assert.equal(result.skipped, 'no-model');
  assert.equal(switches, 0);
});
