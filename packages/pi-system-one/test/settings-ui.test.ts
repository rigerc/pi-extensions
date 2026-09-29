import test from 'node:test';
import assert from 'node:assert/strict';
import type { SystemOneClient } from '../src/system-one.js';
import {
  PROVIDER_VALUES,
  SETTING_DEFAULTS,
  SETTING_SPECS,
  type SystemOneSettings,
} from '../src/config.js';
import {
  InfoSubmenu,
  ProviderSubmenu,
  TextInputSubmenu,
  buildProviderGroups,
  buildSettingItems,
  loadProviderCatalog,
  settingsUiTheme,
  type ProviderCatalog,
} from '../src/settings-ui.js';
import { makeSettingsHarness } from './settings-harness.js';

const plain = (s: string) => s;
const UI = {
  accent: plain,
  dim: plain,
  muted: plain,
  success: plain,
  warning: plain,
  error: plain,
  bold: plain,
};
const ENTER = '\r';
const ESCAPE = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';

function fakeClient(configured = true): SystemOneClient {
  return {
    listAvailable: async () => [
      {
        provider: 'typesafe',
        id: 'jev-latest',
        name: 'Jev Latest',
        api: 'typesafe-system-one',
      },
      {
        provider: 'openrouter',
        id: 'typesafe/jev-1.13',
        name: 'Jev 1.13',
        api: 'typesafe-system-one',
      },
    ],
    getProviderInfo: async () =>
      configured
        ? {
            provider: 'typesafe',
            label: 'TypeSafe',
            model: 'jev-latest',
            api: 'typesafe-system-one',
            auth: 'ok',
            source: 'settings',
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
      ['status.auth', 'status.session', 'status.herdsman', 'action.test'],
    );

    for (const item of items) {
      assert.ok(item.label.length > 0, `${item.id} has a label`);
      assert.ok(item.currentValue !== undefined, `${item.id} has a value`);
    }
  } finally {
    h.cleanup();
  }
});

test('test_readonly_herdsman_row_reports_detection_and_the_gate', () => {
  const h = makeSettingsHarness({ user: { agentOrchestration: true } });
  try {
    h.service.init();
    const build = (herdsman: {
      available: boolean;
      managedAgent: boolean;
      toolActive: boolean;
    }) =>
      buildSettingItems(
        h.service,
        fakeClient(),
        UI,
        () => {},
        () => {},
        { ...h.service.values },
        { models: [], info: null },
        herdsman,
      ).find((item) => item.id === 'status.herdsman')!;

    const detected = build({ available: true, managedAgent: false, toolActive: true });
    assert.equal(detected.currentValue, 'detected');
    const output = detected.submenu!('', () => {}).render(90).join('\n');
    assert.match(output, /agent_delegate:\s+registered/);
    assert.match(output, /orchestration:\s+on/);
    assert.match(output, /tool active:\s+yes/);
    assert.match(output, /herdr/);
    assert.match(output, /install-herdsman/);

    assert.equal(
      build({ available: false, managedAgent: false, toolActive: false }).currentValue,
      'not detected',
    );
    assert.equal(
      build({ available: true, managedAgent: true, toolActive: false }).currentValue,
      'managed agent',
    );
  } finally {
    h.cleanup();
  }
});

test('test_boolean_rows_cycle_and_the_provider_row_opens_the_catalog', () => {
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
    assert.equal(byId.get('provider')!.values, undefined, 'the provider row is a catalog, not a fixed enum');
    assert.equal(typeof byId.get('provider')!.submenu, 'function');
    assert.equal(byId.get('provider')!.currentValue, 'typesafe');
  } finally {
    h.cleanup();
  }
});

test('test_string_rows_open_a_text_submenu_and_empty_temperature_reads_as_provider_default', () => {
  const h = makeSettingsHarness();
  try {
    const items = buildSettingItems(h.service, fakeClient(), UI, () => {});
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(typeof byId.get('model')!.submenu, 'function');
    assert.equal(typeof byId.get('temperature')!.submenu, 'function');
    assert.equal(byId.get('temperature')!.currentValue, '(provider default)');
    assert.equal(byId.get('model')!.currentValue, 'jev-latest');
  } finally {
    h.cleanup();
  }
});

