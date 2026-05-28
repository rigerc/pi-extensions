import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';

// --- Types ---

export type ThinkingPref = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type SortMode = 'favorites' | 'provider' | 'name' | 'context';

export const THINKING_PREFS: ThinkingPref[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const SORT_MODES: SortMode[] = ['favorites', 'provider', 'name', 'context'];

export type ModelPrefs = {
  thinkingLevel?: ThinkingPref;
  aliases?: string[];
  tags?: string[];
};

export type ModelPickerState = {
  version: 2;
  favorites: string[];
  quickSlots: { '1': string | null; '2': string | null; '3': string | null };
  modelPrefs: Record<string, ModelPrefs>;
  sortMode: SortMode;
};

// --- Path ---

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (!envDir) return join(homedir(), '.pi', 'agent');
  if (envDir === '~') return homedir();
  if (envDir.startsWith('~/')) return join(homedir(), envDir.slice(2));
  return envDir;
}

export const STATE_PATH = join(getAgentDir(), 'pi-model-picker', 'favorites.json');

// --- State management ---

export function defaultState(): ModelPickerState {
  return {
    version: 2,
    favorites: [],
    quickSlots: { '1': null, '2': null, '3': null },
    modelPrefs: {},
    sortMode: 'favorites',
  };
}

export function loadState(): ModelPickerState {
  try {
    if (!existsSync(STATE_PATH)) return defaultState();
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Record<string, unknown>;
    const cleanFavs = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? [...new Set((arr as unknown[]).filter((v): v is string => typeof v === 'string'))]
        : [];

    // Migrate v1 (no version field) → v2
    if (!raw.version || raw.version !== 2) {
      return { ...defaultState(), favorites: cleanFavs(raw.favorites) };
    }

    const state = defaultState();
    state.favorites = cleanFavs(raw.favorites);
    if (raw.quickSlots && typeof raw.quickSlots === 'object') {
      const qs = raw.quickSlots as Record<string, unknown>;
      state.quickSlots['1'] = typeof qs['1'] === 'string' ? qs['1'] : null;
      state.quickSlots['2'] = typeof qs['2'] === 'string' ? qs['2'] : null;
      state.quickSlots['3'] = typeof qs['3'] === 'string' ? qs['3'] : null;
    }
    if (raw.modelPrefs && typeof raw.modelPrefs === 'object') {
      state.modelPrefs = raw.modelPrefs as Record<string, ModelPrefs>;
    }
    if (SORT_MODES.includes(raw.sortMode as SortMode)) {
      state.sortMode = raw.sortMode as SortMode;
    }
    return state;
  } catch {
    return defaultState();
  }
}

export function saveState(state: ModelPickerState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// --- Model key ---

export function modelKey(model: Pick<Model<Api>, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

// --- Favorites ---

export function toggleFavorite(
  model: Pick<Model<Api>, 'provider' | 'id'>,
  state: ModelPickerState,
): boolean {
  const key = modelKey(model);
  if (state.favorites.includes(key)) {
    state.favorites = state.favorites.filter((k) => k !== key);
    saveState(state);
    return false;
  }
  state.favorites.push(key);
  saveState(state);
  return true;
}

export function moveInFavorites(key: string, delta: -1 | 1, state: ModelPickerState): boolean {
  const idx = state.favorites.indexOf(key);
  if (idx === -1) return false;
  const next = idx + delta;
  if (next < 0 || next >= state.favorites.length) return false;
  [state.favorites[idx], state.favorites[next]] = [state.favorites[next]!, state.favorites[idx]!];
  saveState(state);
  return true;
}

// --- Quick slots ---

export function getSlotKey(slot: 1 | 2 | 3, state: ModelPickerState): string | null {
  return state.quickSlots[String(slot) as '1' | '2' | '3'];
}

export function toggleSlotAssignment(
  slot: 1 | 2 | 3,
  key: string,
  state: ModelPickerState,
): boolean {
  const slotStr = String(slot) as '1' | '2' | '3';
  const isAssigned = state.quickSlots[slotStr] === key;
  state.quickSlots[slotStr] = isAssigned ? null : key;
  saveState(state);
  return !isAssigned;
}

export function getSlotBadge(key: string, state: ModelPickerState): string {
  const slots: string[] = [];
  if (state.quickSlots['1'] === key) slots.push('1');
  if (state.quickSlots['2'] === key) slots.push('2');
  if (state.quickSlots['3'] === key) slots.push('3');
  return slots.length > 0 ? `[${slots.join(',')}]` : '';
}

// --- Model prefs ---

export function getModelPrefs(key: string, state: ModelPickerState): ModelPrefs {
  return state.modelPrefs[key] ?? {};
}

export function cycleThinkingPref(key: string, state: ModelPickerState): ThinkingPref {
  const prefs = getModelPrefs(key, state);
  const cur = prefs.thinkingLevel ?? 'off';
  const idx = THINKING_PREFS.indexOf(cur);
  const next = THINKING_PREFS[(idx + 1) % THINKING_PREFS.length]!;
  state.modelPrefs[key] = { ...prefs, thinkingLevel: next };
  saveState(state);
  return next;
}

// --- Sort mode ---

export function cycleSortMode(state: ModelPickerState): SortMode {
  const idx = SORT_MODES.indexOf(state.sortMode);
  state.sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length]!;
  saveState(state);
  return state.sortMode;
}

// --- Stale detection ---

export function buildModelByKey(models: Model<Api>[]): Map<string, Model<Api>> {
  return new Map(models.map((m) => [modelKey(m), m]));
}

export function staleModel(key: string): Model<Api> {
  const [provider = '', id = key] = key.split('/');
  return {
    provider,
    id,
    name: id,
    contextWindow: 0,
    reasoning: false,
    input: [],
    output: [],
  } as unknown as Model<Api>;
}

export function getFavoriteModels(models: Model<Api>[], state: ModelPickerState): Model<Api>[] {
  const byKey = buildModelByKey(models);
  return state.favorites.map((key) => byKey.get(key)).filter((m): m is Model<Api> => Boolean(m));
}
