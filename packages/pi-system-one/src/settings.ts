import * as fs from 'node:fs';
import type { SystemOneSessionStats } from './types.js';
import { SYSTEM_ONE_TOOL_NAMES } from './types.js';
import type { SystemOneClient } from './system-one.js';
import {
  SETTING_DEFAULTS,
  SETTING_SPECS,
  type SystemOneSettings,
  type ProviderChoice,
  type RawSettings,
  type ResolvedSettings,
  type SettingKey,
  type SettingLayer,
  coerceSetting,
  effectiveLegacyInputs,
  getSpec,
  isSettingKey,
  resolveSettings,
  serializeSettings,
  settingsFromEnv,
  settingsFromFlags,
} from './config.js';
import {
  appendSessionOverrides,
  deleteSettingsFile,
  legacyProjectSettingsPath,
  legacyUserSettingsPath,
  projectSettingsPath,
  readSessionOverridesWithSource,
  readSettingsFile,
  readSettingsFileWithLegacy,
  userSettingsPath,
  writeSettingsFile,
} from './config-store.js';

/** The subset of ExtensionAPI the settings service needs. */
export interface SettingsHost {
  getFlag(name: string): unknown;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
}

/** Live mode objects driven by the `Modes` group. */
export interface ModeControllers {
  auto: {
    setToolsEnabled(value: boolean): void;
    setSkillsEnabled(value: boolean): void;
  };
  autoModel: { setEnabled(value: boolean): void };
  agents: { setEnabled(value: boolean): void };
  toolGuard: { setEnabled(value: boolean): void };
  compactor: { setEnabled(value: boolean): void };
}

export interface SessionStatus {
  values: SystemOneSettings;
  provenance: Record<SettingKey, SettingLayer>;
  provider: ReturnType<SystemOneClient['getProviderInfo']>;
  stats: SystemOneSessionStats;
  files: { user: string; project: string };
  legacyInputs: string[];
}

export const PERSIST_SCOPES = ['user', 'project', 'both'] as const;
export type PersistScope = (typeof PERSIST_SCOPES)[number];

export interface SettingsServiceOptions {
  /** Environment layer source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the user settings file (tests, or a relocated secrets dir). */
  userPath?: string;
  /** Override the project settings file (tests). */
  projectPath?: string;
  /** Override the legacy user settings fallback (tests). */
  legacyUserPath?: string;
  /** Override the legacy project settings fallback (tests). */
  legacyProjectPath?: string;
}

/**
 * Owns the effective settings, the three persistence layers, and the mapping from
 * settings onto live mode objects.
 *
 * Layering (lowest → highest): defaults → user file → project file → env → CLI flag
 * → session overrides. Session overrides are held in memory and written to the session
 * branch so they survive a resume, and they always win so a TUI edit beats an env var
 * for the rest of the session.
 */
export class SettingsService {
  private user: RawSettings = {};
  private project: RawSettings = {};
  private session: RawSettings = {};
  private resolved: ResolvedSettings = resolveSettings({});
  private env: NodeJS.ProcessEnv;
  private userPath: string;
  private projectPath: string;
  private legacyUserPath: string;
  private legacyProjectPath: string;
  private fileAndSessionLegacyInputs: string[] = [];
  private activeLegacyInputs: string[] = [];

  constructor(
    private host: SettingsHost,
    private systemOneClient: SystemOneClient,
    private controllers: ModeControllers,
    options: SettingsServiceOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.userPath = options.userPath ?? userSettingsPath();
    this.projectPath = options.projectPath ?? projectSettingsPath();
    this.legacyUserPath =
      options.legacyUserPath ??
      (options.userPath
        ? pathWithSiblingName(options.userPath, 'pi-jev.json')
        : legacyUserSettingsPath());
    this.legacyProjectPath =
      options.legacyProjectPath ??
      (options.projectPath
        ? pathWithSiblingName(options.projectPath, 'pi-jev.json')
        : legacyProjectSettingsPath());
  }

  public get values(): SystemOneSettings {
    return this.resolved.values;
  }

  public get provenance(): Record<SettingKey, SettingLayer> {
    return this.resolved.provenance;
  }

  /** Session-layer overrides only (what the TUI and `/system-one … on|off` wrote). */
  public get sessionOverrides(): RawSettings {
    return { ...this.session };
  }

  public get resolvedSettings(): ResolvedSettings {
    return this.resolved;
  }

  public get legacyInputs(): string[] {
    return [...this.activeLegacyInputs];
  }

  public paths(): { user: string; project: string } {
    return { user: this.userPath, project: this.projectPath };
  }

  /** Load all layers, then push the result into the live mode objects. */
  public init(ctx?: { sessionManager?: { getBranch(): readonly unknown[] } }): ResolvedSettings {
    const user = readSettingsFileWithLegacy(this.userPath, this.legacyUserPath);
    const project = readSettingsFileWithLegacy(this.projectPath, this.legacyProjectPath);
    const session = readSessionOverridesWithSource(ctx?.sessionManager?.getBranch?.());
    this.user = user.settings;
    this.project = project.settings;
    this.session = session.settings;
    this.fileAndSessionLegacyInputs = [
      ...(user.legacyPath ? [user.legacyPath] : []),
      ...(project.legacyPath ? [project.legacyPath] : []),
      ...(session.legacy ? ['pi-jev-config session entry'] : []),
    ];
    this.recompute();
    this.apply();
    return this.resolved;
  }

