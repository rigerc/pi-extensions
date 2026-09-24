import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { SystemOneClient } from '../src/system-one.js';
import { SettingsService, type ModeControllers } from '../src/settings.js';
import { registerSystemOneSettingsCommand } from '../src/settings-ui.js';

// getSettingsListTheme() reads the process-wide pi theme; a real session initialises it
// before any command runs. Doing the same here lets the real SettingsList render.
initTheme('dark');

const ENTER = '\r';
const ESCAPE = '\x1b';
const DOWN = '\x1b[B';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const SAVE = '\x13';
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (line: string): string => line.replace(ANSI, '');

/** Row positions within the Modes and Provider tabs. */
const ROW = {
  autoToolRouting: 0,
  autoSkillRouting: 1,
  autoModel: 2,
  agentOrchestration: 3,
  toolGuard: 4,
  compaction: 5,
  systemOneTools: 6,
  provider: 0,
  baseURL: 1,
  model: 2,
};

function goToTab(component: any, index: number): void {
  for (let i = 0; i < index; i++) component.handleInput(TAB);
}

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
    dir,
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
    assert.match(text, /\[Modes\]/);
    assert.match(text, /Auto tool routing/);
    assert.match(text, /Auto skill routing/, 'tools and skills are separate rows');
    assert.match(text, /Type to search/, 'search is enabled');
    assert.match(text, /Ctrl\+S Save/);
    assert.match(text, /Draft changes/);
    goToTab(component, 1);
    assert.match(component.render(90).map(strip).join('\n'), /\[Provider\].*Base URL/s);
    goToTab(component, 1);
    assert.match(component.render(90).map(strip).join('\n'), /\[Status\].*Session/s);
    goToTab(component, 1);
    assert.match(component.render(90).map(strip).join('\n'), /\[Actions\].*Test connectivity/s);
    assert.match(component.render(90).map(strip).join('\n'), /Check Laya health/);
    assert.equal(h.commands.has('jev-settings'), false);
  } finally {
    h.cleanup();
  }
});

test('test_tabs_keep_search_and_selection_and_shift_tab_moves_back', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (const ch of 'guard') component.handleInput(ch);
    let output = component.render(80).map(strip).join('\n');
    assert.match(output, /Tool guard/);
    assert.doesNotMatch(output, /Auto tool routing/);

    component.handleInput(TAB);
    for (const ch of 'model') component.handleInput(ch);
    output = component.render(80).map(strip).join('\n');
    assert.match(output, /\[Provider\]/);
    assert.match(output, /Model/);
    assert.doesNotMatch(output, /Base URL/);

    component.handleInput(SHIFT_TAB);
    output = component.render(80).map(strip).join('\n');
    assert.match(output, /\[Modes\]/);
    assert.match(output, /Tool guard/);
    assert.doesNotMatch(output, /Auto tool routing/);
    component.handleInput(ENTER);
    assert.equal(h.settings.values.toolGuard, false, 'search edit is still a draft');
    assert.match(component.render(80).map(strip).join('\n'), /Unsaved\s+draft/);

    component.handleInput(TAB);
    assert.match(component.render(80).map(strip).join('\n'), /Model/);
  } finally {
    h.cleanup();
  }
});

test('test_tab_does_not_leave_an_open_text_editor', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    component.handleInput(TAB);
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    component.handleInput(TAB);
    component.handleInput(SAVE);
    const output = component.render(80).map(strip).join('\n');
    assert.match(output, /\[Provider\]/);
    assert.match(output, /Provider · Base URL/);
    assert.doesNotMatch(output, /\[Status\]/);
    assert.ok(!fs.existsSync(h.settings.paths().user));
    component.handleInput(ESCAPE);
    assert.equal(h.closed(), 0);
  } finally {
    h.cleanup();
  }
});

test('test_reverting_a_draft_change_clears_unsaved_state', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    component.handleInput(' ');
    assert.match(component.render(80).map(strip).join('\n'), /1 unsaved/);
    component.handleInput(' ');
    const output = component.render(80).map(strip).join('\n');
    assert.match(output, /0 unsaved/);
    assert.equal(h.settings.values.autoToolRouting, false);
    component.handleInput(ESCAPE);
    assert.equal(h.closed(), 1);
    assert.ok(!fs.existsSync(h.settings.paths().user));
  } finally {
    h.cleanup();
  }
});

test('test_save_commits_all_draft_changes_to_user_file_once', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    component.handleInput(' ');
    component.handleInput(DOWN);
    component.handleInput(' ');
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.auto.toolsEnabled, false);
    assert.equal(h.appended.length, 0);
    assert.ok(!fs.existsSync(h.settings.paths().user));

    component.handleInput(SAVE);
    assert.equal(h.closed(), 1);
    assert.equal(h.settings.values.autoToolRouting, true);
    assert.equal(h.settings.values.autoSkillRouting, true);
    assert.equal(h.auto.toolsEnabled, true);
    assert.deepEqual(h.appended, [{ autoToolRouting: true, autoSkillRouting: true }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.settings.paths().user, 'utf8')), {
      version: 1,
      autoToolRouting: true,
      autoSkillRouting: true,
    });
    assert.ok(!fs.existsSync(h.settings.paths().project));
    assert.match(h.notifications.at(-1)!, /Saved settings to/);
  } finally {
    h.cleanup();
  }
});

