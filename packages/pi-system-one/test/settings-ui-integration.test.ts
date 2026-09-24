import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type { SystemOneClient } from '../src/system-one.js';
import { SettingsService, type ModeControllers } from '../src/settings.js';
import { registerSystemOneSettingsCommand } from '../src/settings-ui.js';

// getSettingsListTheme() reads the process-wide pi theme; a real session initialises it
// before any command runs. Doing the same here lets the real SettingsList render.
initTheme('dark');

const ENTER = '\r';
const ESCAPE = '\x1b';
const DOWN = '\x1b[B';
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (line: string): string => line.replace(ANSI, '');

/** Row order follows SETTING_SPECS: the two auto paths, then autoModel, … */
const ROW = {
  autoToolRouting: 0,
  autoSkillRouting: 1,
  autoModel: 2,
  agentOrchestration: 3,
  toolGuard: 4,
  compaction: 5,
  systemOneTools: 6,
  provider: 7,
  baseURL: 8,
  model: 9,
};

function openSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-one-ui-'));
  let activeTools = ['read'];
  const appended: unknown[] = [];
  const applied: Record<string, boolean> = {};

  const host: any = {
    getFlag: () => undefined,
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    appendEntry: (_type: string, data: unknown) => {
      appended.push(data);
    },
  };

  const probe = (name: string) => ({
    setEnabled(value: boolean) {
      applied[name] = value;
    },
  });
  const auto = {
    toolsEnabled: false,
    skillsEnabled: false,
    setToolsEnabled(value: boolean) {
      auto.toolsEnabled = value;
    },
    setSkillsEnabled(value: boolean) {
      auto.skillsEnabled = value;
    },
  };
  const modes = {
    auto,
    autoModel: probe('autoModel'),
    agents: probe('agents'),
    toolGuard: probe('toolGuard'),
    compactor: probe('compactor'),
  } as unknown as ModeControllers;

  const providerOverrides: Array<Record<string, unknown>> = [];
  const systemOneClient = {
    setProviderOverrides: (overrides: Record<string, unknown>) => {
      providerOverrides.push({ ...overrides });
    },
    getProviderInfo: () => {
      const isLaya = providerOverrides.at(-1)?.provider === 'laya';
      return {
        provider: isLaya ? 'laya' : 'openrouter',
        label: isLaya ? 'Laya (local)' : 'OpenRouter',
        baseURL: isLaya ? 'http://127.0.0.1:8000' : 'https://openrouter.ai/api',
        model: 'jev-latest',
        keyOrigin: isLaya ? null : '$OPENROUTER_API_KEY',
        authMode: isLaya ? 'none' : 'bearer',
      };
    },
    stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
    isConfigured: () => true,
  } as unknown as SystemOneClient;

  const settings = new SettingsService(host, systemOneClient, modes, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    userPath: path.join(dir, 'user.json'),
    projectPath: path.join(dir, 'project.json'),
  });
  settings.init();

  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const commands = new Map<string, any>();
  registerSystemOneSettingsCommand(
    {
      registerCommand: (name: string, options: any) => {
        commands.set(name, options);
        if (name === 'system-one-settings') handler = options.handler;
      },
    } as any,
    settings,
    systemOneClient,
  );

  const notifications: string[] = [];
  let closed = 0;
  let renders = 0;
  let component: any;

  const ctx: any = {
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async (factory: any) => {
        component = factory(
          {
            requestRender: () => {
              renders += 1;
            },
          },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {
            closed += 1;
          },
        );
      },
    },
  };

  return {
    settings,
    systemOneClient,
    applied,
    auto,
    appended,
    providerOverrides,
    notifications,
    commands,
    activeTools: () => [...activeTools],
    open: async () => {
      assert.ok(handler, 'system-one-settings must be registered');
      await handler!('', ctx);
      assert.ok(component, 'ctx.ui.custom must produce a component');
      return component;
    },
    closed: () => closed,
    renders: () => renders,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('test_system_one_settings_command_registers_and_renders_every_group', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    const text = component.render(90).map(strip).join('\n');

    assert.match(text, /pi-system-one settings/);
    assert.match(text, /Modes · Auto tool routing/);
    assert.match(text, /Modes · Auto skill routing/, 'tools and skills are separate rows');
    assert.match(text, /Provider · Provider/);
    assert.match(text, /Status · Session/);
    assert.match(text, /Actions · Test connectivity/);
    assert.match(text, /Actions · Check Laya health/);
    assert.match(text, /Type to search/, 'search is enabled');
    assert.equal(h.commands.has('jev-settings'), false);
  } finally {
    h.cleanup();
  }
});

