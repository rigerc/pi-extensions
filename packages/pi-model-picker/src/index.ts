/**
 * Model Picker Extension
 *
 * Usage:
 *   /models               — open the categorized picker
 *   /model-favorites      — favorites-only picker
 *   /model-quick-switch   — compact favorites palette
 *   Ctrl+Alt+M            — open model picker
 *   Ctrl+Alt+F            — open favorites picker
 *   Ctrl+Alt+P            — quick-switch palette
 *   Ctrl+Alt+N            — cycle favorite models
 *   Ctrl+Alt+1..3         — activate quick slots 1–3
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type ModelPickerState,
  loadState,
  modelKey,
  toggleFavorite,
  moveInFavorites,
  getSlotKey,
  toggleSlotAssignment,
  getSlotBadge,
  getModelPrefs,
  cycleThinkingPref,
  cycleSortMode,
  buildModelByKey,
  staleModel,
  getFavoriteModels,
} from './state.js';

// --- Utility helpers ---

function providerLabel(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

// --- Picker mode ---

type PickerMode = 'providers' | 'palette';

interface ModelPickerOptions {
  allModels: Model<Api>[];
  currentModel: Model<Api> | undefined;
  state: ModelPickerState;
  mode: PickerMode;
  onSelect: (model: Model<Api>) => void;
  onCancel: () => void;
  onToggleFavorite: (model: Model<Api>) => void;
  onAssignSlot: (model: Model<Api>, slot: 1 | 2 | 3) => void;
  onCycleThinking: (model: Model<Api>) => void;
  onCycleSortMode: () => void;
  onReorder: (model: Model<Api>, delta: -1 | 1) => boolean;
  onStateChanged?: () => void;
}

class ModelPickerComponent {
  focused = false;
  private categories: string[] = [];
  private catIndex = 0;
  private rowIndex = 0;
  private byCategory = new Map<string, Model<Api>[]>();
  private searchTerms = new Map<string, string>();
  private searchInput: Input;
  private filteredRows: Model<Api>[] = [];
  private showHelp = false;
  private byKey: Map<string, Model<Api>>;

  constructor(private opts: ModelPickerOptions) {
    this.byKey = buildModelByKey(opts.allModels);
    this.searchInput = new Input();
    this.searchInput.focused = true;
    this.searchInput.onEscape = () => opts.onCancel();
    this.searchInput.onSubmit = () => {
      const selected = this.filteredRows[this.rowIndex];
      if (selected && !this.isStale(selected)) opts.onSelect(selected);
    };
    this.rebuild();
    const cur = opts.currentModel;
    if (cur) {
      const idx = this.filteredRows.findIndex(
        (m) => m.id === cur.id && m.provider === cur.provider,
      );
      this.rowIndex = Math.max(0, idx);
    }
  }

  set focusedState(v: boolean) {
    this.focused = v;
    this.searchInput.focused = v;
  }

  private isStale(model: Model<Api>): boolean {
    return !this.byKey.has(modelKey(model));
  }

  private rebuild(): void {
    this.byKey = buildModelByKey(this.opts.allModels);
    this.byCategory = this.buildCategories();
    this.categories = Array.from(this.byCategory.keys());
    const cur = this.opts.currentModel;
    const currentCategory = this.categories[this.catIndex];
    let startCat = currentCategory;
    if (!startCat || !this.byCategory.has(startCat)) {
      startCat =
        this.opts.mode === 'providers'
          ? cur && this.byCategory.has(cur.provider)
            ? cur.provider
            : this.categories[0]
          : this.categories[0];
    }
    this.catIndex = Math.max(0, this.categories.indexOf(startCat ?? ''));
    const catKey = this.categories[this.catIndex] ?? '';
    this.searchInput.setValue(this.searchTerms.get(catKey) ?? '');
    this.applyFilter();
  }

  private sortModels(models: Model<Api>[]): Model<Api>[] {
    const cur = this.opts.currentModel;
    const { state } = this.opts;
    return [...models].sort((a, b) => {
      const aCur = cur && modelKey(a) === modelKey(cur) ? -1 : 0;
      const bCur = cur && modelKey(b) === modelKey(cur) ? -1 : 0;
      if (aCur !== bCur) return aCur - bCur;
      if (state.sortMode === 'favorites') {
        const aIdx = state.favorites.indexOf(modelKey(a));
        const bIdx = state.favorites.indexOf(modelKey(b));
        const aRank = aIdx >= 0 ? aIdx : Infinity;
        const bRank = bIdx >= 0 ? bIdx : Infinity;
        if (aRank !== bRank) return aRank - bRank;
      } else if (state.sortMode === 'context') {
        const diff = b.contextWindow - a.contextWindow;
        if (diff !== 0) return diff;
      }
      return a.name.localeCompare(b.name);
    });
  }

  private buildCategories(): Map<string, Model<Api>[]> {
    const cur = this.opts.currentModel;
    const { state } = this.opts;

    if (this.opts.mode === 'palette') {
      const rows: Model<Api>[] = [];
      const added = new Set<string>();
      for (const slot of [1, 2, 3] as const) {
        const key = getSlotKey(slot, state);
        if (!key) continue;
        if (added.has(key)) continue;
        rows.push(this.byKey.get(key) ?? staleModel(key));
        added.add(key);
      }
      for (const key of state.favorites) {
        if (added.has(key)) continue;
        const model = this.byKey.get(key);
        if (model) {
          rows.push(model);
          added.add(key);
        }
      }
      return rows.length > 0 ? new Map([['Favorites', rows]]) : new Map();
    }

    // "providers" mode — only available models, grouped by provider
    const map = new Map<string, Model<Api>[]>();
    for (const m of this.opts.allModels) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    for (const [, arr] of map) {
      const sorted = this.sortModels(arr);
      arr.splice(0, arr.length, ...sorted);
    }
    return new Map(
      [...map.entries()].sort(([aKey], [bKey]) => {
        const aCur = cur && aKey === cur.provider ? -1 : 0;
        const bCur = cur && bKey === cur.provider ? -1 : 0;
        if (aCur !== bCur) return aCur - bCur;
        return aKey.localeCompare(bKey);
      }),
    );
  }

  private applyFilter(): void {
    const catKey = this.categories[this.catIndex] ?? '';
    const source = this.byCategory.get(catKey) ?? [];
    const query = (this.searchTerms.get(catKey) ?? '').toLowerCase().trim();
    if (!query) {
      this.filteredRows = source;
    } else {
      this.filteredRows = source.filter((m) => {
        if (m.name.toLowerCase().includes(query)) return true;
        if (m.id.toLowerCase().includes(query)) return true;
        if (m.provider.toLowerCase().includes(query)) return true;
        const prefs = getModelPrefs(modelKey(m), this.opts.state);
        if (prefs.aliases?.some((a) => a.toLowerCase().includes(query))) return true;
        if (prefs.tags?.some((t) => t.toLowerCase().includes(query))) return true;
        return false;
      });
    }
    this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.filteredRows.length - 1));
  }

  private switchCategory(delta: number): void {
    if (this.categories.length === 0) return;
    const oldKey = this.categories[this.catIndex] ?? '';
    this.searchTerms.set(oldKey, this.searchInput.getValue());
    this.catIndex = (this.catIndex + delta + this.categories.length) % this.categories.length;
    const newKey = this.categories[this.catIndex] ?? '';
    this.searchInput.setValue(this.searchTerms.get(newKey) ?? '');
    this.rowIndex = 0;
    this.applyFilter();
  }

  private refresh(): void {
    this.rebuild();
    this.opts.onStateChanged?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.filteredRows.length === 0) return;
      this.rowIndex = this.rowIndex === 0 ? this.filteredRows.length - 1 : this.rowIndex - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.filteredRows.length === 0) return;
      this.rowIndex = this.rowIndex === this.filteredRows.length - 1 ? 0 : this.rowIndex + 1;
      return;
    }
    if (matchesKey(data, Key.ctrl('f'))) {
      const selected = this.filteredRows[this.rowIndex];
      if (selected && !this.isStale(selected)) {
        this.opts.onToggleFavorite(selected);
        this.refresh();
      }
      return;
    }
    if (this.opts.mode === 'palette' && matchesKey(data, Key.ctrl('u'))) {
      const selected = this.filteredRows[this.rowIndex];
      if (selected) {
        const moved = this.opts.onReorder(selected, -1);
        if (moved) {
          this.refresh();
          if (this.rowIndex > 0) this.rowIndex--;
        }
      }
      return;
    }
    if (this.opts.mode === 'palette' && matchesKey(data, Key.ctrl('d'))) {
      const selected = this.filteredRows[this.rowIndex];
      if (selected) {
        const moved = this.opts.onReorder(selected, 1);
        if (moved) {
          this.refresh();
          if (this.rowIndex < this.filteredRows.length - 1) this.rowIndex++;
        }
      }
      return;
    }
    for (const slot of [1, 2, 3] as const) {
      if (matchesKey(data, Key.ctrl(String(slot) as '1'))) {
        const selected = this.filteredRows[this.rowIndex];
        if (selected && !this.isStale(selected)) {
          this.opts.onAssignSlot(selected, slot);
          this.refresh();
        }
        return;
      }
    }
    if (matchesKey(data, Key.ctrl('t'))) {
      const selected = this.filteredRows[this.rowIndex];
      if (selected && !this.isStale(selected)) {
        this.opts.onCycleThinking(selected);
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl('s'))) {
      this.opts.onCycleSortMode();
      this.refresh();
      return;
    }
    if (data === '?') {
      this.showHelp = !this.showHelp;
      this.opts.onStateChanged?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.switchCategory(1);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.switchCategory(-1);
      return;
    }
    if (matchesKey(data, Key.left) && this.searchInput.getValue() === '') {
      this.switchCategory(-1);
      return;
    }
    if (matchesKey(data, Key.right) && this.searchInput.getValue() === '') {
      this.switchCategory(1);
      return;
    }
    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const after = this.searchInput.getValue();
    if (before !== after) {
      const catKey = this.categories[this.catIndex] ?? '';
      this.searchTerms.set(catKey, after);
      this.rowIndex = 0;
      this.applyFilter();
    }
  }

  render(width: number, theme: any): string[] {
    const lines: string[] = [];
    lines.push(this.renderTabs(width, theme));
    lines.push(theme.fg('border', '─'.repeat(width)));
    const prompt = theme.fg('muted', '  Search: ');
    const promptW = visibleWidth('  Search: ');
    const inputLines = this.searchInput.render(width - promptW);
    lines.push(prompt + (inputLines[0] ?? ''));
    lines.push(theme.fg('border', '─'.repeat(width)));

    const maxVisible = this.opts.mode === 'palette' ? 14 : 10;
    const half = Math.floor(maxVisible / 2);
    const rows = this.filteredRows;
    const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - maxVisible));
    const visible = rows.slice(start, start + maxVisible);

    // Pre-compute table column widths for palette mode
    let paletteCols: { nameW: number; provW: number } | undefined;
    if (this.opts.mode === 'palette' && rows.length > 0) {
      const PREFIX = 2;
      const SEP = 2;
      const allCells = rows.map((m) => this.rowCells(m));
      const maxProvW = Math.max(...allCells.map((c) => visibleWidth(c.prov)));
      const maxRightW = Math.max(...allCells.map((c) => visibleWidth(c.right)));
      const nameW = Math.max(width - PREFIX - SEP - maxProvW - SEP - maxRightW, 10);
      paletteCols = { nameW, provW: maxProvW };
    }

    if (rows.length === 0) {
      const query = this.searchInput.getValue();
      const msg = query ? `  No models match "${query}"` : '  No models in this category';
      lines.push(theme.fg('muted', msg));
    } else {
      for (let i = 0; i < visible.length; i++) {
        const model = visible[i]!;
        const absIdx = start + i;
        const isSelected = absIdx === this.rowIndex;
        lines.push(this.renderRow(model, isSelected, width, theme, paletteCols));
      }
      if (rows.length > maxVisible) {
        const shown = `${start + 1}–${Math.min(start + maxVisible, rows.length)} of ${rows.length}`;
        lines.push(theme.fg('dim', '  ' + shown));
      }
    }

    lines.push(theme.fg('border', '─'.repeat(width)));
    if (this.showHelp) {
      lines.push(...this.renderHelp(width, theme));
    } else {
      const sortLabel = `sort:${this.opts.state.sortMode}`;
      const help =
        this.opts.mode === 'palette'
          ? '↑↓ navigate · search · enter select · esc cancel · ? help'
          : `↑↓ navigate · Tab/← → category · Ctrl+F fav · Ctrl+S ${sortLabel} · ? help`;
      lines.push(theme.fg('dim', truncateToWidth('  ' + help, width)));
    }
    return lines;
  }

  private renderHelp(width: number, theme: any): string[] {
    const controls: [string, string][] = [
      ['↑ / ↓', 'Navigate models'],
      ['Tab / Shift+Tab', 'Switch category'],
      ['← / →', 'Switch category (empty search)'],
      ['Enter', 'Select model'],
      ['Esc', 'Cancel'],
      ['Ctrl+F', 'Toggle favorite (★)'],
      ['Ctrl+U / Ctrl+D', 'Reorder favorite up/down'],
      ['Ctrl+1/2/3', 'Assign/unassign quick slot [n]'],
      ['Ctrl+T', 'Cycle preferred thinking level (✦)'],
      ['Ctrl+S', 'Cycle sort mode'],
      ['?', 'Toggle this help'],
    ];
    return controls.map(([key, desc]) => {
      const keyPart = theme.fg('accent', key.padEnd(20));
      return truncateToWidth('  ' + keyPart + theme.fg('muted', desc), width);
    });
  }

  private renderTabs(width: number, theme: any): string {
    const total = this.categories.length;
    if (total === 0) {
      return theme.fg('muted', truncateToWidth('  No favorite models yet', width));
    }
    const active = this.catIndex;
    const arrowW = 4;
    const sepW = 1;
    const availForTabs = width - arrowW;
    let lo = active;
    let hi = active;
    let used = visibleWidth(` ${this.categories[active]!} `);
    while (true) {
      let expanded = false;
      if (hi + 1 < total) {
        const w = sepW + visibleWidth(` ${this.categories[hi + 1]!} `);
        if (used + w <= availForTabs) {
          hi++;
          used += w;
          expanded = true;
        }
      }
      if (lo - 1 >= 0) {
        const w = sepW + visibleWidth(` ${this.categories[lo - 1]!} `);
        if (used + w <= availForTabs) {
          lo--;
          used += w;
          expanded = true;
        }
      }
      if (!expanded) break;
    }
    const segments: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const raw = this.categories[i]!;
      const label = ` ${this.opts.mode === 'providers' ? providerLabel(raw) : raw} `;
      segments.push(
        i === active ? theme.fg('accent', theme.bold(label)) : theme.fg('muted', label),
      );
    }
    const tabPart = segments.join(theme.fg('dim', '│'));
    const leftPart = lo > 0 ? theme.fg('dim', '◀ ') : '  ';
    const rightPart = hi < total - 1 ? theme.fg('dim', ' ▶') : '  ';
    return truncateToWidth(leftPart + tabPart + rightPart, width);
  }

  private rowCells(model: Model<Api>): {
    stale: boolean;
    dec: string;
    right: string;
    prov: string;
  } {
    const key = modelKey(model);
    const stale = this.isStale(model);
    const curMark =
      this.opts.currentModel?.id === model.id && this.opts.currentModel?.provider === model.provider
        ? ' ●'
        : '';
    const favMark = this.opts.state.favorites.includes(key) ? ' ★' : '';
    const slotBadge = getSlotBadge(key, this.opts.state);
    const slotMark = slotBadge ? ` ${slotBadge}` : '';
    const prefs = getModelPrefs(key, this.opts.state);
    const thinkingMark =
      prefs.thinkingLevel && prefs.thinkingLevel !== 'off' ? ` ✦${prefs.thinkingLevel[0]}` : '';
    const staleMark = stale ? ' ~' : '';
    const dec = curMark + favMark + slotMark + thinkingMark + staleMark;
    const ctxStr = stale ? '' : fmtCtx(model.contextWindow);
    const modelTags: string[] = [];
    if (!stale && model.reasoning) modelTags.push('thinking');
    if (!stale && (model.input as string[]).includes('image')) modelTags.push('vision');
    const right = stale
      ? 'stale'
      : `${ctxStr}${modelTags.length > 0 ? `  ${modelTags.join(' ')}` : ''}`;
    return { stale, dec, right, prov: providerLabel(model.provider) };
  }

  private renderRow(
    model: Model<Api>,
    isSelected: boolean,
    width: number,
    theme: any,
    cols?: { nameW: number; provW: number },
  ): string {
    const { stale, dec, right, prov } = this.rowCells(model);
    const isCurrent =
      this.opts.currentModel?.id === model.id &&
      this.opts.currentModel?.provider === model.provider;
    const prefix = isSelected ? '▶ ' : '  ';

    if (cols) {
      // Palette: fixed table columns  prefix | name+dec | prov | right
      const nameDec = truncateToWidth(model.name + dec, cols.nameW);
      const nameCell = nameDec + ' '.repeat(Math.max(0, cols.nameW - visibleWidth(nameDec)));
      const provCell =
        truncateToWidth(prov, cols.provW) +
        ' '.repeat(Math.max(0, cols.provW - visibleWidth(prov)));
      if (stale)
        return theme.fg(
          'dim',
          truncateToWidth(`${prefix}${nameCell}  ${provCell}  ${right}`, width),
        );
      if (isSelected)
        return (
          theme.fg('accent', `${prefix}${nameCell}`) +
          '  ' +
          theme.fg('dim', provCell) +
          '  ' +
          theme.fg('accent', theme.bold(right))
        );
      if (isCurrent)
        return (
          theme.fg('success', `${prefix}${nameCell}`) +
          '  ' +
          theme.fg('dim', provCell) +
          '  ' +
          theme.fg('muted', right)
        );
      return (
        theme.fg('text', `${prefix}${nameCell}`) +
        '  ' +
        theme.fg('dim', provCell) +
        '  ' +
        theme.fg('dim', right)
      );
    }

    // Providers: name fills remaining space, right is right-aligned
    const nameAvail = Math.max(
      width - visibleWidth(prefix) - visibleWidth(dec) - visibleWidth(right) - 2,
      10,
    );
    const nameTrunc = truncateToWidth(model.name, nameAvail);
    const gap = ' '.repeat(
      Math.max(0, width - visibleWidth(prefix + nameTrunc + dec) - visibleWidth(right)),
    );
    if (stale)
      return theme.fg('dim', truncateToWidth(prefix + nameTrunc + dec + gap + right, width));
    if (isSelected)
      return (
        theme.fg('accent', prefix + nameTrunc + dec) + gap + theme.fg('accent', theme.bold(right))
      );
    if (isCurrent)
      return theme.fg('success', prefix + nameTrunc + dec) + gap + theme.fg('muted', right);
    return theme.fg('text', prefix + nameTrunc + dec) + gap + theme.fg('dim', right);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }
}

export default function modelPickerExtension(pi: ExtensionAPI) {
  function getAvailableModels(ctx: ExtensionContext): Model<Api>[] {
    ctx.modelRegistry.refresh();
    return ctx.modelRegistry.getAvailable();
  }

  async function setSelectedModel(
    model: Model<Api>,
    ctx: ExtensionContext,
    state: ModelPickerState,
  ): Promise<void> {
    const success = await pi.setModel(model);
    if (!success) {
      ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, 'error');
      return;
    }
    const prefs = getModelPrefs(modelKey(model), state);
    if (prefs.thinkingLevel) {
      pi.setThinkingLevel(prefs.thinkingLevel);
      ctx.ui.notify(`Model: ${model.name}  thinking: ${prefs.thinkingLevel}`, 'info');
    } else {
      ctx.ui.notify(`Model: ${model.name}`, 'info');
    }
  }

  async function cycleFavorite(ctx: ExtensionContext): Promise<void> {
    const state = loadState();
    const favoriteModels = getFavoriteModels(getAvailableModels(ctx), state);
    if (favoriteModels.length === 0) {
      ctx.ui.notify(
        'No favorite models. Open /models and press Ctrl+F to mark favorites.',
        'warning',
      );
      return;
    }
    const currentKey = ctx.model ? modelKey(ctx.model) : '';
    const currentIndex = favoriteModels.findIndex((m) => modelKey(m) === currentKey);
    const next = favoriteModels[(currentIndex + 1) % favoriteModels.length]!;
    await setSelectedModel(next, ctx, state);
  }

  async function switchQuickSlot(ctx: ExtensionContext, slot: 1 | 2 | 3): Promise<void> {
    const state = loadState();
    const key = getSlotKey(slot, state);
    if (!key) {
      ctx.ui.notify(
        `Quick slot ${slot} is empty. Open /models and press Ctrl+${slot} to assign.`,
        'warning',
      );
      return;
    }
    const byKey = buildModelByKey(getAvailableModels(ctx));
    const model = byKey.get(key);
    if (!model) {
      ctx.ui.notify(
        `Quick slot ${slot} model is no longer available (stale). Reassign with Ctrl+${slot} in the picker.`,
        'warning',
      );
      return;
    }
    await setSelectedModel(model, ctx, state);
  }

  async function openPicker(ctx: ExtensionContext, mode: PickerMode = 'providers'): Promise<void> {
    const allModels = getAvailableModels(ctx);
    if (allModels.length === 0) {
      ctx.ui.notify('No models available', 'warning');
      return;
    }
    const state = loadState();
    let pickerRef: ModelPickerComponent | undefined;
    const selected = await ctx.ui.custom<Model<Api> | null>(
      (tui, theme, _kb, done) => {
        const refresh = () => {
          pickerRef?.invalidate();
          tui.requestRender();
        };
        pickerRef = new ModelPickerComponent({
          allModels,
          currentModel: ctx.model ?? undefined,
          state,
          mode,
          onSelect: (m) => done(m),
          onCancel: () => done(null),
          onStateChanged: refresh,
          onToggleFavorite: (m) => {
            const added = toggleFavorite(m, state);
            ctx.ui.notify(`${added ? 'Favorited' : 'Unfavorited'}: ${m.name}`, 'info');
          },
          onAssignSlot: (m, slot) => {
            const assigned = toggleSlotAssignment(slot, modelKey(m), state);
            ctx.ui.notify(assigned ? `Slot ${slot} → ${m.name}` : `Slot ${slot} cleared`, 'info');
          },
          onCycleThinking: (m) => {
            const level = cycleThinkingPref(modelKey(m), state);
            ctx.ui.notify(`${m.name} thinking: ${level}`, 'info');
          },
          onCycleSortMode: () => {
            const newMode = cycleSortMode(state);
            ctx.ui.notify(`Sort: ${newMode}`, 'info');
          },
          onReorder: (m, delta) => moveInFavorites(modelKey(m), delta, state),
        });
        pickerRef.focusedState = true;
        const header = new Container();
        header.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        const title = mode === 'palette' ? '  Quick Switch' : '  Select Model';
        header.addChild(new Text(theme.fg('accent', theme.bold(title)), 0, 0));
        const footer = new DynamicBorder((s: string) => theme.fg('accent', s));
        return {
          focused: true,
          render(width: number): string[] {
            return [
              ...header.render(width),
              ...pickerRef!.render(width, theme),
              ...footer.render(width),
            ];
          },
          invalidate() {
            header.invalidate();
            pickerRef!.invalidate();
          },
          handleInput(data: string) {
            pickerRef!.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true },
    );
    if (!selected) return;
    await setSelectedModel(selected, ctx, state);
  }

  pi.registerCommand('models', {
    description: 'Select model by provider category with search',
    handler: async (_args, ctx) => openPicker(ctx, 'providers'),
  });
  pi.registerCommand('model-quick-switch', {
    description: 'Open compact quick-switch palette for favorites',
    handler: async (_args, ctx) => openPicker(ctx, 'palette'),
  });
  pi.registerCommand('model-next-favorite', {
    description: 'Switch to the next favorite model',
    handler: async (_args, ctx) => cycleFavorite(ctx),
  });

  pi.registerShortcut(Key.ctrlAlt('m'), {
    description: 'Open categorized model picker',
    handler: async (ctx) => openPicker(ctx, 'providers'),
  });
  pi.registerShortcut(Key.ctrlAlt('f'), {
    description: 'Open quick-switch palette',
    handler: async (ctx) => openPicker(ctx, 'palette'),
  });
  pi.registerShortcut(Key.ctrlAlt('p'), {
    description: 'Open quick-switch palette',
    handler: async (ctx) => openPicker(ctx, 'palette'),
  });
  pi.registerShortcut(Key.ctrlAlt('n'), {
    description: 'Switch to next favorite model',
    handler: async (ctx) => cycleFavorite(ctx),
  });
  for (const slot of [1, 2, 3] as const) {
    pi.registerShortcut(Key.ctrlAlt(String(slot) as '1'), {
      description: `Activate quick slot ${slot}`,
      handler: async (ctx) => switchQuickSlot(ctx, slot),
    });
  }
}
