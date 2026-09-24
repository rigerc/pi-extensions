import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolGuard, findMissingPaths, collectPathValues } from '../src/tool-guard.js';
import { SystemOneClient } from '../src/system-one.js';

const ctx = { cwd: process.cwd() } as any;

function piWithTools(
  tools: Array<{ name: string; description?: string; parameters?: unknown }> = [],
) {
  return { on: () => {}, getAllTools: () => tools } as any;
}

test('ToolGuard skips when disabled or when the tool is one of our own', async () => {
  const guard = new ToolGuard(piWithTools(), new SystemOneClient(), false);

  const res = await guard.checkToolCall('bash', { command: 'ls -la' });
  assert.equal(res.valid, true);
  assert.equal(res.blocked, undefined);

  const enabled = new ToolGuard(piWithTools(), new SystemOneClient(), true);
  assert.equal((await enabled.checkToolCall('system_one_find_skill', { query: 'x' })).valid, true);
});

test('ToolGuard blocks a path that does not exist without spending a System One request', async () => {
  // Existence has a correct answer in the filesystem, so it must not be guessed by a
  // model that was never shown the workspace.
  let evaluated = 0;
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async () => {
      evaluated += 1;
      return { answers: {}, model: 'm', elapsedMs: 1 };
    },
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);
  const res = await guard.checkToolCall(
    'read',
    { path: '/non/existent/hallucinated/file.xyz' },
    ctx,
  );

  assert.equal(res.valid, false);
  assert.equal(res.blocked, true);
  assert.equal(res.source, 'path-check');
  assert.equal(res.probability, 1);
  assert.match(res.reason ?? '', /does not exist/);
  assert.equal(evaluated, 0, 'a deterministic verdict must not cost a System One request');
});

test('ToolGuard still blocks a missing path when System One is unconfigured', async () => {
  const mockSystemOne = { isConfigured: () => false } as unknown as SystemOneClient;
  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);

  const res = await guard.checkToolCall('edit', { path: 'src/does-not-exist.ts' }, ctx);
  assert.equal(res.blocked, true);
  assert.equal(res.source, 'path-check');
});

test('ToolGuard does not path-check write, because creating a file is valid', async () => {
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: { invalid_parameters: { type: 'noul', value: 0.1 } },
      model: 'm',
      elapsedMs: 1,
    }),
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);
  const res = await guard.checkToolCall(
    'write',
    { path: 'src/brand-new-file.ts', content: '' },
    ctx,
  );
  assert.equal(res.valid, true);
  assert.equal(res.source, 'system-one', 'write falls through to the shape check');
});

test('ToolGuard does not block a path a sibling write in the same batch is creating', async () => {
  // Pi preflights every tool_call from one assistant message before executing any of
  // them, so a `write` that creates the file has not happened yet.
  const mockSystemOne = { isConfigured: () => false } as unknown as SystemOneClient;
  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);

  const siblingCtx = {
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: '1', name: 'write', arguments: { path: 'tmp/new-file.ts' } },
              { type: 'toolCall', id: '2', name: 'read', arguments: { path: 'tmp/new-file.ts' } },
            ],
          },
        },
      ],
    },
  } as any;

  const res = await guard.checkToolCall('read', { path: 'tmp/new-file.ts' }, siblingCtx);
  assert.equal(res.valid, true);
  assert.equal(res.blocked, undefined);

  // A different sibling write must not excuse this path.
  const otherCtx = {
    ...siblingCtx,
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: '1',
                name: 'write',
                arguments: { path: 'tmp/other-file.ts' },
              },
            ],
          },
        },
      ],
    },
  } as any;
  assert.equal(
    (await guard.checkToolCall('read', { path: 'tmp/new-file.ts' }, otherCtx)).blocked,
    true,
  );
});

test('ToolGuard path check ignores globs, URLs, and home-relative paths', () => {
  assert.deepEqual(findMissingPaths('read', { path: 'src/**/*.ts' }, process.cwd()), []);
  assert.deepEqual(findMissingPaths('read', { path: 'https://example.com/x' }, process.cwd()), []);
  assert.deepEqual(
    findMissingPaths('read', { path: '~/.pi/agent/missing.json' }, process.cwd()),
    [],
  );
  assert.deepEqual(
    findMissingPaths('bash', { path: 'nope.ts' }, process.cwd()),
    [],
    'bash is not path-checked',
  );
  assert.deepEqual(findMissingPaths('read', { path: 'src/router.ts' }, process.cwd()), []);
  assert.deepEqual(collectPathValues({ file_path: 'a.ts', nested: { path: 'b.ts' }, n: 1 }), [
    'a.ts',
    'b.ts',
  ]);
});

test("ToolGuard sends the tool's own contract with the shape question", async () => {
  const requests: any[] = [];
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      requests.push(request);
      return {
        answers: { invalid_parameters: { type: 'noul', value: 0.95 } },
        model: 'jev-latest',
        elapsedMs: 15,
      };
    },
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(
    piWithTools([
      {
        name: 'read',
        description: 'Read a file from disk',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]),
    mockSystemOne,
    true,
  );

  const res = await guard.checkToolCall('read', { path: 'src/router.ts' }, ctx);

  assert.equal(res.blocked, true);
  assert.equal(res.source, 'system-one');
  assert.match(res.reason ?? '', /hallucinated parameters/);
  assert.deepEqual(Object.keys(requests[0].questions), ['invalid_parameters']);
  assert.equal(requests[0].state.description, 'Read a file from disk');
  assert.equal(requests[0].state.schema.properties.path.type, 'string');
});

test('ToolGuard allows a call whose arguments are well-formed for the tool', async () => {
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: { invalid_parameters: { type: 'noul', value: 0.84 } },
      model: 'jev-latest',
      elapsedMs: 11,
    }),
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);
  const res = await guard.checkToolCall('read', { path: 'src/router.ts' }, ctx);

  assert.equal(res.valid, true);
  assert.equal(res.blocked, false);
  assert.equal(res.probability, 0.84);
});

test('ToolGuard fails open when the shape evaluation throws', async () => {
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async () => {
      throw new Error('offline');
    },
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);
  const res = await guard.checkToolCall('read', { path: 'src/router.ts' }, ctx);
  assert.equal(res.valid, true);
  assert.equal(res.blocked, undefined);
});

test('ToolGuard enhances error results with guidance', async () => {
  const mockSystemOne = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: {
        error_category: { type: 'choice', value: 'missing_file' },
      },
      model: 'jev-latest',
      elapsedMs: 12,
    }),
  } as unknown as SystemOneClient;

  const guard = new ToolGuard(piWithTools(), mockSystemOne, true);
  const hint = await guard.enhanceErrorResult(
    'read',
    { path: 'fake.ts' },
    [{ type: 'text', text: 'ENOENT: no such file or directory' }],
    ctx,
  );

  assert.match(hint ?? '', /Path not found/);
});
