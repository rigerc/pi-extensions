import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { SYSTEM_ONE_TOOL_NAMES } from '../src/types.js';
import { SESSION_ENTRY_TYPE } from '../src/config-store.js';
import { configEntry, legacyConfigEntry, makeSettingsHarness } from './settings-harness.js';

test('test_init_resolves_files_env_flags_and_session_in_precedence_order', () => {
  const h = makeSettingsHarness({
    user: { model: 'user-model', toolGuard: true, provider: 'typesafe' },
    project: { model: 'project-model' },
    env: { PI_SYSTEM_ONE_AUTO: '1', PI_SYSTEM_ONE_PROVIDER: 'openrouter' },
    branchEntries: [configEntry({ autoToolRouting: false, systemOneTools: true })],
  });
  h.setFlag('system-one-compact', true);
  try {
    h.service.init({ sessionManager: { getBranch: () => h.sessionBranch() } });

    assert.equal(h.service.values.model, 'project-model', 'project file beats user file');
    assert.equal(h.service.values.provider, 'openrouter', 'env beats user file');
    assert.equal(h.service.values.autoToolRouting, false, 'session beats env');
    assert.equal(h.service.values.toolGuard, true, 'user file only');
    assert.equal(h.service.values.compaction, true, 'flag only');
    assert.equal(h.service.values.systemOneTools, true, 'session entry only');

    assert.equal(h.service.provenance.model, 'project');
    assert.equal(h.service.provenance.provider, 'env');
    assert.equal(h.service.provenance.autoToolRouting, 'session');
    assert.equal(h.service.provenance.autoModel, 'default');
  } finally {
    h.cleanup();
  }
});

test('test_legacy_settings_files_are_read_only_when_canonical_files_are_absent', () => {
  const legacyOnly = makeSettingsHarness({
    legacyUser: { provider: 'typesafe', jevTools: true },
  });
  try {
    legacyOnly.service.init();
    assert.equal(legacyOnly.service.values.provider, 'typesafe');
    assert.equal(legacyOnly.service.values.systemOneTools, true, 'legacy key is migrated');
    assert.deepEqual(legacyOnly.service.legacyInputs, [legacyOnly.legacyPathFor('user')]);
  } finally {
    legacyOnly.cleanup();
  }

  const both = makeSettingsHarness({
    user: { provider: 'openrouter' },
    legacyUser: { provider: 'typesafe', jevTools: true },
  });
  try {
    both.service.init();
    assert.equal(both.service.values.provider, 'openrouter', 'canonical file wins wholesale');
    assert.equal(both.service.values.systemOneTools, false);
    assert.deepEqual(both.service.legacyInputs, []);
  } finally {
    both.cleanup();
  }
});

test('test_canonical_session_entries_win_over_legacy_entries', () => {
  const legacyOnly = makeSettingsHarness({
    branchEntries: [legacyConfigEntry({ jevTools: true, provider: 'typesafe' })],
  });
  try {
    legacyOnly.service.init({ sessionManager: { getBranch: () => legacyOnly.sessionBranch() } });
    assert.equal(legacyOnly.service.values.systemOneTools, true);
    assert.deepEqual(legacyOnly.service.legacyInputs, ['pi-jev-config session entry']);
  } finally {
    legacyOnly.cleanup();
  }

  const both = makeSettingsHarness({
    branchEntries: [
      configEntry({ provider: 'openrouter' }),
      legacyConfigEntry({ provider: 'typesafe' }),
    ],
  });
  try {
    both.service.init({ sessionManager: { getBranch: () => both.sessionBranch() } });
    assert.equal(both.service.values.provider, 'openrouter');
    assert.deepEqual(both.service.legacyInputs, []);
  } finally {
    both.cleanup();
  }
});

test('test_saving_migrates_legacy_user_values_without_touching_the_legacy_file', () => {
  const h = makeSettingsHarness({ legacyUser: { provider: 'typesafe' } });
  try {
    h.service.init();
    const before = fs.readFileSync(h.legacyPathFor('user'), 'utf8');
    h.service.set('toolGuard', true);
    assert.ok(fs.existsSync(h.pathFor('user')));
    assert.deepEqual(JSON.parse(fs.readFileSync(h.pathFor('user'), 'utf8')), {
      version: 1,
      provider: 'typesafe',
      toolGuard: true,
    });
    assert.equal(fs.readFileSync(h.legacyPathFor('user'), 'utf8'), before);
    assert.deepEqual(h.service.legacyInputs, []);
  } finally {
    h.cleanup();
  }
});

