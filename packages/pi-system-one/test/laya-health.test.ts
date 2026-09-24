import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SystemOneClient } from '../src/system-one.js';

test('Laya health uses the effective base URL, validates the server, and leaves inference stats alone', async () => {
  let status = 200;
  let body = JSON.stringify({ status: 'ok', loaded: ['english'], device: 'cuda' });
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new SystemOneClient();
    client.setProviderOverrides({
      provider: 'laya',
      baseURL: `http://127.0.0.1:${address.port}/prefix/`,
    });

    const healthy = await client.checkLayaHealth();
    assert.deepEqual(paths, ['GET /prefix/health']);
    assert.equal(healthy.endpoint, `http://127.0.0.1:${address.port}/prefix/health`);
    assert.deepEqual(healthy.loaded, ['english']);
    assert.equal(healthy.device, 'cuda');
    assert.equal(client.getLayaHealthStatus()?.result, healthy);
    assert.equal(client.stats.requestsCount, 0);
    assert.equal(client.stats.totalTokens, 0);

    status = 503;
    await assert.rejects(client.checkLayaHealth(), /HTTP 503/);
    assert.match(client.getLayaHealthStatus()?.error ?? '', /HTTP 503/);

    status = 200;
    body = '{invalid';
    await assert.rejects(client.checkLayaHealth(), /JSON/);
    body = JSON.stringify({ status: 'starting', loaded: [], device: 'cpu' });
    await assert.rejects(client.checkLayaHealth(), /expected status: ok/);
    body = JSON.stringify({ status: 'ok', loaded: 'english', device: 'cpu' });
    await assert.rejects(client.checkLayaHealth(), /invalid loaded models/);

    client.setProviderOverrides({
      provider: 'laya',
      baseURL: `http://127.0.0.1:${address.port}/other`,
    });
    assert.equal(client.getLayaHealthStatus(), null, 'an old endpoint result is not shown');
    client.setProviderOverrides({ provider: 'typesafe' });
    await assert.rejects(client.checkLayaHealth(), /Select Laya/);
    assert.equal(client.getLayaHealthStatus(), null);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Laya health aborts a stalled request after the configured timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, options: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })) as typeof fetch;
  try {
    const client = new SystemOneClient();
    client.setProviderOverrides({ provider: 'laya' });
    await assert.rejects(client.checkLayaHealth(), /timeout|abort/i);
    assert.ok(client.getLayaHealthStatus()?.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
