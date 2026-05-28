import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';

// Point the module at a temp dir before first import
const testAgentDir = join(tmpdir(), `pi-model-picker-test-${Date.now()}`);
process.env.PI_CODING_AGENT_DIR = testAgentDir;

// Dynamic import so the env var is set before the module initialises STATE_PATH
const stateModule = await import('./state.js');
const {
  loadState,
  saveState,
  toggleFavorite,
  toggleSlotAssignment,
  getSlotKey,
  getSlotBadge,
  cycleThinkingPref,
  cycleSortMode,
  getModelPrefs,
  STATE_PATH,
} = stateModule;

function writeRaw(obj: unknown): void {
  mkdirSync(join(testAgentDir, 'pi-model-picker'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(obj));
}

function clearState(): void {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
}

describe('state migration', () => {
  beforeEach(clearState);

  it('returns default state when file is missing', () => {
    const s = loadState();
    expect(s.version).toBe(2);
    expect(s.favorites).toEqual([]);
    expect(s.quickSlots).toEqual({ '1': null, '2': null, '3': null });
    expect(s.sortMode).toBe('favorites');
  });

  it('migrates v1 favorites-only state', () => {
    writeRaw({ favorites: ['anthropic/claude-3-5-sonnet', 'google/gemini-pro'] });
    const s = loadState();
    expect(s.version).toBe(2);
    expect(s.favorites).toEqual(['anthropic/claude-3-5-sonnet', 'google/gemini-pro']);
    expect(s.quickSlots).toEqual({ '1': null, '2': null, '3': null });
  });

  it('deduplicates favorites on v1 load', () => {
    writeRaw({ favorites: ['a/b', 'a/b', 'c/d'] });
    const s = loadState();
    expect(s.favorites).toEqual(['a/b', 'c/d']);
  });

  it('loads v2 state fully', () => {
    writeRaw({
      version: 2,
      favorites: ['anthropic/claude-sonnet-4-6'],
      quickSlots: { '1': 'anthropic/claude-sonnet-4-6', '2': null, '3': null },
      modelPrefs: { 'anthropic/claude-sonnet-4-6': { thinkingLevel: 'medium' } },
      sortMode: 'context',
    });
    const s = loadState();
    expect(s.favorites).toEqual(['anthropic/claude-sonnet-4-6']);
    expect(s.quickSlots['1']).toBe('anthropic/claude-sonnet-4-6');
    expect(s.modelPrefs['anthropic/claude-sonnet-4-6']?.thinkingLevel).toBe('medium');
    expect(s.sortMode).toBe('context');
  });

  it('falls back to default on invalid JSON', () => {
    mkdirSync(join(testAgentDir, 'pi-model-picker'), { recursive: true });
    writeFileSync(STATE_PATH, 'not-json');
    const s = loadState();
    expect(s.version).toBe(2);
    expect(s.favorites).toEqual([]);
  });
});

describe('favorites', () => {
  beforeEach(clearState);

  it('toggles favorite on and off', () => {
    const s = loadState();
    const model = { provider: 'anthropic', id: 'claude-3-5-sonnet' };
    expect(toggleFavorite(model, s)).toBe(true);
    expect(s.favorites).toContain('anthropic/claude-3-5-sonnet');
    expect(toggleFavorite(model, s)).toBe(false);
    expect(s.favorites).not.toContain('anthropic/claude-3-5-sonnet');
  });

  it('persists favorites to disk', () => {
    const s = loadState();
    toggleFavorite({ provider: 'anthropic', id: 'claude-sonnet-4-6' }, s);
    const s2 = loadState();
    expect(s2.favorites).toContain('anthropic/claude-sonnet-4-6');
  });
});

describe('quick slots', () => {
  beforeEach(clearState);

  it('assigns and unassigns a slot', () => {
    const s = loadState();
    const key = 'anthropic/claude-sonnet-4-6';
    expect(toggleSlotAssignment(1, key, s)).toBe(true);
    expect(getSlotKey(1, s)).toBe(key);
    expect(getSlotBadge(key, s)).toBe('[1]');
    expect(toggleSlotAssignment(1, key, s)).toBe(false);
    expect(getSlotKey(1, s)).toBeNull();
    expect(getSlotBadge(key, s)).toBe('');
  });

  it('shows multi-slot badge when model assigned to multiple slots', () => {
    const s = loadState();
    const key = 'anthropic/claude-sonnet-4-6';
    toggleSlotAssignment(1, key, s);
    toggleSlotAssignment(3, key, s);
    expect(getSlotBadge(key, s)).toBe('[1,3]');
  });

  it('slots are independent from each other', () => {
    const s = loadState();
    toggleSlotAssignment(1, 'a/m1', s);
    toggleSlotAssignment(2, 'a/m2', s);
    expect(getSlotKey(1, s)).toBe('a/m1');
    expect(getSlotKey(2, s)).toBe('a/m2');
    expect(getSlotKey(3, s)).toBeNull();
  });
});

describe('thinking prefs', () => {
  beforeEach(clearState);

  it('cycles through all thinking levels and wraps', () => {
    const s = loadState();
    const key = 'anthropic/claude-sonnet-4-6';
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'off', 'minimal'];
    for (const expected of order) {
      expect(cycleThinkingPref(key, s)).toBe(expected);
    }
  });

  it('stores thinking pref in modelPrefs', () => {
    const s = loadState();
    const key = 'anthropic/claude-sonnet-4-6';
    cycleThinkingPref(key, s);
    expect(getModelPrefs(key, s).thinkingLevel).toBe('minimal');
  });
});

