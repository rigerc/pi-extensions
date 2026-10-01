import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/index.js';

interface Command {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface Harness {
  pi: ExtensionAPI;
  /** Registrations in call order, one entry per `registerMcpServer()`. */
  registered: { name: string; config: unknown }[];
  unregistered: string[];
  notifications: { message: string; type?: string }[];
  commands: Map<string, Command>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>;
  /** Run the session_start handler, as a fresh session, resume, or reload would. */
  start(options?: { trusted?: boolean }): Promise<void>;
  /** Run the before_agent_start handler over an empty prompt and return the sections it wrote. */
  sections(options?: { trusted?: boolean }): Promise<Record<string, string>>;
  shutdown(): Promise<void>;
  runCommand(name: string, args?: string): Promise<void>;
}

/** A stand-in for pi that records what the extension registers, reports, and handles. */
function harness(cwd: string): Harness {
  const registered: { name: string; config: unknown }[] = [];
  const unregistered: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const commands = new Map<string, Command>();
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  >();

  const pi = {
    registerMcpServer(name: string, config: unknown) {
      registered.push({ name, config });
    },
    unregisterMcpServer(name: string) {
      unregistered.push(name);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  const context = (trusted: boolean) =>
    ({
      cwd,
      isProjectTrusted: () => trusted,
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type }),
      },
    }) as unknown as ExtensionContext;

  return {
    pi,
    registered,
    unregistered,
    notifications,
    commands,
    handlers,
    async start(options = {}) {
      await handlers.get('session_start')?.({}, context(options.trusted ?? true));
    },
    async sections(options = {}) {
      const event = {
        prompt: 'add an mcp server',
        systemPrompt: '',
        systemPromptOptions: { sections: {} as Record<string, string> },
      };
      await handlers.get('before_agent_start')?.(event, context(options.trusted ?? true));
      return event.systemPromptOptions.sections;
    },
    async shutdown() {
      await handlers.get('session_shutdown')?.({}, context(true));
    },
    async runCommand(name, args = '') {
      await commands.get(name)?.handler(args, context(true));
    },
  };
}

/** An empty project directory, with `.mcp.json` holding the given servers. */
function project(content: Record<string, unknown> = { mcpServers: {} }): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(content));
  return dir;
}

test('test_session_start_registers_the_servers_of_the_project_file', async () => {
  const api = harness(
    project({
      mcpServers: { docs: { url: 'https://example.com/mcp' }, files: { command: 'npx' } },
    }),
  );
  extension(api.pi);

  await api.start();

  assert.deepEqual(
    api.registered.map((entry) => entry.name),
    ['docs', 'files'],
  );
  assert.deepEqual(api.registered[0]?.config, { url: 'https://example.com/mcp' });
  assert.equal(api.notifications.length, 1);
  assert.match(api.notifications[0]?.message ?? '', /registered docs, files/);
});

test('test_session_start_does_not_read_the_file_in_an_untrusted_project', async () => {
  const api = harness(project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
  extension(api.pi);

  await api.start({ trusted: false });

  assert.deepEqual(api.registered, []);
  assert.match(api.notifications[0]?.message ?? '', /not trusted/);
});

test('test_session_start_stays_quiet_without_a_project_file', async () => {
  const api = harness(mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-')));
  extension(api.pi);

  await api.start();

  assert.deepEqual(api.registered, []);
  assert.deepEqual(api.notifications, []);
});

test('test_session_start_keeps_quiet_when_nothing_changed', async () => {
  const api = harness(project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
  extension(api.pi);

  await api.start();
  await api.start();

  assert.equal(api.notifications.length, 1);
});

test('test_second_session_start_drops_a_server_the_file_no_longer_defines', async () => {
  const dir = project({
    mcpServers: { docs: { url: 'https://example.com/mcp' }, files: { command: 'npx' } },
  });
  const api = harness(dir);
  extension(api.pi);

  await api.start();
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }),
  );
  await api.start();

  assert.deepEqual(api.unregistered, ['files']);
  assert.deepEqual(
    api.registered.map((entry) => entry.name),
    ['docs', 'files', 'docs'],
    'the surviving server is registered again for the new session',
  );
});

test('test_session_start_reports_an_entry_it_cannot_use', async () => {
  const dir = project({ mcpServers: { 'my server': { command: 'npx' } } });
  const api = harness(dir);
  extension(api.pi);

  await api.start();

  assert.deepEqual(api.registered, []);
  assert.match(api.notifications[0]?.message ?? '', /invalid server name "my server"/);
});

test('test_mcp_json_command_reports_the_current_state', async () => {
  const api = harness(project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
  extension(api.pi);
  await api.start();
  api.notifications.length = 0;

  await api.runCommand('mcp-json');

  const message = api.notifications[0]?.message ?? '';
  assert.match(message, /^\.mcp\.json: /);
  assert.match(message, /Servers: docs\./);
});

test('test_mcp_json_command_explains_a_missing_file', async () => {
  const api = harness(mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-')));
  extension(api.pi);

  await api.start();
  await api.runCommand('mcp-json');

  assert.match(api.notifications[0]?.message ?? '', /not found/);
});

test('test_shutdown_is_idempotent_and_forgets_registered_names', async () => {
  const api = harness(project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
  extension(api.pi);
  await api.start();

  await api.shutdown();
  await api.shutdown();
  await api.start();

  assert.deepEqual(api.unregistered, [], 'a new runtime keeps nothing to unregister');
  assert.equal(api.notifications.length, 2, 'the next session reports its own registrations');
});

test('test_before_agent_start_tells_the_model_where_the_servers_live', async () => {
  const dir = project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } });
  const api = harness(dir);
  extension(api.pi);
  await api.start();

  const sections = await api.sections();

  const section = sections.dot_mcp_json ?? '';
  assert.match(section, new RegExp(`configured in ${dir}/\\.mcp\\.json`));
  assert.match(section, /Do not run `pi mcp add` and do not write `\.pi\/mcp\.json`/);
  assert.match(section, /Defined now: docs\./);
  assert.equal(Object.keys(sections).length, 1, 'the extension writes no other section');
});

test('test_before_agent_start_asks_for_the_file_when_the_project_has_none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));
  const api = harness(dir);
  extension(api.pi);
  await api.start();

  const section = (await api.sections()).dot_mcp_json ?? '';

  assert.match(section, /It does not exist yet/);
  assert.match(section, new RegExp(`create ${dir}/\\.mcp\\.json`));
});

test('test_before_agent_start_writes_the_section_before_any_session_start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-dot-json-'));
  const api = harness(dir);
  extension(api.pi);

  const section = (await api.sections()).dot_mcp_json ?? '';

  assert.match(section, new RegExp(`configured in ${dir}/\\.mcp\\.json`));
  assert.doesNotMatch(section, /not trusted/, 'an unknown trust state is not reported as untrusted');
});

test('test_before_agent_start_reports_an_untrusted_project', async () => {
  const api = harness(project({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
  extension(api.pi);
  await api.start({ trusted: false });

  const section = (await api.sections({ trusted: false })).dot_mcp_json ?? '';

  assert.match(section, /is not read yet/);
});
