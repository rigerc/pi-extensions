import test from 'node:test';
import assert from 'node:assert/strict';
import type { SystemOneClient } from '../src/system-one.js';
import { PROVIDER_VALUES, SETTING_SPECS } from '../src/config.js';
import {
  ChoiceSubmenu,
  InfoSubmenu,
  TextInputSubmenu,
  buildSettingItems,
  settingsUiTheme,
} from '../src/settings-ui.js';
import { makeSettingsHarness } from './settings-harness.js';

const UI = { accent: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s };
const ENTER = '\r';
const ESCAPE = '\x1b';

function fakeClient(configured = true): SystemOneClient {
  return {
    getProviderInfo: () =>
      configured
        ? {
            provider: 'openrouter',
            label: 'OpenRouter',
            baseURL: 'https://openrouter.ai/api',
            model: 'jev-latest',
            keyOrigin: '$OPENROUTER_API_KEY',
            authMode: 'bearer',
          }
        : null,
    stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
    isConfigured: () => configured,
  } as unknown as SystemOneClient;
}

test('test_rows_are_generated_from_the_registry_for_every_group', () => {
  const h = makeSettingsHarness();
  try {
    const items = buildSettingItems(h.service, fakeClient(), UI, () => {});
    const ids = items.map((item) => item.id);

    for (const spec of SETTING_SPECS) {
      assert.ok(ids.includes(spec.key), `missing row for ${spec.key}`);
    }
    assert.deepEqual(
      ids.filter((id) => !SETTING_SPECS.some((s) => s.key === id)),
      ['status.apiKey', 'status.session', 'action.test', 'action.persist', 'action.reset'],
    );

    for (const item of items) {
      assert.ok(item.label.length > 0, `${item.id} has a label`);
      assert.ok(item.currentValue !== undefined, `${item.id} has a value`);
    }
  } finally {
    h.cleanup();
  }
});

test('test_boolean_and_enum_rows_carry_cycling_values', () => {
  const h = makeSettingsHarness({ user: { autoToolRouting: true, provider: 'typesafe' } });
  try {
    h.service.init();
    const items = buildSettingItems(h.service, fakeClient(), UI, () => {});
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.deepEqual(byId.get('autoToolRouting')!.values, ['on', 'off']);
    assert.equal(byId.get('autoToolRouting')!.currentValue, 'on');
    assert.equal(
      byId.get('autoSkillRouting')!.currentValue,
      'off',
      'the two paths are separate rows',
    );
    assert.equal(byId.get('toolGuard')!.currentValue, 'off');
    assert.deepEqual(byId.get('provider')!.values, [...PROVIDER_VALUES]);
    assert.equal(byId.get('provider')!.currentValue, 'typesafe');
  } finally {
    h.cleanup();
  }
});

test('test_string_rows_open_a_text_submenu_and_empty_base_url_reads_as_provider_default', () => {
  const h = makeSettingsHarness();
  try {
    const items = buildSettingItems(h.service, fakeClient(), UI, () => {});
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(typeof byId.get('model')!.submenu, 'function');
    assert.equal(typeof byId.get('baseURL')!.submenu, 'function');
    assert.equal(byId.get('baseURL')!.currentValue, '(provider default)');
    assert.equal(byId.get('model')!.currentValue, 'jev-latest');
  } finally {
    h.cleanup();
  }
});

test('test_readonly_rows_reflect_unconfigured_state', () => {
  const h = makeSettingsHarness();
  try {
    const items = buildSettingItems(h.service, fakeClient(false), UI, () => {});
    const apiKey = items.find((item) => item.id === 'status.apiKey')!;
    assert.equal(apiKey.currentValue, '(unset)');
  } finally {
    h.cleanup();
  }
});

