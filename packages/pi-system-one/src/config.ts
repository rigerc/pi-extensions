import type { SystemOneProvider } from './types.js';

/** Provider selection: an explicit provider, or `auto` to let env/secret detection decide. */
export type ProviderChoice = SystemOneProvider | 'auto';

/** Config layers, lowest precedence first. */
export type SettingLayer = 'default' | 'user' | 'project' | 'env' | 'flag' | 'session';
export const LAYER_ORDER: readonly SettingLayer[] = [
  'default',
  'user',
  'project',
  'env',
  'flag',
  'session',
];

export type SettingGroup = 'Modes' | 'Provider';

/** Everything the settings TUI can edit. Thresholds and limits stay code constants by design. */
export interface SystemOneSettings {
  autoToolRouting: boolean;
  autoSkillRouting: boolean;
  autoModel: boolean;
  agentOrchestration: boolean;
  toolGuard: boolean;
  compaction: boolean;
  systemOneTools: boolean;
  provider: ProviderChoice;
  baseURL: string;
  model: string;
}

export type SettingKey = keyof SystemOneSettings;

/** Untrusted input from files, env, flags, or session entries. */
export type RawSettings = Partial<Record<SettingKey, unknown>>;

export const SETTING_DEFAULTS: SystemOneSettings = {
  autoToolRouting: false,
  autoSkillRouting: false,
  autoModel: false,
  agentOrchestration: false,
  toolGuard: false,
  compaction: false,
  systemOneTools: false,
  provider: 'auto',
  baseURL: '',
  model: 'jev-latest',
};

export const PROVIDER_VALUES: readonly ProviderChoice[] = [
  'auto',
  'typesafe',
  'openrouter',
  'laya',
];

export interface SettingSpec {
  key: SettingKey;
  label: string;
  group: SettingGroup;
  description: string;
  kind: 'boolean' | 'enum' | 'string';
  /** Allowed values for `kind: "enum"`, also used as the SettingsList cycle. */
  values?: readonly string[];
  /** Empty string is a meaningful value (Base URL means "provider default"). */
  allowEmpty?: boolean;
  /** Environment variable read by the `env` layer. */
  envVar?: string;
  /** Deprecated environment variable accepted during the 0.8 migration window. */
  legacyEnvVar?: string;
  /** CLI flag read by the `flag` layer. Flags are on-only. */
  flag?: string;
  /** Deprecated CLI flag accepted during the 0.8 migration window. */
  legacyFlag?: string;
}

export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: 'autoToolRouting',
    label: 'Auto tool routing',
    group: 'Modes',
    description:
      'Activate the tools a prompt needs before the turn (shares one System One request with skill routing when both are on)',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_AUTO_TOOLS',
    legacyEnvVar: 'PI_JEV_AUTO_TOOLS',
    flag: 'system-one-auto-tools',
    legacyFlag: 'jev-auto-tools',
  },
  {
    key: 'autoSkillRouting',
    label: 'Auto skill routing',
    group: 'Modes',
    description:
      'Recommend matching skills before the turn (shares one System One request with tool routing when both are on)',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_AUTO_SKILLS',
    legacyEnvVar: 'PI_JEV_AUTO_SKILLS',
    flag: 'system-one-auto-skills',
    legacyFlag: 'jev-auto-skills',
  },
  {
    key: 'autoModel',
    label: 'Auto-model',
    group: 'Modes',
    description:
      'Pick a fast/balanced/reasoning/long-context/vision model per prompt (local, no System One request)',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_AUTO_MODEL',
    legacyEnvVar: 'PI_JEV_AUTO_MODEL',
    flag: 'system-one-auto-model',
    legacyFlag: 'jev-auto-model',
  },
  {
    key: 'agentOrchestration',
    label: 'Agent orchestration',
    group: 'Modes',
    description:
      'Dispatch pi-subagents workflows, explicitly and automatically (/system-one agents)',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_AGENTS',
    legacyEnvVar: 'PI_JEV_AGENTS',
    flag: 'system-one-agents',
    legacyFlag: 'jev-agents',
  },
  {
    key: 'toolGuard',
    label: 'Tool guard',
    group: 'Modes',
    description: 'Validate tool calls with System One and enhance failed results',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_TOOL_GUARD',
    legacyEnvVar: 'PI_JEV_TOOL_GUARD',
    flag: 'system-one-tool-guard',
    legacyFlag: 'jev-tool-guard',
  },
  {
    key: 'compaction',
    label: 'System One compaction',
    group: 'Modes',
    description: 'Retain important tool history during /compact',
    kind: 'boolean',
    envVar: 'PI_SYSTEM_ONE_COMPACT',
    legacyEnvVar: 'PI_JEV_COMPACT',
    flag: 'system-one-compact',
    legacyFlag: 'jev-compact',
  },
  {
    key: 'systemOneTools',
    label: 'System One tools granted',
    group: 'Modes',
    description:
      'Expose system_one_find_tools / system_one_find_skill / system_one_evaluate for this session',
    kind: 'boolean',
  },
  {
    key: 'provider',
    label: 'Provider',
    group: 'Provider',
    description:
      'System One backend. auto detects hosted credentials; select laya explicitly for local inference',
    kind: 'enum',
    values: PROVIDER_VALUES,
    envVar: 'PI_SYSTEM_ONE_PROVIDER',
    legacyEnvVar: 'PI_JEV_PROVIDER',
  },
  {
    key: 'baseURL',
    label: 'Base URL',
    group: 'Provider',
    description: 'API root without /v1. Empty = provider default (Laya: http://127.0.0.1:8000)',
    kind: 'string',
    allowEmpty: true,
    envVar: 'PI_SYSTEM_ONE_BASE_URL',
    legacyEnvVar: 'PI_JEV_BASE_URL',
  },
  {
    key: 'model',
    label: 'Model',
    group: 'Provider',
    description:
      'Model id. jev-latest auto-routes on Laya; or pin english, multilingual, typed-decisions',
    kind: 'string',
    envVar: 'PI_SYSTEM_ONE_MODEL',
    legacyEnvVar: 'PI_JEV_MODEL',
  },
];