test('test_escape_confirms_discard_without_changing_live_settings_or_files', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    component.handleInput(' ');
    component.handleInput(ESCAPE);
    assert.match(component.render(80).map(strip).join('\n'), /Discard unsaved changes/);
    assert.equal(h.closed(), 0);
    component.handleInput(ESCAPE);
    assert.match(component.render(80).map(strip).join('\n'), /Auto tool routing\s+on/);
    component.handleInput(ESCAPE);
    component.handleInput(ENTER);
    assert.equal(h.closed(), 1);
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.appended.length, 0);
    assert.ok(!fs.existsSync(h.settings.paths().user));
  } finally {
    h.cleanup();
  }
});

test('test_failed_save_keeps_the_draft_open_and_does_not_apply_it', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    fs.mkdirSync(h.settings.paths().user);
    component.handleInput(' ');
    component.handleInput(SAVE);
    assert.match(component.render(90).map(strip).join('\n'), /Could not save settings/);
    assert.equal(h.closed(), 0);
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.appended.length, 0);
    assert.match(component.render(90).map(strip).join('\n'), /1 unsaved/);
  } finally {
    h.cleanup();
  }
});

test('test_narrow_terminal_keeps_every_rendered_line_within_width', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    component.handleInput(' ');
    assert.match(component.render(32).map(strip).join('\n'), /Ctrl\+S Save · Esc Discard/);
    for (let tab = 0; tab < 4; tab++) {
      for (const line of component.render(32)) {
        assert.ok(visibleWidth(line) <= 32, `too wide: ${strip(line)}`);
      }
      component.handleInput(TAB);
    }
  } finally {
    h.cleanup();
  }
});

test('test_space_toggles_a_mode_row_in_the_draft', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    for (let i = 0; i < ROW.toolGuard; i++) component.handleInput(DOWN);
    component.handleInput(' ');

    assert.equal(h.settings.values.toolGuard, false);
    assert.equal(h.applied.toolGuard, false, 'live mode object unchanged');
    assert.equal(h.appended.length, 0, 'no session entry before save');
    assert.ok(h.renders() > 0, 'the list requests a re-render');
    assert.match(component.render(90).map(strip).join('\n'), /Tool guard\s+on/);

    component.handleInput(' ');
    assert.match(component.render(90).map(strip).join('\n'), /Tool guard\s+off/);
  } finally {
    h.cleanup();
  }
});

test('test_auto_tool_and_skill_rows_toggle_independently', async () => {
  const h = openSettings();
  try {
    const component = await h.open();

    component.handleInput(' '); // row 0 = auto tool routing
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.settings.values.autoSkillRouting, false);
    assert.equal(h.auto.toolsEnabled, false);
    assert.equal(h.auto.skillsEnabled, false);

    component.handleInput(DOWN);
    component.handleInput(' '); // row 1 = auto skill routing
    assert.match(component.render(90).map(strip).join('\n'), /Auto skill routing\s+on/);

    component.handleInput('\x1b[A');
    component.handleInput(' '); // turn the tool path back off
    component.handleInput(SAVE);
    assert.equal(h.settings.values.autoToolRouting, false);
    assert.equal(h.settings.values.autoSkillRouting, true, 'skill path saved');
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

    assert.equal(h.settings.values.systemOneTools, false);
    assert.ok(!h.activeTools().includes('system_one_find_tools'));
    component.handleInput(SAVE);
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
    goToTab(component, 1);
    for (let i = 0; i < ROW.provider; i++) component.handleInput(DOWN);

    component.handleInput(' ');
    assert.match(component.render(90).map(strip).join('\n'), /Provider\s+typesafe/);
    component.handleInput(' ');
    assert.match(component.render(90).map(strip).join('\n'), /Provider\s+openrouter/);
    component.handleInput(' ');
    assert.equal(h.settings.values.provider, 'auto', 'live provider stays unchanged');
    component.handleInput(SAVE);
    assert.equal(h.settings.values.provider, 'laya');
    assert.deepEqual(h.providerOverrides.at(-1), {
      provider: 'laya',
      baseURL: '',
      model: 'jev-latest',
    });
    const reopened = await h.open();
    goToTab(reopened, 1);
    const rendered = reopened.render(90).map(strip).join('\n');
    assert.match(rendered, /API key\s+not required \(local endpoint\)/);
  } finally {
    h.cleanup();
  }
});

test('test_text_submenu_edits_base_url_through_the_real_input_component', async () => {
  const h = openSettings();
  try {
    const component = await h.open();
    goToTab(component, 1);
    for (let i = 0; i < ROW.baseURL; i++) component.handleInput(DOWN);
    component.handleInput(ENTER);

    const submenuText = component.render(90).map(strip).join('\n');
    assert.match(submenuText, /Provider · Base URL/);
    assert.match(submenuText, /Enter keep edit · Esc cancel/);

    for (const ch of 'https://example.test/api') component.handleInput(ch);
    component.handleInput(ENTER);

    assert.equal(h.settings.values.baseURL, '', 'text edit remains in the draft');
    component.handleInput(SAVE);
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
    goToTab(component, 1);
    for (let i = 0; i < ROW.baseURL; i++) component.handleInput(DOWN);
    component.handleInput(ENTER);
    component.handleInput(ESCAPE);

    assert.equal(h.closed(), 0, 'the overlay stays open');
    assert.equal(h.settings.values.baseURL, '', 'no value was saved');
    assert.match(component.render(90).map(strip).join('\n'), /Base URL/, 'back to the list');
  } finally {
    h.cleanup();
  }
});