test('test_init_applies_settings_to_live_modes_tools_and_provider', () => {
  const h = makeSettingsHarness({
    user: {
      autoToolRouting: true,
      autoSkillRouting: true,
      autoModel: true,
      agentOrchestration: true,
      toolGuard: true,
      compaction: true,
      systemOneTools: true,
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
    },
  });
  try {
    h.service.init();

    assert.equal(h.modes.auto.toolsEnabled, true);
    assert.equal(h.modes.auto.skillsEnabled, true);
    assert.equal(h.modes.autoModel.enabled, true);
    assert.equal(h.modes.agents.enabled, true);
    assert.equal(h.modes.toolGuard.enabled, true);
    assert.equal(h.modes.compactor.enabled, true);

    for (const name of SYSTEM_ONE_TOOL_NAMES) {
      assert.ok(h.activeTools().includes(name), `${name} should be granted`);
    }
    assert.ok(h.activeTools().includes('read'), 'pre-existing tools are preserved');

    assert.deepEqual(h.providerOverrides.at(-1), {
      provider: 'openrouter',
      baseURL: '',
      model: 'typesafe/jev-1.13',
    });
  } finally {
    h.cleanup();
  }
});

test('test_set_saves_to_user_file_and_applies_immediately', () => {
  const h = makeSettingsHarness();
  try {
    h.service.init();
    assert.equal(h.entries.length, 0, 'init does not write an entry');

    assert.equal(h.service.set('toolGuard', 'on'), true);
    assert.equal(h.modes.toolGuard.enabled, true);
    assert.equal(h.service.values.toolGuard, true);
    assert.equal(h.service.provenance.toolGuard, 'session');
    assert.equal(JSON.parse(fs.readFileSync(h.pathFor('user'), 'utf8')).toolGuard, true);

    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0]!.customType, SESSION_ENTRY_TYPE);
    assert.deepEqual(h.entries[0]!.data, { toolGuard: true });

    // Later entries replace the whole override set, so both keys must be present.
    assert.equal(h.service.set('autoModel', true), true);
    assert.deepEqual(h.entries.at(-1)!.data, { toolGuard: true, autoModel: true });
    assert.equal(JSON.parse(fs.readFileSync(h.pathFor('user'), 'utf8')).autoModel, true);
  } finally {
    h.cleanup();
  }
});

test('test_set_rejects_invalid_values_without_touching_state', () => {
  const h = makeSettingsHarness();
  try {
    h.service.init();
    assert.equal(h.service.set('provider', 'anthropic'), false);
    assert.equal(h.service.set('model', ''), false);
    assert.equal(h.service.set('notARealSetting' as never, true), false);

    assert.equal(h.entries.length, 0, 'nothing persisted for rejected values');
    assert.equal(h.service.values.provider, 'auto');
    assert.ok(!fs.existsSync(h.pathFor('user')));
  } finally {
    h.cleanup();
  }
});

test('test_auto_paths_are_independent_and_a_session_override_beats_the_master_env_var', () => {
  // PI_SYSTEM_ONE_AUTO is a master switch; a per-path session override must defeat it without
  // touching the other path.
  const h = makeSettingsHarness({ env: { PI_SYSTEM_ONE_AUTO: '1' } });
  try {
    h.service.init();
    assert.equal(h.service.values.autoToolRouting, true, 'master env enables both paths');
    assert.equal(h.service.values.autoSkillRouting, true);
    assert.equal(h.service.provenance.autoToolRouting, 'env');

    h.service.set('autoToolRouting', false);
    assert.equal(h.service.values.autoToolRouting, false, 'session beats env');
    assert.equal(h.service.values.autoSkillRouting, true, 'the other path is untouched');
    assert.equal(h.modes.auto.toolsEnabled, false);
    assert.equal(h.modes.auto.skillsEnabled, true);
    assert.equal(h.service.provenance.autoToolRouting, 'session');
    assert.equal(h.service.provenance.autoSkillRouting, 'env');
  } finally {
    h.cleanup();
  }
});

test('test_jev_tools_grant_adds_and_removes_only_the_extension_tools', () => {
  const h = makeSettingsHarness({ activeTools: ['read', 'bash'] });
  try {
    h.service.init();
    h.service.set('systemOneTools', true);
    assert.deepEqual(
      h.activeTools().sort(),
      [
        'bash',
        'system_one_evaluate',
        'system_one_find_skill',
        'system_one_find_tools',
        'read',
      ].sort(),
    );

    h.service.set('systemOneTools', false);
    assert.deepEqual(h.activeTools().sort(), ['bash', 'read']);
  } finally {
    h.cleanup();
  }
});

