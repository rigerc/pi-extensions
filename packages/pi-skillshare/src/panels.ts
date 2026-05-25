/**
 * TUI panel components for the skillshare extension.
 *
 * Contains:
 *   - TabBar         – horizontal tab bar
 *   - SearchPanel    – search + multi-select + install
 *   - InstalledPanel – list installed skills with actions
 *   - StatusPanel    – health dashboard
 *   - SettingsPanel  – extension configuration
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, Key, truncateToWidth } from '@earendil-works/pi-tui';
import type { SkillSearchResult, InstalledSkill, SkillshareConfig } from './utils';
import {
  searchSkillsAsync,
  installSkillAsync,
  uninstallSkillAsync,
  listInstalledSkills,
  syncSkills,
  updateSkills,
  runDoctor,
  startSpinner,
  formatStars,
} from './utils';

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

export type TabId = 'search' | 'installed' | 'status' | 'settings';

export interface TabDef {
  id: TabId;
  label: string;
}

/** Three-tab layout used by /skillshare (search + installed + status). */
export const SKILLSHARE_TABS: TabDef[] = [
  { id: 'search', label: 'Search' },
  { id: 'installed', label: 'Installed' },
  { id: 'status', label: 'Status' },
];

export class TabBar {
  private cursor = 0;
  private tabs: TabDef[];
  private onTabChange: (tab: TabId) => void;
  private theme: Theme;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, tabs: TabDef[], onTabChange: (tab: TabId) => void) {
    this.theme = theme;
    this.tabs = tabs;
    this.onTabChange = onTabChange;
  }

  get activeTab(): TabId {
    return this.tabs[this.cursor].id;
  }

  setActiveTab(id: TabId) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx >= 0) this.cursor = idx;
    this.cachedWidth = undefined;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift('tab'))) {
      this.cursor = this.cursor === 0 ? this.tabs.length - 1 : this.cursor - 1;
      this.cachedWidth = undefined;
      this.onTabChange(this.activeTab);
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.cursor = this.cursor === this.tabs.length - 1 ? 0 : this.cursor + 1;
      this.cachedWidth = undefined;
      this.onTabChange(this.activeTab);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const lines: string[] = [];
    let bar = ' ';
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const active = i === this.cursor;
      const sep = i > 0 ? t.fg('borderMuted', ' │ ') : ' ';
      const label = active
        ? t.fg('accent', t.bold(` ${tab.label} `))
        : t.fg('muted', ` ${tab.label} `);
      bar += `${sep}${label}`;
    }
    lines.push(truncateToWidth(bar, width));

    // Divider line
    const divider = t.fg('borderMuted', '─'.repeat(width));
    lines.push(divider);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ---------------------------------------------------------------------------
// Search Panel
// ---------------------------------------------------------------------------

export interface SearchPanelCallbacks {
  onNotify: (msg: string, type: 'info' | 'success' | 'error') => void;
  onSetStatus: (msg: string) => void;
  onClearStatus: () => void;
  onClose: () => void;
  onRequestRender: () => void;
}

export class SearchPanel {
  private query: string;
  private results: SkillSearchResult[] = [];
  private checked: boolean[] = [];
  private cursor = 0;
  private config: SkillshareConfig;
  private callbacks: SearchPanelCallbacks;
  private theme: Theme;
  private searching = false;
  private installedNames: Set<string>;
  private sortOrder: 'relevance' | 'desc' | 'asc' = 'relevance';
  private originalResults: SkillSearchResult[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    config: SkillshareConfig,
    theme: Theme,
    callbacks: SearchPanelCallbacks,
    initialQuery: string,
    initialResults?: SkillSearchResult[],
  ) {
    this.config = config;
    this.theme = theme;
    this.callbacks = callbacks;
    this.query = initialQuery;
    this.installedNames = new Set(
      listInstalledSkills(config.installMode === 'project').map((s) => s.name),
    );

    if (initialResults !== undefined) {
      this.results = initialResults;
      this.originalResults = [...initialResults];
      this.checked = new Array(initialResults.length).fill(false);
    } else if (this.query) {
      void this.runSearch();
    }
  }