/** Keys that map onto a live mode object, in apply order. */
/**
 * Switches that set several settings at once. Applied before individual specs within the
 * same layer, so a specific variable (e.g. PI_SYSTEM_ONE_AUTO_SKILLS) still wins over the master.
 */
export interface MasterSwitch {
  keys: readonly SettingKey[];
  envVar?: string;
  legacyEnvVar?: string;
  flag?: string;
  legacyFlag?: string;
}

export const MASTER_SWITCHES: readonly MasterSwitch[] = [
  {
    keys: ['autoToolRouting', 'autoSkillRouting'],
    envVar: 'PI_SYSTEM_ONE_AUTO',
    legacyEnvVar: 'PI_JEV_AUTO',
    flag: 'system-one-auto',
    legacyFlag: 'jev-auto',
  },
];

const SPECS_BY_KEY = new Map<SettingKey, SettingSpec>(SETTING_SPECS.map((s) => [s.key, s]));

export function getSpec(key: SettingKey): SettingSpec | undefined {
  return SPECS_BY_KEY.get(key);
}

export function isSettingKey(value: string): value is SettingKey {
  return SPECS_BY_KEY.has(value as SettingKey);
}

export function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

/**
 * Validate one raw value against its spec. Returns undefined for anything invalid
 * so callers ignore it instead of coercing a wrong value into place.
 */
export function coerceSetting(
  spec: SettingSpec,
  raw: unknown,
): SystemOneSettings[SettingKey] | undefined {
  switch (spec.kind) {
    case 'boolean':
      return parseBoolean(raw);

    case 'enum': {
      if (typeof raw !== 'string') return undefined;
      const normalized = raw.trim().toLowerCase();
      return spec.values?.includes(normalized)
        ? (normalized as SystemOneSettings[SettingKey])
        : undefined;
    }

    case 'string': {
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (trimmed === '' && !spec.allowEmpty) return undefined;
      return trimmed;
    }
  }
}

/** Build the `env` layer from PI_SYSTEM_ONE_* variables (masters first, then specifics). */
export function settingsFromEnv(
  env: NodeJS.ProcessEnv,
  specs: readonly SettingSpec[] = SETTING_SPECS,
  masters: readonly MasterSwitch[] = MASTER_SWITCHES,
): RawSettings {
  const out: RawSettings = {};

  for (const master of masters) {
    const legacyRaw = master.legacyEnvVar ? env[master.legacyEnvVar] : undefined;
    if (legacyRaw !== undefined && legacyRaw.trim() !== '') {
      for (const key of master.keys) out[key] = legacyRaw;
    }
    const raw = master.envVar ? env[master.envVar] : undefined;
    if (raw !== undefined && raw.trim() !== '') {
      for (const key of master.keys) out[key] = raw;
    }
  }

  for (const spec of specs) {
    const legacyRaw = spec.legacyEnvVar ? env[spec.legacyEnvVar] : undefined;
    if (legacyRaw !== undefined && legacyRaw.trim() !== '') out[spec.key] = legacyRaw;
    const raw = spec.envVar ? env[spec.envVar] : undefined;
    if (raw !== undefined && raw.trim() !== '') out[spec.key] = raw;
  }
  return out;
}