test('test_batch_save_writes_only_the_user_file_and_preserves_layer_priority', () => {
  const h = makeSettingsHarness({
    user: { provider: 'typesafe', autoSkillRouting: true },
    project: { model: 'project-model' },
    env: { PI_SYSTEM_ONE_AUTO_MODEL: '1' },
  });
  h.setFlag('system-one-compact', true);
  try {
    h.service.init();
    const projectBefore = fs.readFileSync(h.pathFor('project'), 'utf8');
    assert.equal(
      h.service.saveUserSettings({ model: 'saved-model', toolGuard: true, compaction: false }),
      h.pathFor('user'),
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(h.pathFor('user'), 'utf8')), {
      version: 1,
      provider: 'typesafe',
      autoSkillRouting: true,
      model: 'saved-model',
      toolGuard: true,
      compaction: false,
    });
    assert.equal(fs.readFileSync(h.pathFor('project'), 'utf8'), projectBefore);
    assert.equal(h.service.values.model, 'saved-model', 'saved value applies this session');
    assert.equal(h.service.values.compaction, false, 'saved value wins this session');
    assert.equal(h.entries.length, 1, 'one batch writes one session entry');

    h.service.init();
    assert.equal(h.service.values.model, 'project-model', 'project still wins next session');
    assert.equal(h.service.values.toolGuard, true, 'user-only value survives restart');
    assert.equal(h.service.values.autoModel, true, 'environment retains priority');
    assert.equal(h.service.values.compaction, true, 'flag retains priority');
  } finally {
    h.cleanup();
  }
});

test('test_save_merges_latest_user_file_and_excludes_secret_fields', () => {
  const h = makeSettingsHarness({ user: { provider: 'typesafe' } });
  try {
    h.service.init();
    fs.writeFileSync(
      h.pathFor('user'),
      JSON.stringify({
        version: 1,
        provider: 'openrouter',
        model: 'updated-model',
        autoToolRouting: 'maybe',
        apiKey: 'test-secret',
      }),
    );

    h.service.saveUserSettings({ toolGuard: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(h.pathFor('user'), 'utf8')), {
      version: 1,
      provider: 'openrouter',
      model: 'updated-model',
      toolGuard: true,
    });
  } finally {
    h.cleanup();
  }
});

test('test_empty_or_invalid_batch_does_not_write_a_file', () => {
  const h = makeSettingsHarness();
  try {
    h.service.init();
    assert.equal(h.service.saveUserSettings({}), undefined);
    assert.throws(() => h.service.saveUserSettings({ model: '' }), /Invalid value/);
    assert.throws(
      () => h.service.saveUserSettings({ toolGuard: true, apiKey: 'secret' } as never),
      /Unknown setting/,
    );
    assert.ok(!fs.existsSync(h.pathFor('user')));
    assert.equal(h.entries.length, 0);
  } finally {
    h.cleanup();
  }
});

test('test_failed_user_write_leaves_live_settings_unchanged', () => {
  const h = makeSettingsHarness();
  try {
    h.service.init();
    fs.mkdirSync(h.pathFor('user'), { recursive: true });
    assert.throws(() => h.service.saveUserSettings({ toolGuard: true }));
    assert.equal(h.service.values.toolGuard, false);
    assert.equal(h.modes.toolGuard.enabled, false);
    assert.equal(h.entries.length, 0);
  } finally {
    h.cleanup();
  }
});

test('test_last_session_entry_wins_over_earlier_ones', () => {
  const h = makeSettingsHarness({
    branchEntries: [
      configEntry({ toolGuard: true, model: 'first' }),
      configEntry({ model: 'second' }),
    ],
  });
  try {
    h.service.init({ sessionManager: { getBranch: () => h.sessionBranch() } });
    assert.equal(h.service.values.model, 'second');
    assert.equal(h.service.values.toolGuard, false, 'a later entry replaces the whole set');
  } finally {
    h.cleanup();
  }
});

test('test_status_reports_values_provenance_provider_and_files', () => {
  const h = makeSettingsHarness({ user: { toolGuard: true } });
  try {
    h.service.init();
    const status = h.service.status();

    assert.equal(status.values.toolGuard, true);
    assert.equal(status.provenance.toolGuard, 'user');
    assert.equal(status.provider?.provider, 'openrouter');
    assert.equal(status.stats.requestsCount, 0);
    assert.equal(status.files.user, h.pathFor('user'));
    assert.equal(status.files.project, h.pathFor('project'));
  } finally {
    h.cleanup();
  }
});
