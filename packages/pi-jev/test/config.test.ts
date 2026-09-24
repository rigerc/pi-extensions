import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTING_DEFAULTS,
  SETTING_SPECS,
  coerceSetting,
  getSpec,
  isSettingKey,
  parseBoolean,
  resolveSettings,
  serializeSettings,
  settingsFromEnv,
  settingsFromFlags,
  type SettingKey,
} from "../src/config.js";

test("test_parse_boolean_accepts_common_spellings_and_rejects_the_rest", () => {
  for (const truthy of [true, 1, "1", "true", "TRUE", "yes", " on "]) {
    assert.equal(parseBoolean(truthy), true, `${String(truthy)} should be true`);
  }
  for (const falsy of [false, 0, "0", "false", "no", "off"]) {
    assert.equal(parseBoolean(falsy), false, `${String(falsy)} should be false`);
  }
  for (const invalid of ["maybe", "", null, undefined, {}, []]) {
    assert.equal(parseBoolean(invalid), undefined, `${JSON.stringify(invalid)} should be rejected`);
  }
});

test("test_coerce_setting_rejects_invalid_values_instead_of_coercing", () => {
  const model = getSpec("model")!;
  const provider = getSpec("provider")!;
  const baseURL = getSpec("baseURL")!;

  assert.equal(coerceSetting(model, "typesafe/jev-1.13"), "typesafe/jev-1.13");
  assert.equal(coerceSetting(model, ""), undefined, "model may not be empty");
  assert.equal(coerceSetting(model, 42), undefined, "model must be a string");

  assert.equal(coerceSetting(provider, "OpenRouter"), "openrouter", "enum values are case-insensitive");
  assert.equal(coerceSetting(provider, "Laya"), "laya", "the local provider is accepted");
  assert.equal(coerceSetting(provider, "anthropic"), undefined, "unknown provider is rejected");

  assert.equal(coerceSetting(baseURL, ""), "", "empty base URL means provider default");
  assert.equal(coerceSetting(baseURL, "  https://openrouter.ai/api  "), "https://openrouter.ai/api");
});

test("test_effective_config_precedence_defaults_user_project_env_flag_session", () => {
  const resolved = resolveSettings({
    user: { model: "user-model", toolGuard: true, provider: "typesafe" },
    project: { model: "project-model" },
    env: { autoToolRouting: true, provider: "openrouter" },
    flag: { compaction: true },
    session: { autoToolRouting: false, model: "session-model" },
  });

  assert.equal(resolved.values.model, "session-model", "session beats project");
  assert.equal(resolved.values.provider, "openrouter", "env beats user file");
  assert.equal(resolved.values.autoToolRouting, false, "session beats env");
  assert.equal(resolved.values.toolGuard, true, "user file only");
  assert.equal(resolved.values.compaction, true, "flag only");
  assert.equal(resolved.values.autoModel, false, "untouched key stays at default");
});

test("test_provenance_reports_the_winning_layer_per_key", () => {
  const resolved = resolveSettings({
    user: { toolGuard: true, provider: "typesafe" },
    project: { model: "project-model" },
    env: { provider: "openrouter" },
    flag: { compaction: true },
    session: { autoToolRouting: false },
  });

  assert.equal(resolved.provenance.model, "project");
  assert.equal(resolved.provenance.toolGuard, "user");
  assert.equal(resolved.provenance.provider, "env");
  assert.equal(resolved.provenance.compaction, "flag");
  assert.equal(resolved.provenance.autoToolRouting, "session");
  assert.equal(resolved.provenance.autoModel, "default");
  assert.equal(resolved.provenance.jevTools, "default");
});

test("test_invalid_layer_values_are_ignored_and_do_not_override_defaults", () => {
  const resolved = resolveSettings({
    user: {
      model: 123,
      provider: "anthropic",
      autoToolRouting: "maybe",
      baseURL: false,
      notARealSetting: true,
    } as Record<string, unknown>,
  });

  assert.equal(resolved.values.model, SETTING_DEFAULTS.model);
  assert.equal(resolved.provenance.model, "default");
  assert.equal(resolved.values.provider, SETTING_DEFAULTS.provider);
  assert.equal(resolved.values.autoToolRouting, SETTING_DEFAULTS.autoToolRouting);
  assert.equal(resolved.values.baseURL, SETTING_DEFAULTS.baseURL);
  assert.equal(resolved.provenance.autoToolRouting, "default");
  assert.ok(!Object.prototype.hasOwnProperty.call(resolved.values, "notARealSetting"));
});

