import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOT_MCP_FILE, loadDotMcpServers, parseDotMcpJson } from '../src/config.js';

const PATH = '/project/.mcp.json';

function parse(json: unknown) {
  return parseDotMcpJson(typeof json === 'string' ? json : JSON.stringify(json), PATH);
}

test('test_parse_reads_stdio_and_http_entries_in_file_order', () => {
  const result = parse({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
    },
  });

  assert.deepEqual(
    result.servers.map((server) => server.name),
    ['filesystem', 'docs'],
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.found, true);
  assert.deepEqual(result.servers[0]?.config, {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  });
  assert.deepEqual(result.servers[1]?.config, {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
  });
});

test('test_parse_keeps_pi_specific_fields_for_pi_to_validate', () => {
  const result = parse({
    mcpServers: {
      github: {
        url: 'https://example.com/mcp',
        exposure: 'deferred',
        toolExposure: { search_code: 'direct', 'delete_*': 'hidden' },
        enabled: false,
        timeout: 30,
        description: 'Code search',
      },
    },
  });

  assert.equal(result.servers.length, 1);
  assert.deepEqual(result.servers[0]?.config, {
    url: 'https://example.com/mcp',
    exposure: 'deferred',
    toolExposure: { search_code: 'direct', 'delete_*': 'hidden' },
    enabled: false,
    timeout: 30,
    description: 'Code search',
  });
});

test('test_parse_ignores_other_top_level_keys_of_other_mcp_clients', () => {
  const result = parse({ inputs: [{ id: 'token', type: 'promptString' }], mcpServers: {} });

  assert.deepEqual(result.servers, []);
  assert.deepEqual(result.errors, []);
});

test('test_parse_reports_a_file_without_a_server_list_as_empty', () => {
  assert.deepEqual(parse({}).servers, []);
  assert.deepEqual(parse({}).errors, []);
  assert.deepEqual(parse({ mcpServers: {} }).servers, []);
});

test('test_parse_notes_that_auto_enable_codemode_is_not_ours', () => {
  const result = parse({ autoEnableCodemode: false, mcpServers: {} });

  assert.deepEqual(result.errors, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0] ?? '', /autoEnableCodemode is ignored/);
});

test('test_parse_reports_broken_json_with_the_file_path', () => {
  const result = parse('{ "mcpServers": ');

  assert.deepEqual(result.servers, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /^\/project\/\.mcp\.json: /);
});

test('test_parse_rejects_a_document_that_is_not_a_server_list', () => {
  for (const document of ['[]', '"text"', '{ "mcpServers": [] }', '{ "mcpServers": "x" }']) {
    const result = parse(document);
    assert.deepEqual(result.servers, [], document);
    assert.match(result.errors[0] ?? '', /expected an object with a "mcpServers" object/, document);
  }
});

test('test_parse_rejects_names_pi_could_not_use_as_a_namespace', () => {
  const result = parse({ mcpServers: { 'my server': { command: 'npx' } } });

  assert.deepEqual(result.servers, []);
  assert.match(result.errors[0] ?? '', /invalid server name "my server"/);
});

test('test_parse_rejects_names_that_would_share_a_namespace', () => {
  const result = parse({
    mcpServers: {
      'my-server': { command: 'npx' },
      my_server: { command: 'npx' },
    },
  });

  assert.deepEqual(
    result.servers.map((server) => server.name),
    ['my-server'],
  );
  assert.match(result.errors[0] ?? '', /server "my_server" conflicts with "my-server"/);
});

test('test_parse_rejects_entries_that_are_not_objects', () => {
  const result = parse({ mcpServers: { docs: 'https://example.com/mcp' } });

  assert.deepEqual(result.servers, []);
  assert.match(result.errors[0] ?? '', /server "docs" must be an object/);
});

test('test_parse_rejects_auth_because_a_repository_must_not_pick_the_credential', () => {
  const result = parse({
    mcpServers: { sentry: { url: 'https://mcp.sentry.dev/mcp', auth: { provider: 'github' } } },
  });

  assert.deepEqual(result.servers, []);
  assert.match(result.errors[0] ?? '', /auth is only allowed in ~\/\.pi\/agent\/mcp\.json/);
});

test('test_load_reads_the_file_from_disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));
  const path = join(dir, DOT_MCP_FILE);
  writeFileSync(path, JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));

  const result = loadDotMcpServers(path);

  assert.equal(result.found, true);
  assert.deepEqual(
    result.servers.map((server) => server.name),
    ['docs'],
  );
});

test('test_load_treats_a_missing_file_as_no_servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));

  assert.deepEqual(loadDotMcpServers(join(dir, DOT_MCP_FILE)), {
    found: false,
    servers: [],
    errors: [],
    notes: [],
  });
});

test('test_load_reports_a_path_that_cannot_be_read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));

  // A directory where the file belongs: the read fails and the reason is reported.
  const result = loadDotMcpServers(dir);

  assert.equal(result.found, true);
  assert.equal(result.servers.length, 0);
  assert.equal(result.errors.length, 1);
});