test('test_readonly_auth_row_reflects_unconfigured_state_without_a_key', () => {
  const h = makeSettingsHarness();
  try {
    const items = buildSettingItems(h.service, fakeClient(false), UI, () => {});
    const auth = items.find((item) => item.id === 'status.auth')!;
    assert.equal(auth.currentValue, 'not configured');
    const output = auth.submenu!('', () => {})
      .render(90)
      .join('\n');
    assert.match(output, /auth:\s+not configured/);
    assert.doesNotMatch(output, /•/);
    assert.doesNotMatch(output, /API_KEY|api key|bearer/i);
  } finally {
    h.cleanup();
  }
});

test('test_readonly_auth_row_describes_auth_status_from_the_live_info', () => {
  const h = makeSettingsHarness();
  const catalog: ProviderCatalog = {
    models: [],
    info: {
      provider: 'llama-cpp',
      label: 'llama.cpp',
      model: 'qwen3-4b',
      api: 'llama-cpp-classify',
      auth: 'not configured',
      source: 'settings',
    },
  };
  try {
    const items = buildSettingItems(
      h.service,
      {
        stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
        isConfigured: () => true,
      } as unknown as SystemOneClient,
      UI,
      () => {},
      () => {},
      { ...h.service.values },
      catalog,
    );
    const auth = items.find((item) => item.id === 'status.auth')!;
    assert.equal(auth.currentValue, 'not configured');
    const output = auth.submenu!('', () => {})
      .render(90)
      .join('\n');
    assert.match(output, /provider:\s+llama-cpp/);
    assert.match(output, /api:\s+llama-cpp-classify/);
    assert.match(output, /auth:\s+not configured/);
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

test('test_text_input_submenu_allows_empty_for_temperature', () => {
  let saved: string | undefined | 'never' = 'never';
  const submenu = new TextInputSubmenu('Temperature', '1.5', true, UI, (value) => {
    saved = value;
  });

  submenu.handleInput(ENTER);
  assert.equal(saved, '1.5');

  const cleared = new TextInputSubmenu('Temperature', '', true, UI, (value) => {
    saved = value;
  });
  cleared.handleInput(ENTER);
  assert.equal(saved, '', 'empty is a meaningful value for temperature');
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

test('test_provider_groups_list_every_classifier_with_name_id_and_api', async () => {
  const catalog = await loadProviderCatalog(fakeClient());
  const groups = buildProviderGroups(catalog);

  const typesafe = groups.find((group) => group.provider === 'typesafe')!;
  assert.equal(typesafe.options[0]!.name, 'Jev Latest');
  assert.equal(typesafe.options[0]!.model, 'jev-latest');
  assert.equal(typesafe.options[0]!.api, 'typesafe-system-one');
  assert.equal(typesafe.options[0]!.selectable, true);

  const openrouter = groups.find((group) => group.provider === 'openrouter')!;
  assert.equal(openrouter.options[0]!.model, 'typesafe/jev-1.13');
});

test('test_provider_groups_keep_unauthenticated_providers_visible_with_a_remedy', async () => {
  const catalog = await loadProviderCatalog(fakeClient());
  const groups = buildProviderGroups(catalog);

  for (const provider of PROVIDER_VALUES) {
    if (provider === 'auto') continue;
    assert.ok(
      groups.some((group) => group.provider === provider),
      `${provider} must remain visible`,
    );
  }
  const opencode = groups.find((group) => group.provider === 'opencode')!;
  assert.equal(opencode.options[0]!.selectable, false);
  assert.match(opencode.options[0]!.remedy!, /login opencode/);
});

test('test_provider_groups_mark_a_local_pin_with_the_llama_remedy', async () => {
  const catalog = await loadProviderCatalog({
    listAvailable: async () => [],
    getProviderInfo: async () => ({
      provider: 'llama-cpp',
      label: 'llama.cpp',
      model: 'qwen3-4b',
      api: 'llama-cpp-classify',
      auth: 'not configured',
      source: 'settings',
    }),
  } as unknown as SystemOneClient);

  const groups = buildProviderGroups(catalog);
  const local = groups.find((group) => group.provider === 'llama-cpp')!;
  assert.equal(local.options[0]!.selectable, false);
  assert.match(local.options[0]!.remedy!, /\/llama/);
});

test('test_provider_submenu_renders_classifiers_and_selects_an_available_one', async () => {
  const catalog = await loadProviderCatalog(fakeClient());
  const draft: SystemOneSettings = { ...SETTING_DEFAULTS };
  let chosen: string | undefined;
  const submenu = new ProviderSubmenu(
    buildProviderGroups(catalog),
    'auto',
    UI,
    () => {},
    (option) => {
      chosen = option.model;
      draft.provider = option.provider;
      if (option.model) draft.model = option.model;
    },
  );

  const output = submenu.render(100).join('\n');
  assert.match(output, /Classifier · Provider/);
  assert.match(output, /Jev Latest \[jev-latest\]/);
  assert.match(output, /typesafe-system-one/);
  assert.match(output, /run \/login opencode/);

  // Cursor starts on auto; move down to the first catalog entry and pick it.
  submenu.handleInput(DOWN);
  submenu.handleInput(ENTER);
  assert.equal(chosen, 'jev-latest');
  assert.equal(draft.provider, 'typesafe');
  assert.equal(draft.model, 'jev-latest');
});

test('test_provider_submenu_refuses_an_unauthenticated_entry_and_shows_the_remedy', async () => {
  const catalog = await loadProviderCatalog(fakeClient());
  let chosen = 0;
  const submenu = new ProviderSubmenu(
    buildProviderGroups(catalog),
    'auto',
    UI,
    () => {},
    () => {
      chosen += 1;
    },
  );

  // auto, typesafe, openrouter, then cloudflare-workers-ai (unauthenticated).
  for (let i = 0; i < 3; i++) submenu.handleInput(DOWN);
  const before = submenu.render(100).join('\n');
  assert.match(before, /cloudflare-workers-ai/);
  submenu.handleInput(ENTER);
  assert.equal(chosen, 0, 'an unauthenticated provider cannot be selected');
  assert.match(submenu.render(100).join('\n'), /not ready — run \/login cloudflare-workers-ai/);
});

test('test_provider_submenu_escape_closes_without_selecting', async () => {
  const catalog = await loadProviderCatalog(fakeClient());
  let closed = 0;
  let chosen = 0;
  const submenu = new ProviderSubmenu(
    buildProviderGroups(catalog),
    'auto',
    UI,
    () => {
      closed += 1;
    },
    () => {
      chosen += 1;
    },
  );

  submenu.handleInput(UP);
  submenu.handleInput(ESCAPE);
  assert.equal(closed, 1);
  assert.equal(chosen, 0);
});

test('test_provider_submenu_explains_when_no_classifier_is_available', () => {
  const submenu = new ProviderSubmenu(
    buildProviderGroups({ models: [], info: null }),
    'auto',
    UI,
    () => {},
    () => {},
  );
  const output = submenu.render(100).join('\n');
  assert.match(output, /No classifier is available/);
  assert.match(output, /\/login <provider>/);
  assert.match(output, /\/llama/);
  assert.match(output, /run \/login opencode/, 'known providers stay visible with a remedy');
});

test('test_status_submenu_reads_the_provider_snapshot_without_a_health_row', () => {
  const h = makeSettingsHarness();
  const catalog: ProviderCatalog = {
    models: [],
    info: {
      provider: 'llama-cpp',
      label: 'llama.cpp',
      model: 'qwen3-4b',
      api: 'llama-cpp-classify',
      auth: 'ok',
      source: 'settings',
    },
  };
  try {
    const items = buildSettingItems(
      h.service,
      {
        stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
        isConfigured: () => true,
      } as unknown as SystemOneClient,
      UI,
      () => {},
      () => {},
      { ...h.service.values },
      catalog,
    );
    const status = items.find((item) => item.id === 'status.session')!;
    const output = status.submenu!('', () => {})
      .render(90)
      .join('\n');
    assert.match(output, /provider:\s+llama-cpp/);
    assert.match(output, /api:\s+llama-cpp-classify/);
    assert.doesNotMatch(output, /health/i);
  } finally {
    h.cleanup();
  }
});

test('test_settings_ui_theme_adapts_a_pi_theme', () => {
  const piTheme = {
    fg: (color: string, text: string) => `<${color}>${text}`,
    bold: (text: string) => `*${text}*`,
  };
  const ui = settingsUiTheme(piTheme);
  assert.equal(ui.accent('x'), '<accent>x');
  assert.equal(ui.dim('x'), '<dim>x');
  assert.equal(ui.success('x'), '<success>x');
  assert.equal(ui.error('x'), '<error>x');
  assert.equal(ui.bold('x'), '*x*');
});