test('test_space_toggles_a_mode_row_and_applies_it_immediately', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.toolGuard; i++) component.handleInput(DOWN);
    component.handleInput(' ');

    assert.equal(h.settings.values.toolGuard, true);
    assert.equal(h.applied.toolGuard, true, 'live mode object updated');
    assert.deepEqual(h.appended.at(-1), { toolGuard: true }, 'session entry written');
    assert.ok(h.renders() > 0, 'the list requests a re-render');

    component.handleInput(' ');
    assert.equal(h.settings.values.toolGuard, false, 'toggling again turns it off');
  } finally {
    h.cleanup();
  }
});

test('test_auto_tool_and_skill_rows_toggle_independently', async () => {
  const h = openSettings();
  try {
    const component = await h.open();

    component.handleInput(' '); // row 0 = auto tool routing
    assert.equal(h.settings.values.autoToolRouting, true);
    assert.equal(h.settings.values.autoSkillRouting, false, 'skill path untouched');
    assert.equal(h.auto.toolsEnabled, true, 'live AutoSystemOne tool path enabled');
    assert.equal(h.auto.skillsEnabled, false, 'live AutoSystemOne skill path still off');

    component.handleInput(DOWN);
    component.handleInput(' '); // row 1 = auto skill routing
    assert.equal(h.settings.values.autoToolRouting, true);
    assert.equal(h.settings.values.autoSkillRouting, true);

    component.handleInput('\x1b[A');
    component.handleInput(' '); // turn the tool path back off
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.settings.values.autoSkillRouting, true, 'skill path stays on');
  } finally {
    h.cleanup();
  }
});

test('test_system_one_tools_row_updates_the_active_tool_set', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.systemOneTools; i++) component.handleInput(DOWN);
    component.handleInput(' ');

    assert.equal(h.settings.values.systemOneTools, true);
    assert.ok(h.activeTools().includes('system_one_find_tools'));
    assert.ok(h.activeTools().includes('read'), 'existing tools preserved');
  } finally {
    h.cleanup();
  }
});

test('test_provider_row_cycles_through_the_allowed_values', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.provider; i++) component.handleInput(DOWN);

    component.handleInput(' ');
    assert.equal(h.settings.values.provider, 'typesafe', 'auto → typesafe');
    component.handleInput(' ');
    assert.equal(h.settings.values.provider, 'openrouter');
    component.handleInput(' ');
    assert.equal(h.settings.values.provider, 'laya');
    assert.deepEqual(h.providerOverrides.at(-1), {
      provider: 'laya',
      baseURL: '',
      model: 'jev-latest',
    });
    const rendered = component.render(90).map(strip).join('\n');
    assert.match(rendered, /Provider · API key\s+not required \(local endpoint\)/);
  } finally {
    h.cleanup();
  }
});

test('test_text_submenu_edits_base_url_through_the_real_input_component', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.baseURL; i++) component.handleInput(DOWN);
    component.handleInput(ENTER);

    const submenuText = component.render(90).map(strip).join('\n');
    assert.match(submenuText, /Provider · Base URL/);
    assert.match(submenuText, /enter save · esc cancel/);

    for (const ch of 'https://example.test/api') component.handleInput(ch);
    component.handleInput(ENTER);

    assert.equal(h.settings.values.baseURL, 'https://example.test/api');
    assert.equal(
      (h.providerOverrides.at(-1) as Record<string, unknown>).baseURL,
      'https://example.test/api',
    );
    assert.deepEqual(h.appended.at(-1), { baseURL: 'https://example.test/api' });
  } finally {
    h.cleanup();
  }
});

test('test_escape_on_the_list_closes_the_overlay', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    assert.equal(h.closed(), 0);
    component.handleInput(ESCAPE);
    assert.equal(h.closed(), 1);
  } finally {
    h.cleanup();
  }
});

test('test_escape_inside_a_submenu_closes_only_the_submenu', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.baseURL; i++) component.handleInput(DOWN);
    component.handleInput(ENTER);
    component.handleInput(ESCAPE);

    assert.equal(h.closed(), 0, 'the overlay stays open');
    assert.equal(h.settings.values.baseURL, '', 'no value was saved');
    assert.match(
      component.render(90).map(strip).join('\n'),
      /Modes · Auto tool routing/,
      'back to the list',
    );
  } finally {
    h.cleanup();
  }
});
