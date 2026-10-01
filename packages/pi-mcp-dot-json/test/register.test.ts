import test from 'node:test';
import assert from 'node:assert/strict';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { DotMcpServer } from '../src/config.js';
import { syncDotMcpServers, type McpRegistrar } from '../src/register.js';

interface Recorder extends McpRegistrar {
  registered: { name: string; config: McpServerConfig }[];
  unregistered: string[];
}

function recorder(options: { reject?: (name: string) => boolean } = {}): Recorder {
  const state: Recorder = {
    registered: [],
    unregistered: [],
    registerMcpServer(name, config) {
      if (options.reject?.(name)) {
        throw new Error(
          `Invalid MCP server registered by extension "/ext/index.ts": ${name} is unknown`,
        );
      }
      state.registered.push({ name, config });
    },
    unregisterMcpServer(name) {
      state.unregistered.push(name);
    },
  };
  return state;
}

function server(name: string, config: McpServerConfig = { command: 'npx' }): DotMcpServer {
  return { name, config };
}

test('test_sync_registers_every_entry_in_file_order', () => {
  const pi = recorder();

  const outcome = syncDotMcpServers(
    pi,
    [server('docs', { url: 'https://example.com/mcp' }), server('files')],
    [],
  );

  assert.deepEqual(outcome.registered, ['docs', 'files']);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(
    pi.registered.map((entry) => entry.name),
    ['docs', 'files'],
  );
  assert.deepEqual(pi.registered[0]?.config, { url: 'https://example.com/mcp' });
});

test('test_sync_unregisters_names_the_file_no_longer_defines', () => {
  const pi = recorder();

  const outcome = syncDotMcpServers(pi, [server('docs')], ['files', 'docs', 'old']);

  assert.deepEqual(outcome.removed, ['files', 'old']);
  assert.deepEqual(pi.unregistered, ['files', 'old']);
  assert.deepEqual(outcome.registered, ['docs']);
});

test('test_sync_reports_a_refused_entry_and_registers_the_rest', () => {
  const pi = recorder({ reject: (name) => name === 'broken' });

  const outcome = syncDotMcpServers(pi, [server('broken'), server('docs')], []);

  assert.deepEqual(outcome.registered, ['docs']);
  assert.equal(outcome.errors.length, 1);
  assert.equal(
    outcome.errors[0],
    'server "broken": broken is unknown',
    'the pi wrapper is stripped so the message names the server once',
  );
});

test('test_sync_reports_a_failed_unregistration_without_skipping_the_rest', () => {
  const pi = recorder();
  pi.unregisterMcpServer = () => {
    throw new Error('server "files" was already removed');
  };

  const outcome = syncDotMcpServers(pi, [server('docs')], ['files']);

  assert.equal(outcome.errors[0], 'server "files": server "files" was already removed');
  assert.deepEqual(outcome.registered, ['docs']);
});

test('test_sync_without_entries_registers_nothing', () => {
  const pi = recorder();

  const outcome = syncDotMcpServers(pi, [], []);

  assert.deepEqual(outcome, { registered: [], removed: [], errors: [] });
  assert.deepEqual(pi.registered, []);
});