test("test_settings_from_env_reads_pi_jev_variables_and_skips_blanks", () => {
  const raw = settingsFromEnv({
    PI_JEV_AUTO: "1",
    PI_JEV_TOOL_GUARD: "off",
    PI_JEV_PROVIDER: "openrouter",
    PI_JEV_MODEL: "   ",
  });

  assert.equal(raw.autoToolRouting, "1", "the master expands to the tool path");
  assert.equal(raw.autoSkillRouting, "1", "the master expands to the skill path");
  assert.equal(raw.toolGuard, "off");
  assert.equal(raw.provider, "openrouter");
  assert.ok(!Object.prototype.hasOwnProperty.call(raw, "model"), "blank env values are skipped");

  const resolved = resolveSettings({ env: raw });
  assert.equal(resolved.values.autoToolRouting, true);
  assert.equal(resolved.values.autoSkillRouting, true);
  assert.equal(resolved.values.toolGuard, false);
  assert.equal(resolved.values.provider, "openrouter");
});

test("test_a_specific_env_var_overrides_the_master_switch", () => {
  const raw = settingsFromEnv({ PI_JEV_AUTO: "1", PI_JEV_AUTO_SKILLS: "0" });
  assert.equal(raw.autoToolRouting, "1");
  assert.equal(raw.autoSkillRouting, "0");

  const resolved = resolveSettings({ env: raw });
  assert.equal(resolved.values.autoToolRouting, true);
  assert.equal(resolved.values.autoSkillRouting, false, "specific env var wins over the master");
  assert.equal(resolved.provenance.autoSkillRouting, "env");
});

test("test_settings_from_flags_is_on_only_and_masters_expand", () => {
  const seen: string[] = [];
  const raw = settingsFromFlags((name) => {
    seen.push(name);
    return name === "jev-auto" ? true : name === "jev-compact" ? false : undefined;
  });

  assert.deepEqual(
    raw,
    { autoToolRouting: true, autoSkillRouting: true },
    "the master flag turns on both paths, and a false flag never forces a setting off"
  );
  assert.ok(seen.includes("jev-tool-guard"), "all boolean flags are queried");
});

test("test_a_specific_flag_turns_on_one_path_only", () => {
  const raw = settingsFromFlags((name) => (name === "jev-auto-tools" ? true : undefined));
  assert.deepEqual(raw, { autoToolRouting: true });
});

test("test_serialize_settings_drops_unknown_keys_and_keeps_explicit_false", () => {
  const serialized = serializeSettings({ autoToolRouting: false, model: "m", notARealSetting: 1 } as Record<string, unknown>);

  assert.deepEqual(serialized, { autoToolRouting: false, model: "m" });
});

test("test_registry_is_well_formed", () => {
  const keys = new Set<string>();
  for (const spec of SETTING_SPECS) {
    assert.ok(!keys.has(spec.key), `duplicate setting key ${spec.key}`);
    keys.add(spec.key);
    assert.ok(isSettingKey(spec.key));
    assert.ok(["Modes", "Provider"].includes(spec.group), `${spec.key} has a known group`);
    assert.ok(spec.label.length > 0 && spec.description.length > 0, `${spec.key} is documented`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, spec.key),
      `${spec.key} has a default`
    );
    if (spec.kind === "enum") {
      assert.ok(spec.values && spec.values.length > 1, `${spec.key} enum needs values to cycle`);
      assert.ok(
        spec.values!.includes(String(SETTING_DEFAULTS[spec.key])),
        `${spec.key} default must be one of its values`
      );
    }
  }
  assert.deepEqual(
    [...keys].sort(),
    (Object.keys(SETTING_DEFAULTS) as SettingKey[]).sort(),
    "every default has a spec and vice versa"
  );
});
