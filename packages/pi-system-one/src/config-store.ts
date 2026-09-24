import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RawSettings } from './config.js';

/** Session entry type used to persist settings overrides for the current session. */
export const SESSION_ENTRY_TYPE = 'pi-system-one-config';
export const LEGACY_SESSION_ENTRY_TYPE = 'pi-jev-config';

export const SETTINGS_FILE_NAME = 'pi-system-one.json';
export const LEGACY_SETTINGS_FILE_NAME = 'pi-jev.json';
export const SETTINGS_FILE_VERSION = 1;

/** `~/.pi/agent/pi-system-one.json` — defaults for every project. */
export function userSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', SETTINGS_FILE_NAME);
}

/** `<project>/.pi/pi-system-one.json` — overrides the user file for one repository. */
export function projectSettingsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.pi', SETTINGS_FILE_NAME);
}

export function legacyUserSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', LEGACY_SETTINGS_FILE_NAME);
}

export function legacyProjectSettingsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.pi', LEGACY_SETTINGS_FILE_NAME);
}

/** Translate the only renamed JSON key while leaving unknown keys for later validation. */
function normalizeLegacySettings(record: Record<string, unknown>): RawSettings {
  const normalized = { ...record };
  if (normalized.systemOneTools === undefined && normalized.jevTools !== undefined) {
    normalized.systemOneTools = normalized.jevTools;
  }
  delete normalized.jevTools;
  return normalized as RawSettings;
}

/**
 * Read a settings file. Unreadable or malformed files behave as empty — a broken
 * config must never take the extension down, and validation happens per key later.
 */
export function readSettingsFile(filePath: string): RawSettings {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const { version: _version, ...rest } = parsed as Record<string, unknown>;
    return normalizeLegacySettings(rest);
  } catch {
    return {};
  }
}

export interface SettingsFileRead {
  settings: RawSettings;
  legacyPath?: string;
}

/** Prefer the canonical file wholesale; only fall back when it does not exist. */
export function readSettingsFileWithLegacy(
  filePath: string,
  legacyFilePath: string,
): SettingsFileRead {
  if (fs.existsSync(filePath)) return { settings: readSettingsFile(filePath) };
  if (fs.existsSync(legacyFilePath)) {
    return { settings: readSettingsFile(legacyFilePath), legacyPath: legacyFilePath };
  }
  return { settings: {} };
}

/**
 * Write a settings file atomically: a temp file in the same directory, then a rename.
 * A crash mid-write leaves the previous file intact rather than a truncated one.
 */
export function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = { version: SETTINGS_FILE_VERSION, ...settings };
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function deleteSettingsFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Nothing to remove.
  }
}

/**
 * The last config entry in the session branch wins wholesale: a later entry replaces
 * the override set rather than merging, so writing `{}` clears every override.
 */
export function readSessionOverrides(branch: readonly unknown[] | undefined): RawSettings {
  return readSessionOverridesWithSource(branch).settings;
}

export interface SessionOverridesRead {
  settings: RawSettings;
  legacy: boolean;
}

/** Canonical entries win over deprecated entries; the last entry within that type wins. */
export function readSessionOverridesWithSource(
  branch: readonly unknown[] | undefined,
): SessionOverridesRead {
  if (!Array.isArray(branch)) return { settings: {}, legacy: false };
  let latestCanonical: RawSettings | undefined;
  let latestLegacy: RawSettings | undefined;
  for (const entry of branch) {
    const candidate = entry as { type?: string; customType?: string; data?: unknown };
    if (
      candidate?.type !== 'custom' ||
      (candidate.customType !== SESSION_ENTRY_TYPE &&
        candidate.customType !== LEGACY_SESSION_ENTRY_TYPE)
    ) {
      continue;
    }
    if (candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)) {
      const normalized = normalizeLegacySettings(candidate.data as Record<string, unknown>);
      if (candidate.customType === SESSION_ENTRY_TYPE) latestCanonical = normalized;
      else latestLegacy = normalized;
    }
  }
  if (latestCanonical) return { settings: latestCanonical, legacy: false };
  if (latestLegacy) return { settings: latestLegacy, legacy: true };
  return { settings: {}, legacy: false };
}

export interface SessionEntryWriter {
  appendEntry(customType: string, data?: unknown): void;
}

/** Persist the full override set for this session (replaces the previous entry). */
export function appendSessionOverrides(pi: SessionEntryWriter, overrides: RawSettings): void {
  pi.appendEntry(SESSION_ENTRY_TYPE, { ...overrides });
}
