import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOT_MCP_SECTION,
  renderDotMcpSection,
  type DotMcpPromptState,
} from '../src/prompt.js';

function state(overrides: Partial<DotMcpPromptState> = {}): DotMcpPromptState {
  return {
    path: '/repo/.mcp.json',
    found: true,
    started: true,
    trusted: true,
    registered: ['docs'],
    ...overrides,
  };
}

test('test_section_name_is_a_valid_prompt_section', () => {
  assert.match(DOT_MCP_SECTION, /^[a-z][a-z0-9_-]*$/);
});

test('test_section_names_the_file_and_forbids_the_other_two_places', () => {
  const section = renderDotMcpSection(state());

  assert.match(section, /MCP servers for this project are configured in \/repo\/\.mcp\.json/);
  assert.match(section, /`mcpServers` shape/);
  assert.match(section, /Do not run `pi mcp add` and do not write `\.pi\/mcp\.json`/);
  assert.match(section, /Changes apply after `\/reload`/);
});

test('test_section_lists_the_servers_the_file_defines', () => {
  assert.match(renderDotMcpSection(state({ registered: ['docs', 'files'] })), /Defined now: docs, files\./);
  assert.match(renderDotMcpSection(state({ registered: [] })), /Defined now: none\./);
});

test('test_section_collapses_a_long_server_list', () => {
  const registered = Array.from({ length: 11 }, (_, index) => `server${index}`);

  const section = renderDotMcpSection(state({ registered }));

  assert.match(section, /Defined now: server0, server1, .*server7 and 3 more\./);
  assert.ok(section.length < 900, `section stays short, was ${section.length} chars`);
});

test('test_section_asks_for_the_file_when_it_is_missing', () => {
  const section = renderDotMcpSection(state({ found: false, registered: [] }));

  assert.match(section, /It does not exist yet: create \/repo\/\.mcp\.json/);
  assert.doesNotMatch(section, /Defined now/);
});

test('test_section_mentions_trust_only_once_it_is_known', () => {
  assert.doesNotMatch(
    renderDotMcpSection(state({ started: false, trusted: false })),
    /not trusted/,
    'before a session start the trust state is unknown, not false',
  );
  assert.match(
    renderDotMcpSection(state({ trusted: false })),
    /This project is not trusted, so \/repo\/\.mcp\.json is not read yet/,
  );
});

test('test_section_falls_back_to_the_bare_file_name', () => {
  assert.match(renderDotMcpSection(state({ path: '' })), /configured in \.mcp\.json/);
});