  handleInput(data: string) {
    if (this.searching) return;

    if (matchesKey(data, Key.enter) && this.results.length > 0) {
      void this.installSelected();
      return;
    }

    if (matchesKey(data, Key.space) && this.results.length > 0) {
      if (this.cursor < this.checked.length) {
        this.checked[this.cursor] = !this.checked[this.cursor];
        this.cachedWidth = undefined;
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      if (this.results.length > 0) {
        this.cursor = Math.max(0, this.cursor - 1);
        this.cachedWidth = undefined;
      }
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      if (this.results.length > 0) {
        this.cursor = Math.min(this.results.length - 1, this.cursor + 1);
        this.cachedWidth = undefined;
      }
      return;
    }

    if (matchesKey(data, 's') && !this.query) {
      // 's' to search when idle — handled by main panel
    }

    if (matchesKey(data, 'o') && this.results.length > 0) {
      // Cycle: relevance → desc → asc → relevance
      if (this.sortOrder === 'relevance') {
        this.sortOrder = 'desc';
        this.results = [...this.originalResults];
        this.results.sort((a, b) => b.Stars - a.Stars);
      } else if (this.sortOrder === 'desc') {
        this.sortOrder = 'asc';
        this.results.sort((a, b) => a.Stars - b.Stars);
      } else {
        this.sortOrder = 'relevance';
        this.results = [...this.originalResults];
      }
      this.cursor = 0;
      this.cachedWidth = undefined;
      return;
    }
  }

  async runSearch(newQuery?: string) {
    if (newQuery !== undefined) this.query = newQuery;
    if (!this.query) return;

    this.searching = true;
    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();

    const stopSpinner = startSpinner(this.callbacks.onSetStatus, `searching "${this.query}"...`);

    try {
      this.results = await searchSkillsAsync(
        this.query,
        this.config.searchLimit,
        this.config.hubMode,
      );
      // Keep original order from skillshare (relevance-based by default)
      this.originalResults = [...this.results];
      if (this.sortOrder !== 'relevance') {
        this.results.sort((a, b) =>
          this.sortOrder === 'desc' ? b.Stars - a.Stars : a.Stars - b.Stars,
        );
      }
      this.checked = new Array(this.results.length).fill(false);
      this.cursor = 0;
    } catch (err: unknown) {
      this.results = [];
      this.checked = [];
      this.callbacks.onNotify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      stopSpinner();
      this.callbacks.onClearStatus();
      this.searching = false;
      this.cachedWidth = undefined;
      this.callbacks.onRequestRender();
    }
  }

  private async installSelected() {
    const selected: number[] = [];
    for (let i = 0; i < this.checked.length; i++) {
      if (this.checked[i]) selected.push(i);
    }
    if (selected.length === 0) {
      this.callbacks.onNotify('No skills selected', 'info');
      return;
    }

    const projectMode = this.config.installMode === 'project';
    const modeLabel = projectMode ? 'project' : 'global';

    // Close the TUI panel — install progress is shown via status bar & notifications
    this.callbacks.onSetStatus(`Installing ${selected.length} skill(s) to ${modeLabel}...`);
    this.callbacks.onClose();

    const installed: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (let i = 0; i < selected.length; i++) {
      const skill = this.results[selected[i]];
      this.callbacks.onSetStatus(`Installing ${skill.Name} (${i + 1}/${selected.length})...`);

      // Yield to event loop so the TUI can render status updates
      await new Promise((r) => setTimeout(r, 0));
      this.callbacks.onRequestRender();

      try {
        const result = await installSkillAsync(skill.Source, projectMode);
        const names = result.skills.length > 0 ? result.skills : [skill.Name];
        installed.push(...names);
        for (const f of result.failed) {
          failed.push({ name: f, error: 'CLI reported failure' });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ name: skill.Name, error: message });
      }
    }

    this.callbacks.onClearStatus();

    // Update installed names
    for (const name of installed) {
      this.installedNames.add(name);
    }

    // Report
    if (installed.length > 0) {
      this.callbacks.onNotify(`✓ Installed: ${installed.join(', ')}`, 'success');
      this.callbacks.onNotify('Run sync from the Status panel to distribute', 'info');
    }
    if (failed.length > 0) {
      this.callbacks.onNotify(
        `✗ Failed: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`,
        'error',
      );
    }

    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && !this.searching) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];

    // Query bar
    const queryLine = `${t.fg('accent', 'Search')}: ${this.query || t.fg('dim', '(no query — reopen with a keyword)')}`;
    lines.push(queryLine);
    lines.push('');

    // Searching indicator
    if (this.searching) {
      lines.push(`  ${t.fg('muted', 'Searching...')}`);
      this.cachedLines = lines;
      return lines;
    }

    // No results
    if (this.results.length === 0) {
      if (this.query) {
        lines.push(`  ${t.fg('dim', `No results for "${this.query}"`)}`);
        lines.push('');
        lines.push(
          `  ${t.fg('muted', 'Try different keywords or change hub in /skillshare-settings')}`,
        );
      } else {
        lines.push(`  ${t.fg('dim', 'Run /skillshare <query> to search')}`);
      }
      lines.push('');
      // Key hints
      lines.push(`  ${t.fg('dim', '← → or Tab tabs  |  s  search  |  Esc close')}`);
      this.cachedLines = lines;
      return lines;
    }

    // Results header
    const hubLabel =
      this.config.hubMode === 'community-hub' ? t.fg('muted', ' [community hub]') : '';
    const sortLabel =
      this.sortOrder === 'relevance'
        ? 'relevance'
        : this.sortOrder === 'desc'
          ? '★ high→low'
          : '★ low→high';
    lines.push(
      `  ${t.fg('muted', `${this.results.length} result(s)${hubLabel}`)}  ${t.fg('dim', `[${sortLabel}]`)}`,
    );
    lines.push('');

    // Paginate results
    const visibleCount = Math.min(this.results.length, 14);
    const startOffset = Math.max(
      0,
      Math.min(this.cursor - Math.floor(visibleCount / 2), this.results.length - visibleCount),
    );
    const endIndex = Math.min(startOffset + visibleCount, this.results.length);

    for (let i = startOffset; i < endIndex; i++) {
      const r = this.results[i];
      const isCursor = i === this.cursor;
      const isChecked = this.checked[i];
      const isInstalled = this.installedNames.has(r.Name);

      const checkbox = isChecked ? t.fg('success', '✓') : t.fg('dim', '○');
      const cursorMarker = isCursor ? t.fg('accent', '▸') : ' ';

      const starStr = formatStars(r.Stars);
      const starTag = starStr ? t.fg('warning', ` ★${starStr}`) : '';
      const installedTag = isInstalled ? ` ${t.fg('success', 'installed')}` : '';

      let source = r.Source;
      if (source.length > 34) source = '…' + source.slice(-33);

      const nameWidth = Math.floor(width * 0.32);
      const name = truncateToWidth(`${r.Name}${starTag}${installedTag}`, nameWidth);
      const src = truncateToWidth(source, Math.max(15, width - nameWidth - 8));

      lines.push(
        ` ${cursorMarker} ${checkbox} ${t.fg(isCursor ? 'text' : 'muted', name)} ${t.fg('dim', src)}`,
      );
    }

    {
      const above = startOffset > 0 ? `↑ ${startOffset}` : '';
      const below = endIndex < this.results.length ? `↓ ${this.results.length - endIndex}` : '';
      const more = [above, below].filter(Boolean).join('  ');
      lines.push(more ? `  ${t.fg('dim', more)}` : '');
    }

    // Fixed-height description block — always 3 lines so the footer doesn't jump
    const DESC_LINES = 2;
    const descLines: string[] = [];
    if (this.cursor >= 0 && this.cursor < this.results.length) {
      const focused = this.results[this.cursor];
      if (focused.Description) {
        const maxWidth = Math.max(40, width - 8);
        let line = '';
        for (const word of focused.Description.split(' ')) {
          if (line.length + word.length + 1 > maxWidth) {
            descLines.push(`  ${t.fg('dim', line)}`);
            line = word;
            if (descLines.length >= DESC_LINES) break;
          } else {
            line = line ? line + ' ' + word : word;
          }
        }
        if (line && descLines.length < DESC_LINES) descLines.push(`  ${t.fg('dim', line)}`);
      }
    }
    while (descLines.length < DESC_LINES) descLines.push('');
    lines.push('', ...descLines, '');

    // Status + hints
    const count = this.checked.filter(Boolean).length;
    if (count > 0) {
      lines.push(`  ${t.fg('success', `${count} selected — Enter to install`)}`);
    }
    lines.push(
      `  ${t.fg('dim', '↑↓ navigate  |  Space toggle  |  Enter install  |  o sort  |  ← → or Tab tabs')}`,
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ---------------------------------------------------------------------------
// Installed Panel
// ---------------------------------------------------------------------------

export class InstalledPanel {
  private skills: InstalledSkill[] = [];
  private cursor = 0;
  private checked: boolean[] = [];
  private theme: Theme;
  private config: SkillshareConfig;
  private callbacks: SearchPanelCallbacks;
  private loading = true;
  private actionMsg = '';
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(config: SkillshareConfig, theme: Theme, callbacks: SearchPanelCallbacks) {
    this.config = config;
    this.theme = theme;
    this.callbacks = callbacks;
    this.refresh();
  }

  refresh() {
    this.loading = true;
    this.skills = listInstalledSkills(this.config.installMode === 'project');
    this.cursor = 0;
    this.checked = new Array(this.skills.length).fill(false);
    this.loading = false;
    this.cachedWidth = undefined;
  }

  handleInput(data: string) {
    if (this.loading) return;

    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      if (this.skills.length > 0) {
        this.cursor = Math.max(0, this.cursor - 1);
        this.cachedWidth = undefined;
      }
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      if (this.skills.length > 0) {
        this.cursor = Math.min(this.skills.length - 1, this.cursor + 1);
        this.cachedWidth = undefined;
      }
      return;
    }
    if (matchesKey(data, Key.space) && this.skills.length > 0) {
      if (this.cursor < this.checked.length) {
        this.checked[this.cursor] = !this.checked[this.cursor];
        this.cachedWidth = undefined;
      }
      return;
    }
    if (matchesKey(data, 'u') && this.skills.length > 0) {
      void this.doUninstall();
      return;
    }
    if (matchesKey(data, 'U')) {
      void this.doUpdate();
      return;
    }
    if (matchesKey(data, 'r')) {
      this.refresh();
      this.cachedWidth = undefined;
      this.callbacks.onRequestRender();
      return;
    }
  }

  private async doUninstall() {
    // Determine which skills to uninstall: checked items, or focused if none checked
    const selectedIndices: number[] = [];
    const hasChecked = this.checked.some(Boolean);
    if (hasChecked) {
      for (let i = 0; i < this.checked.length; i++) {
        if (this.checked[i]) selectedIndices.push(i);
      }
    } else if (this.cursor < this.skills.length) {
      selectedIndices.push(this.cursor);
    }

    if (selectedIndices.length === 0) return;

    const projectMode = this.config.installMode === 'project';
    const uninstalled: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    // Close the TUI panel — progress shown via status bar & notifications
    this.callbacks.onSetStatus(`Uninstalling ${selectedIndices.length} skill(s)...`);
    this.callbacks.onClose();

    for (let i = 0; i < selectedIndices.length; i++) {
      const skill = this.skills[selectedIndices[i]];
      const stopSpinner = startSpinner(
        this.callbacks.onSetStatus,
        `Uninstalling ${skill.name} (${i + 1}/${selectedIndices.length})...`,
      );

      try {
        await uninstallSkillAsync(skill.name, projectMode);
        stopSpinner();
        uninstalled.push(skill.name);
      } catch (err: unknown) {
        stopSpinner();
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ name: skill.name, error: message });
      }
    }

    this.callbacks.onClearStatus();

    if (uninstalled.length > 0) {
      this.callbacks.onNotify(`✓ Uninstalled: ${uninstalled.join(', ')}`, 'success');
    }
    if (failed.length > 0) {
      this.callbacks.onNotify(
        `✗ Failed: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`,
        'error',
      );
    }

    this.actionMsg = '';
    this.refresh(); // reloads skills + resets checked
    this.cachedWidth = undefined;
  }

  private async doUpdate() {
    this.actionMsg = 'Updating all skills...';
    this.callbacks.onSetStatus(this.actionMsg);
    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();

    try {
      const output = updateSkills(this.config.installMode === 'project');
      this.callbacks.onNotify('All skills updated', 'success');
      console.log(`skillshare update:\n${output}`);
    } catch (err: unknown) {
      this.callbacks.onNotify(
        `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
    this.actionMsg = '';
    this.callbacks.onClearStatus();
    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && !this.actionMsg) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];
    const modeLabel = this.config.installMode === 'project' ? 'project' : 'global';

    lines.push(t.fg('accent', ` Installed Skills (${modeLabel})`));
    lines.push('');

    if (this.loading) {
      lines.push(`  ${t.fg('dim', 'Loading...')}`);
      return lines;
    }

    if (this.actionMsg) {
      lines.push(`  ${t.fg('muted', this.actionMsg)}`);
      return lines;
    }

    if (this.skills.length === 0) {
      lines.push(`  ${t.fg('dim', 'No installed skills')}`);
      lines.push('');
      lines.push(`  ${t.fg('muted', 'Go to the Search tab to find and install skills')}`);
      lines.push('');
      lines.push(`  ${t.fg('dim', '← → or Tab tabs  |  r refresh  |  Esc close')}`);
      this.cachedLines = lines;
      return lines;
    }

    lines.push(`  ${t.fg('muted', `${this.skills.length} skill(s) installed`)}`);
    lines.push('');

    const visibleCount = Math.min(this.skills.length, 16);
    const startOffset = Math.max(
      0,
      Math.min(this.cursor - Math.floor(visibleCount / 2), this.skills.length - visibleCount),
    );
    const endIndex = Math.min(startOffset + visibleCount, this.skills.length);

    for (let i = startOffset; i < endIndex; i++) {
      const s = this.skills[i];
      const isCursor = i === this.cursor;
      const isChecked = this.checked[i];

      const checkbox = isChecked ? t.fg('success', '✓') : t.fg('dim', '○');
      const cursorMarker = isCursor ? t.fg('accent', '▸') : ' ';
      const name = truncateToWidth(s.name, Math.floor(width * 0.4));
      lines.push(
        ` ${cursorMarker} ${checkbox} ${t.fg(isCursor ? 'text' : 'muted', name)} ${t.fg('dim', truncateToWidth(s.path, Math.max(10, width - 50)))}`,
      );
    }

    {
      const above = startOffset > 0 ? `↑ ${startOffset}` : '';
      const below = endIndex < this.skills.length ? `↓ ${this.skills.length - endIndex}` : '';
      const more = [above, below].filter(Boolean).join('  ');
      lines.push(more ? `  ${t.fg('dim', more)}` : '');
    }

    lines.push('');

    const count = this.checked.filter(Boolean).length;
    if (count > 0) {
      lines.push(`  ${t.fg('success', `${count} selected — u to uninstall`)}`);
    }
    lines.push(
      `  ${t.fg('dim', '↑↓ navigate  |  Space toggle  |  u uninstall checked or focused  |  U update all  |  r refresh  |  ← → or Tab tabs')}`,
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ---------------------------------------------------------------------------
// Status Panel
// ---------------------------------------------------------------------------

export class StatusPanel {
  private theme: Theme;
  private config: SkillshareConfig;
  private callbacks: SearchPanelCallbacks;
  private actionMsg = '';
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(config: SkillshareConfig, theme: Theme, callbacks: SearchPanelCallbacks) {
    this.config = config;
    this.theme = theme;
    this.callbacks = callbacks;
  }

  handleInput(data: string) {
    if (matchesKey(data, 's')) {
      void this.doAction('sync');
    } else if (matchesKey(data, 'u')) {
      void this.doAction('update');
    } else if (matchesKey(data, 'd')) {
      void this.doAction('doctor');
    }
  }

  private async doAction(action: 'sync' | 'update' | 'doctor') {
    const labels: Record<string, string> = {
      sync: 'Syncing skills to targets...',
      update: 'Updating all skills...',
      doctor: 'Running doctor...',
    };
    this.actionMsg = labels[action];
    this.callbacks.onSetStatus(this.actionMsg);
    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();

    try {
      let output = '';
      switch (action) {
        case 'sync':
          output = syncSkills(this.config.installMode === 'project');
          break;
        case 'update':
          output = updateSkills(this.config.installMode === 'project');
          break;
        case 'doctor':
          output = runDoctor();
          break;
      }
      this.callbacks.onNotify(`${action} completed`, 'success');
      console.log(`skillshare ${action}:\n${output}`);
    } catch (err: unknown) {
      this.callbacks.onNotify(
        `${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
    this.actionMsg = '';
    this.callbacks.onClearStatus();
    this.cachedWidth = undefined;
    this.callbacks.onRequestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && !this.actionMsg) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];

    lines.push(t.fg('accent', ' Skillshare Status'));
    lines.push('');

    if (this.actionMsg) {
      lines.push(`  ${t.fg('muted', this.actionMsg)}`);
      return lines;
    }

    // Version
    const version = listInstalledSkills(this.config.installMode === 'project').length;
    lines.push(`  ${t.fg('muted', 'Skills installed:')}  ${t.fg('text', String(version))}`);

    const modeLabel =
      this.config.installMode === 'project'
        ? 'project (.skillshare/)'
        : 'global (~/.config/skillshare)';
    lines.push(`  ${t.fg('muted', 'Install mode:')}      ${t.fg('text', modeLabel)}`);

    const hubLabel = this.config.hubMode === 'community-hub' ? 'community hub' : 'GitHub search';
    lines.push(`  ${t.fg('muted', 'Search source:')}     ${t.fg('text', hubLabel)}`);

    const hasProject = listInstalledSkills(true).length > 0;
    const hasGlobal = listInstalledSkills(false).length > 0;
    lines.push(
      `  ${t.fg('muted', 'Project skills:')}    ${hasProject ? t.fg('success', 'found') : t.fg('dim', 'none')}`,
    );
    lines.push(
      `  ${t.fg('muted', 'Global skills:')}     ${hasGlobal ? t.fg('success', 'found') : t.fg('dim', 'none')}`,
    );
    lines.push('');
    lines.push(`  ${t.fg('dim', 'Actions:  s sync  |  u update  |  d doctor')}`);
    lines.push(`  ${t.fg('dim', '← → or Tab tabs  |  Esc close')}`);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ---------------------------------------------------------------------------
// Settings Panel
// ---------------------------------------------------------------------------

export interface SettingsCallbacks {
  onConfigChange: (config: SkillshareConfig) => void;
  onNotify: (msg: string, type: 'info' | 'success' | 'error') => void;
  onRequestRender: () => void;
}

export class SettingsPanel {
  private config: SkillshareConfig;
  private theme: Theme;
  private callbacks: SettingsCallbacks;
  private cursor = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Setting options
  private settings: Array<{
    id: string;
    label: string;
    detail: string;
    values: string[];
    currentIndex: number;
  }>;

  constructor(config: SkillshareConfig, theme: Theme, callbacks: SettingsCallbacks) {
    this.config = { ...config };
    this.theme = theme;
    this.callbacks = callbacks;
    this.buildSettings();
  }

  private buildSettings() {
    this.settings = [
      {
        id: 'hubMode',
        label: 'Search source',
        detail: 'Where to search for skills',
        values: ['GitHub search', 'Community hub'],
        currentIndex: this.config.hubMode === 'community-hub' ? 1 : 0,
      },
      {
        id: 'installMode',
        label: 'Default install target',
        detail: 'Where skills are installed by default',
        values: ['Global (~/.config)', 'Project (.skillshare/)'],
        currentIndex: this.config.installMode === 'project' ? 1 : 0,
      },
      {
        id: 'operationScope',
        label: 'Check/update scope',
        detail: 'Scope for check and update commands',
        values: ['Global', 'Project'],
        currentIndex: this.config.operationScope === 'project' ? 1 : 0,
      },
      {
        id: 'searchLimit',
        label: 'Search result limit',
        detail: 'Max results per search',
        values: ['10', '20', '30', '50'],
        currentIndex: (() => {
          const idx = [10, 20, 30, 50].indexOf(this.config.searchLimit);
          return idx >= 0 ? idx : 1; // default to 20
        })(),
      },
      {
        id: 'checkUpdatesOnStart',
        label: 'Check for updates on start',
        detail: 'Run skillshare doctor on startup to detect new CLI versions',
        values: ['Enabled', 'Disabled'],
        currentIndex: this.config.checkUpdatesOnStart === false ? 1 : 0,
      },
    ];
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.cursor = this.cursor === 0 ? this.settings.length - 1 : this.cursor - 1;
      this.cachedWidth = undefined;
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.cursor = this.cursor === this.settings.length - 1 ? 0 : this.cursor + 1;
      this.cachedWidth = undefined;
      return;
    }
    if (matchesKey(data, Key.left)) {
      const setting = this.settings[this.cursor];
      setting.currentIndex =
        setting.currentIndex === 0 ? setting.values.length - 1 : setting.currentIndex - 1;
      this.applySetting(setting);
      this.cachedWidth = undefined;
      return;
    }
    if (matchesKey(data, Key.right)) {
      const setting = this.settings[this.cursor];
      setting.currentIndex =
        setting.currentIndex === setting.values.length - 1 ? 0 : setting.currentIndex + 1;
      this.applySetting(setting);
      this.cachedWidth = undefined;
      return;
    }
  }

  private applySetting(setting: (typeof this.settings)[0]) {
    const newConfig = { ...this.config };

    switch (setting.id) {
      case 'hubMode':
        newConfig.hubMode = setting.currentIndex === 1 ? 'community-hub' : 'github';
        break;
      case 'installMode':
        newConfig.installMode = setting.currentIndex === 1 ? 'project' : 'global';
        break;
      case 'operationScope':
        newConfig.operationScope = setting.currentIndex === 1 ? 'project' : 'global';
        break;
      case 'searchLimit':
        newConfig.searchLimit = [10, 20, 30, 50][setting.currentIndex] ?? 20;
        break;
      case 'checkUpdatesOnStart':
        newConfig.checkUpdatesOnStart = setting.currentIndex === 0;
        break;
    }

    this.config = newConfig;
    this.callbacks.onConfigChange(newConfig);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const lines: string[] = [];

    lines.push(t.fg('accent', ' Settings'));
    lines.push('');
    lines.push(`  ${t.fg('muted', '↑↓ navigate  |  ← → change value  |  Esc close')}`);
    lines.push('');

    for (let i = 0; i < this.settings.length; i++) {
      const s = this.settings[i];
      const isCursor = i === this.cursor;
      const cursorMarker = isCursor ? t.fg('accent', '▸') : ' ';

      const label = t.fg(isCursor ? 'text' : 'muted', s.label);
      const value = t.fg('accent', s.values[s.currentIndex]);
      const detail = `  ${t.fg('dim', s.detail)}`;

      lines.push(` ${cursorMarker} ${label}: ${value}${detail}`);
    }

    lines.push('');
    lines.push(
      `  ${t.fg(
        'dim',
        this.config.hubMode === 'community-hub'
          ? 'Search uses community skillshare-hub (--hub flag)'
          : 'Search queries GitHub directly (no --hub flag)',
      )}`,
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