describe('sort mode', () => {
  beforeEach(clearState);

  it('cycles through sort modes and wraps', () => {
    const s = loadState();
    expect(s.sortMode).toBe('favorites');
    expect(cycleSortMode(s)).toBe('provider');
    expect(cycleSortMode(s)).toBe('name');
    expect(cycleSortMode(s)).toBe('context');
    expect(cycleSortMode(s)).toBe('favorites');
  });
});

describe('moveInFavorites', () => {
  beforeEach(clearState);

  it('moves a favorite up', async () => {
    const { moveInFavorites } = await import('./state.js');
    const s = loadState();
    s.favorites = ['a/1', 'a/2', 'a/3'];
    expect(moveInFavorites('a/2', -1, s)).toBe(true);
    expect(s.favorites).toEqual(['a/2', 'a/1', 'a/3']);
  });

  it('moves a favorite down', async () => {
    const { moveInFavorites } = await import('./state.js');
    const s = loadState();
    s.favorites = ['a/1', 'a/2', 'a/3'];
    expect(moveInFavorites('a/2', 1, s)).toBe(true);
    expect(s.favorites).toEqual(['a/1', 'a/3', 'a/2']);
  });

  it('does nothing at the top boundary', async () => {
    const { moveInFavorites } = await import('./state.js');
    const s = loadState();
    s.favorites = ['a/1', 'a/2'];
    expect(moveInFavorites('a/1', -1, s)).toBe(false);
    expect(s.favorites).toEqual(['a/1', 'a/2']);
  });

  it('does nothing at the bottom boundary', async () => {
    const { moveInFavorites } = await import('./state.js');
    const s = loadState();
    s.favorites = ['a/1', 'a/2'];
    expect(moveInFavorites('a/2', 1, s)).toBe(false);
    expect(s.favorites).toEqual(['a/1', 'a/2']);
  });

  it('returns false for non-favorite key', async () => {
    const { moveInFavorites } = await import('./state.js');
    const s = loadState();
    s.favorites = ['a/1'];
    expect(moveInFavorites('x/y', -1, s)).toBe(false);
  });
});

describe('alias/tag search helpers', () => {
  beforeEach(clearState);

  it('getModelPrefs returns empty object for unknown key', () => {
    const s = loadState();
    expect(getModelPrefs('x/y', s)).toEqual({});
  });

  it('stored aliases and tags are retrievable', () => {
    const s = loadState();
    s.modelPrefs['a/m'] = { aliases: ['fast', 'quick'], tags: ['vision'] };
    saveState(s);
    const s2 = loadState();
    expect(s2.modelPrefs['a/m']?.aliases).toEqual(['fast', 'quick']);
    expect(s2.modelPrefs['a/m']?.tags).toEqual(['vision']);
  });
});