/** Build the `flag` layer. Flags are on-only, so only `true` contributes. */
export function settingsFromFlags(
  getFlag: (name: string) => unknown,
  specs: readonly SettingSpec[] = SETTING_SPECS,
  masters: readonly MasterSwitch[] = MASTER_SWITCHES,
): RawSettings {
  const out: RawSettings = {};

  for (const master of masters) {
    if (master.legacyFlag && getFlag(master.legacyFlag) === true) {
      for (const key of master.keys) out[key] = true;
    }
    if (master.flag && getFlag(master.flag) === true) {
      for (const key of master.keys) out[key] = true;
    }
  }

  for (const spec of specs) {
    if (spec.legacyFlag && getFlag(spec.legacyFlag) === true) out[spec.key] = true;
    if (spec.flag && getFlag(spec.flag) === true) out[spec.key] = true;
  }
  return out;
}

/** Effective deprecated inputs, for one concise migration notice in status output. */
export function effectiveLegacyInputs(
  env: NodeJS.ProcessEnv,
  getFlag: (name: string) => unknown,
  specs: readonly SettingSpec[] = SETTING_SPECS,
  masters: readonly MasterSwitch[] = MASTER_SWITCHES,
): string[] {
  const inputs = new Set<string>();
  // These provider inputs are consumed directly by SystemOneClient rather than represented
  // as editable settings, but status still needs to disclose their effective legacy aliases.
  for (const [canonicalName, legacyName] of [
    ['PI_SYSTEM_ONE_API_KEY', 'PI_JEV_API_KEY'],
    ['PI_SYSTEM_ONE_SECRETS_DIR', 'PI_JEV_SECRETS_DIR'],
  ] as const) {
    if (!env[canonicalName]?.trim() && env[legacyName]?.trim()) inputs.add(`$${legacyName}`);
  }
  for (const master of masters) {
    const canonical = master.envVar ? env[master.envVar]?.trim() : '';
    const legacy = master.legacyEnvVar ? env[master.legacyEnvVar]?.trim() : '';
    if (!canonical && legacy && master.legacyEnvVar) inputs.add(`$${master.legacyEnvVar}`);
    if (
      master.legacyFlag &&
      getFlag(master.legacyFlag) === true &&
      (!master.flag || getFlag(master.flag) !== true)
    ) {
      inputs.add(`--${master.legacyFlag}`);
    }
  }
  for (const spec of specs) {
    const canonical = spec.envVar ? env[spec.envVar]?.trim() : '';
    const legacy = spec.legacyEnvVar ? env[spec.legacyEnvVar]?.trim() : '';
    if (!canonical && legacy && spec.legacyEnvVar) inputs.add(`$${spec.legacyEnvVar}`);
    if (
      spec.legacyFlag &&
      getFlag(spec.legacyFlag) === true &&
      (!spec.flag || getFlag(spec.flag) !== true)
    ) {
      inputs.add(`--${spec.legacyFlag}`);
    }
  }
  return [...inputs];
}

export interface ResolvedSettings {
  values: SystemOneSettings;
  provenance: Record<SettingKey, SettingLayer>;
}

/**
 * Merge layers (lowest → highest) into one value per setting, recording which layer
 * supplied each key so the TUI and `/system-one status` can show provenance.
 */
export function resolveSettings(
  layers: Partial<Record<SettingLayer, RawSettings>>,
  specs: readonly SettingSpec[] = SETTING_SPECS,
): ResolvedSettings {
  const values: SystemOneSettings = { ...SETTING_DEFAULTS };
  const provenance = {} as Record<SettingKey, SettingLayer>;
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    provenance[key] = 'default';
  }

  const byKey = new Map<SettingKey, SettingSpec>(specs.map((s) => [s.key, s]));
  for (const layer of LAYER_ORDER) {
    if (layer === 'default') continue;
    const raw = layers[layer];
    if (!raw) continue;

    for (const [key, value] of Object.entries(raw)) {
      const spec = byKey.get(key as SettingKey);
      if (!spec) continue;
      const coerced = coerceSetting(spec, value);
      if (coerced === undefined) continue;
      values[key as SettingKey] = coerced as never;
      provenance[key as SettingKey] = layer;
    }
  }

  return { values, provenance };
}

/**
 * Serialize for disk/session. Unknown keys are dropped and secret-bearing specs are
 * never emitted, so credentials cannot reach a config file.
 */
export function serializeSettings(partial: RawSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of SETTING_SPECS) {
    const value = partial[spec.key];
    if (value === undefined) continue;
    out[spec.key] = value;
  }
  return out;
}
