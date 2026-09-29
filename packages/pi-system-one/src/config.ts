/**
 * Classifier selection: a concrete provider id, or `auto` to let pi's catalog decide.
 *
 * The provider is a pi provider id (`typesafe`, `openrouter`, `cloudflare-workers-ai`,
 * `vercel-ai-gateway`, `opencode`, or a llama.cpp provider) rather than a fixed enum,
 * because the set of classifiers is whatever pi's catalog offers on the machine.
 */
export type ProviderChoice = string;

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

export type SettingGroup = 'Modes' | 'Classifier';

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
  model: string;
  /** Label-logit temperature for prompt-rendered classifiers; empty = provider default. */
  temperature: string;
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
  model: 'jev-latest',
  temperature: '',
};

/**
 * Provider names referenced by documentation and by a machine with no catalog.
 *
 * This is not the set of selectable providers: the catalog is whatever pi offers, which
 * includes providers this package has never heard of (`llama-cpp`, a gateway, a
 * models.json entry). The list is only the cycling fallback for a settings list with no
 * catalog loaded.
 */
export const PROVIDER_VALUES: readonly ProviderChoice[] = [
  'auto',
  'typesafe',
  'openrouter',
  'cloudflare-workers-ai',
  'vercel-ai-gateway',
  'opencode',
];

/** Providers that were removed in 0.99, kept out of the accepted set on purpose. */
const RETIRED_PROVIDERS = new Set(['laya']);

/**
 * A provider id pi could plausibly expose: a lowercase slug, optionally with dots.
 * Anything else is a typo or an injection attempt, and is rejected rather than sent to
 * the registry as a provider name.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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
  /** Values the settings layer must not accept, whatever the kind. */
  retiredValues?: readonly string[];
  /** Lowercase a `string` value before accepting it, so ids compare case-insensitively. */
  lowercase?: boolean;
  /** Reject a `string` value that does not match, so a typo never reaches the registry. */
  pattern?: RegExp;
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
    group: 'Classifier',
    description:
      'Classifier provider. Any provider pi can reach; `auto` tries every available classifier. Sign in with /login, or load a local model with /llama',
    kind: 'string',
    lowercase: true,
    pattern: PROVIDER_ID_PATTERN,
    retiredValues: [...RETIRED_PROVIDERS],
    envVar: 'PI_SYSTEM_ONE_PROVIDER',
    legacyEnvVar: 'PI_JEV_PROVIDER',
  },
  {
    key: 'model',
    label: 'Model',
    group: 'Classifier',
    description: 'Classifier model id, as pi lists it (default: jev-latest)',
    kind: 'string',
    envVar: 'PI_SYSTEM_ONE_MODEL',
    legacyEnvVar: 'PI_JEV_MODEL',
  },
  {
    key: 'temperature',
    label: 'Temperature',
    group: 'Classifier',
    description:
      'Label-logit temperature for local classifiers. Above 1 softens an overconfident distribution; it never changes the answer. Empty = provider default',
    kind: 'string',
    allowEmpty: true,
    envVar: 'PI_SYSTEM_ONE_TEMPERATURE',
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
  if (typeof raw === 'string' && spec.retiredValues?.includes(raw.trim().toLowerCase())) {
    return undefined;
  }
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
      let trimmed = raw.trim();
      if (trimmed === '' && !spec.allowEmpty) return undefined;
      if (spec.lowercase) trimmed = trimmed.toLowerCase();
      if (trimmed !== '' && spec.retiredValues?.includes(trimmed)) return undefined;
      if (spec.pattern && trimmed !== '' && !spec.pattern.test(trimmed)) return undefined;
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
  // These inputs are consumed directly by SystemOneClient rather than represented as
  // editable settings, but status still needs to disclose their effective legacy aliases.
  for (const [canonicalName, legacyName] of [
    ['PI_SYSTEM_ONE_BASE_URL', 'PI_JEV_BASE_URL'],
    ['PI_SYSTEM_ONE_API_KEY', 'PI_JEV_API_KEY'],
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