  /** Update one setting in the session layer and apply it immediately. */
  public set(key: SettingKey, raw: unknown): boolean {
    const spec = getSpec(key);
    if (!spec) return false;

    const coerced = coerceSetting(spec, raw);
    if (coerced === undefined) return false;

    // Always store the value explicitly: comparing against the default would drop an
    // override that exists precisely to beat an env var or a file.
    this.session = { ...this.session, [key]: coerced };
    this.recompute();
    appendSessionOverrides(this.host, this.session);
    this.apply();
    return true;
  }

  /** Merge current session overrides into each destination file. Returns paths written. */
  public persistToFile(scope: PersistScope): string[] {
    const payload = serializeSettings(this.session);
    if (Object.keys(payload).length === 0) return [];

    const paths = this.paths();
    const targets =
      scope === 'user'
        ? [paths.user]
        : scope === 'project'
          ? [paths.project]
          : [paths.user, paths.project];
    for (const target of targets) {
      // Read each destination at save time so unrelated settings and later edits survive.
      const existing = serializeSettings(readSettingsFile(target));
      writeSettingsFile(target, { ...existing, ...payload });
    }
    return targets;
  }

  /** Clear session overrides and optionally remove the settings files. */
  public resetToDefaults(dropFiles = false): void {
    if (dropFiles) {
      deleteSettingsFile(this.paths().user);
      deleteSettingsFile(this.paths().project);
    }
    this.session = {};
    appendSessionOverrides(this.host, this.session);
    const user = readSettingsFileWithLegacy(this.userPath, this.legacyUserPath);
    const project = readSettingsFileWithLegacy(this.projectPath, this.legacyProjectPath);
    this.user = user.settings;
    this.project = project.settings;
    this.fileAndSessionLegacyInputs = [
      ...(user.legacyPath ? [user.legacyPath] : []),
      ...(project.legacyPath ? [project.legacyPath] : []),
    ];
    this.recompute();
    this.apply();
  }

  public status(): SessionStatus {
    return {
      values: this.values,
      provenance: this.provenance,
      provider: this.systemOneClient.getProviderInfo(),
      stats: this.systemOneClient.stats,
      files: this.paths(),
      legacyInputs: this.legacyInputs,
    };
  }

  /** Push settings into the live objects. Safe to call repeatedly. */
  public apply(): void {
    const values = this.values;

    this.controllers.auto.setToolsEnabled(values.autoToolRouting);
    this.controllers.auto.setSkillsEnabled(values.autoSkillRouting);
    this.controllers.autoModel.setEnabled(values.autoModel);
    this.controllers.agents.setEnabled(values.agentOrchestration);
    this.controllers.toolGuard.setEnabled(values.toolGuard);
    this.controllers.compactor.setEnabled(values.compaction);

    const active = new Set(this.host.getActiveTools());
    for (const name of SYSTEM_ONE_TOOL_NAMES) {
      if (values.systemOneTools) active.add(name);
      else active.delete(name);
    }
    this.host.setActiveTools([...active]);

    this.systemOneClient.setProviderOverrides({
      provider: values.provider,
      baseURL: values.baseURL,
      model: values.model,
    });
  }

  private recompute(): void {
    const getFlag = (name: string): unknown => {
      try {
        return this.host.getFlag(name);
      } catch {
        return undefined;
      }
    };

    this.activeLegacyInputs = [
      ...this.fileAndSessionLegacyInputs,
      ...effectiveLegacyInputs(this.env, getFlag),
    ];

    this.resolved = resolveSettings({
      user: this.user,
      project: this.project,
      env: settingsFromEnv(this.env),
      flag: settingsFromFlags(getFlag),
      session: this.session,
    });
  }
}

function pathWithSiblingName(filePath: string, siblingName: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return slash < 0 ? siblingName : `${filePath.slice(0, slash + 1)}${siblingName}`;
}

/** Which settings differ from their defaults, for a compact status readout. */
export function changedSettings(
  values: SystemOneSettings,
): Array<{ key: SettingKey; value: SystemOneSettings[SettingKey] }> {
  return SETTING_SPECS.filter((spec) => values[spec.key] !== SETTING_DEFAULTS[spec.key]).map(
    (spec) => ({
      key: spec.key,
      value: values[spec.key],
    }),
  );
}

export function formatSettingValue(value: SystemOneSettings[SettingKey]): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '') return '(provider default)';
  return String(value);
}

/** Human-readable one-liner for a value plus the layer that supplied it. */
export function describeSetting(key: SettingKey, resolved: ResolvedSettings): string {
  const spec = getSpec(key);
  const label = spec ? `${spec.group} · ${spec.label}` : key;
  return `${label}: ${formatSettingValue(resolved.values[key])} (${resolved.provenance[key]})`;
}

/** True when a session override exists for the key. */
export function hasSessionOverride(session: RawSettings, key: SettingKey): boolean {
  return Object.prototype.hasOwnProperty.call(session, key);
}

/** Read the project settings file's `version`, for diagnostics. */
export function settingsFileVersion(filePath: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'number' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export { isSettingKey };
export type { ProviderChoice };