test('test_readonly_api_key_row_explains_keyless_local_laya', () => {
  const h = makeSettingsHarness();
  const localClient = {
    getProviderInfo: () => ({
      provider: 'laya',
      label: 'Laya (local)',
      baseURL: 'http://127.0.0.1:8000',
      model: 'jev-latest',
      keyOrigin: null,
      authMode: 'none',
    }),
    stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
    isConfigured: () => true,
  } as unknown as SystemOneClient;
  try {
    const items = buildSettingItems(h.service, localClient, UI, () => {});
    const apiKey = items.find((item) => item.id === 'status.apiKey')!;
    assert.equal(apiKey.currentValue, 'not required (local endpoint)');
  } finally {
    h.cleanup();
  }
});

test('test_text_input_submenu_saves_trimmed_value_on_enter', () => {
  let saved: string | undefined | 'never' = 'never';
  const submenu = new TextInputSubmenu('Model', '  jev-latest  ', false, UI, (value) => {
    saved = value;
  });

  submenu.handleInput(ENTER);
  assert.equal(saved, 'jev-latest');
});

test('test_text_input_submenu_rejects_empty_when_required_and_cancels_on_escape', () => {
  let calls = 0;
  const submenu = new TextInputSubmenu('Model', '', false, UI, () => {
    calls += 1;
  });

  submenu.handleInput(ENTER);
  assert.equal(calls, 0, 'empty value must not be saved');
  assert.match(submenu.render(60).join('\n'), /required/);

  submenu.handleInput(ESCAPE);
  assert.equal(calls, 1, 'escape still closes the submenu (with no value)');
});

test('test_text_input_submenu_allows_empty_for_base_url', () => {
  let saved: string | undefined | 'never' = 'never';
  const submenu = new TextInputSubmenu(
    'Base URL',
    'https://openrouter.ai/api',
    true,
    UI,
    (value) => {
      saved = value;
    },
  );

  submenu.handleInput(ENTER);
  assert.equal(saved, 'https://openrouter.ai/api');

  const cleared = new TextInputSubmenu('Base URL', '', true, UI, (value) => {
    saved = value;
  });
  cleared.handleInput(ENTER);
  assert.equal(saved, '', 'empty is a meaningful value for base URL');
});

test('test_choice_submenu_reports_the_choice_without_changing_the_row_value', () => {
  const chosen: string[] = [];
  let closed = 0;
  const submenu = new ChoiceSubmenu(
    'Reset',
    [
      { value: 'session', label: 'Clear session overrides' },
      { value: 'files', label: 'Clear everything' },
    ],
    UI,
    (value) => chosen.push(value),
    () => {
      closed += 1;
    },
  );

  submenu.handleInput(ENTER);
  assert.deepEqual(chosen, ['session'], 'first choice is the default');
  assert.equal(closed, 1);

  submenu.handleInput(ESCAPE);
  assert.deepEqual(chosen, ['session'], 'escape performs no action');
  assert.equal(closed, 2);
});

test('test_choice_submenu_navigates_with_arrows_and_wraps', () => {
  const chosen: string[] = [];
  const submenu = new ChoiceSubmenu(
    'Persist',
    [
      { value: 'user', label: 'user' },
      { value: 'project', label: 'project' },
      { value: 'both', label: 'both' },
    ],
    UI,
    (value) => chosen.push(value),
    () => {},
  );

  submenu.handleInput('\x1b[A'); // up from index 0 wraps to the last
  submenu.handleInput(ENTER);
  assert.deepEqual(chosen, ['both']);
});

test('test_info_submenu_closes_on_enter_or_escape', () => {
  let closed = 0;
  const submenu = new InfoSubmenu('Status', ['  requests: 0'], () => {
    closed += 1;
  });

  assert.match(submenu.render(60).join('\n'), /requests: 0/);
  submenu.handleInput(ENTER);
  submenu.handleInput(ESCAPE);
  assert.equal(closed, 2);
});

test('test_settings_ui_theme_adapts_a_pi_theme', () => {
  const piTheme = {
    fg: (color: string, text: string) => `<${color}>${text}`,
    bold: (text: string) => `*${text}*`,
  };
  const ui = settingsUiTheme(piTheme);
  assert.equal(ui.accent('x'), '<accent>x');
  assert.equal(ui.dim('x'), '<dim>x');
  assert.equal(ui.bold('x'), '*x*');
});
