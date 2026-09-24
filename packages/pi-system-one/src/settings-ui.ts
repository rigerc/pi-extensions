import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import {
  Input,
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
  type SettingItem,
} from '@earendil-works/pi-tui';
import type { SystemOneClient } from './system-one.js';
import {
  SETTING_SPECS,
  coerceSetting,
  getSpec,
  isSettingKey,
  type ResolvedSettings,
  type SettingKey,
  type SystemOneSettings,
  type RawSettings,
} from './config.js';
import { formatSettingValue, type SettingsService } from './settings.js';

/** Minimal theme helpers handed to submenu components (they render outside SettingsList). */
export interface SettingsUiTheme {
  accent(text: string): string;
  dim(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  bold(text: string): string;
}

export function settingsUiTheme(theme: {
  fg: (color: any, text: string) => string;
  bold: (text: string) => string;
}): SettingsUiTheme {
  return {
    accent: (text) => theme.fg('accent', text),
    dim: (text) => theme.fg('dim', text),
    muted: (text) => theme.fg('muted', text),
    success: (text) => theme.fg('success', text),
    warning: (text) => theme.fg('warning', text),
    error: (text) => theme.fg('error', text),
    bold: (text) => theme.bold(text),
  };
}

type SubmenuDone = (selectedValue?: string, options?: { navigateTo?: string }) => void;
type FeedbackKind = 'success' | 'warning' | 'error';
type Feedback = (kind: FeedbackKind, message: string) => void;

/** Free-text editor for string settings. Enter updates the draft. */
export class TextInputSubmenu {
  private input = new Input();
  private error: string | undefined;

  constructor(
    private title: string,
    initial: string,
    private allowEmpty: boolean,
    private ui: SettingsUiTheme,
    private done: SubmenuDone,
  ) {
    this.input.setValue(initial);
    this.input.focused = true;
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      const value = this.input.getValue().trim();
      if (value === '' && !this.allowEmpty) {
        this.error = 'A value is required — press esc to cancel.';
        return;
      }
      this.done(value);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    this.error = undefined;
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(this.ui.accent(this.ui.bold(this.title)), width)];
    lines.push(...this.input.render(width));
    if (this.error) lines.push(truncateToWidth(this.ui.error(this.error), width));
    lines.push(truncateToWidth(this.ui.dim('  Enter keep edit · Esc cancel'), width));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

/** Read-only panel. Any of enter/esc closes it. */
export class InfoSubmenu {
  constructor(
    private title: string,
    private lines: string[],
    private done: SubmenuDone,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) this.done();
  }

  render(width: number): string[] {
    return [this.title, ...this.lines].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    /* no cached state */
  }
}

/** Runs one live evaluation so the user can confirm the provider actually works. */
export class TestConnectivitySubmenu {
  private lines: string[];

  constructor(
    private systemOneClient: SystemOneClient,
    private ui: SettingsUiTheme,
    private done: SubmenuDone,
    requestRender: () => void,
    private report?: (kind: FeedbackKind, message: string) => void,
  ) {
    this.lines = [this.ui.warning('Running one System One request…')];
    void this.run(requestRender);
  }

  private async run(requestRender: () => void): Promise<void> {
    try {
      const response = await this.systemOneClient.evaluate({
        state: { message: 'Payment processing failed due to credit card expiration.' },
        questions: {
          is_billing: {
            type: 'noul',
            instructions: 'Is this message related to a billing issue?',
          },
        },
      });
      const answer = response.answers['is_billing'];
      const cost = response.usage?.costUsd;
      this.lines = [
        this.ui.success('Connected.'),
        `  model:    ${response.model}`,
        `  answered: is_billing = ${String(answer?.value)}`,
        `  tokens:   ${response.usage?.totalTokens ?? 0}${cost !== undefined ? `  cost: $${cost.toFixed(6)}` : ''}`,
        `  elapsed:  ${response.elapsedMs}ms`,
      ];
      this.report?.('success', `Connected to ${response.model}.`);
    } catch (error) {
      const provider = this.systemOneClient.getProviderInfo();
      const hint =
        provider?.provider === 'laya'
          ? 'Check that laya-serve is running and the Base URL omits /v1.'
          : 'Check the key source and provider in the Provider tab.';
      this.lines = [
        this.ui.error('Failed.'),
        `  ${(error as { message?: string } | undefined)?.message ?? String(error)}`,
        '',
        `  ${hint}`,
      ];
      this.report?.('error', 'Connectivity test failed.');
    }
    requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) this.done();
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.ui.bold('Actions · Test connectivity'), width),
      ...this.lines.map((l) => truncateToWidth(l, width)),
    ];
  }

  invalidate(): void {
    /* no cached state */
  }
}

/** Read Laya's lightweight health route; this does not perform model inference. */
export class LayaHealthSubmenu {
  private lines: string[];

  constructor(
    private systemOneClient: SystemOneClient,
    private ui: SettingsUiTheme,
    private done: SubmenuDone,
    requestRender: () => void,
    private report?: (kind: FeedbackKind, message: string) => void,
  ) {
    this.lines = [this.ui.warning('Checking Laya server…')];
    void this.run(requestRender);
  }

  private async run(requestRender: () => void): Promise<void> {
    try {
      const result = await this.systemOneClient.checkLayaHealth();
      this.lines = [
        this.ui.success('Healthy.'),
        `  endpoint: ${result.endpoint}`,
        `  loaded:   ${result.loaded.length ? result.loaded.join(', ') : 'none (lazy loading)'}`,
        `  device:   ${result.device}`,
        '',
        this.ui.dim('  Use Test connectivity to verify inference.'),
      ];
      this.report?.('success', 'Laya health check passed.');
    } catch (error) {
      const hint =
        this.systemOneClient.getProviderInfo()?.provider === 'laya'
          ? 'Check that laya-serve is running and the Base URL omits /v1.'
          : 'Select Laya as the provider to use this action.';
      this.lines = [
        this.ui.error('Failed.'),
        `  ${(error as { message?: string } | undefined)?.message ?? String(error)}`,
        '',
        this.ui.dim(`  ${hint}`),
      ];
      this.report?.('error', 'Laya health check failed.');
    }
    requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) this.done();
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.ui.bold('Actions · Check Laya health'), width),
      ...this.lines.map((line) => truncateToWidth(line, width)),
    ];
  }

  invalidate(): void {}
}

function maskedKey(provider: ReturnType<SystemOneClient['getProviderInfo']>): string {
  if (!provider) return '(unset)';
  if (provider.authMode === 'none') return 'not required (local endpoint)';
  return provider.keyOrigin ? `•••••••• (from ${provider.keyOrigin})` : '(unset)';
}

/** Build the SettingsList rows from the draft, plus read-only status and diagnostics. */
export function buildSettingItems(
  settings: SettingsService,
  systemOneClient: SystemOneClient,
  ui: SettingsUiTheme,
  requestRender: () => void,
  report: Feedback = () => {},
  draft: SystemOneSettings = settings.values,
): SettingItem[] {
  const resolved: ResolvedSettings = settings.resolvedSettings;
  const items: SettingItem[] = [];

  for (const spec of SETTING_SPECS) {
    const label = spec.label;
    const value = draft[spec.key];
    const shared = {
      id: spec.key,
      label,
      description: `${spec.description} · Source: ${resolved.provenance[spec.key]}`,
    };

    if (spec.kind === 'boolean') {
      items.push({ ...shared, currentValue: value ? 'on' : 'off', values: ['on', 'off'] });
      continue;
    }

    if (spec.kind === 'enum') {
      items.push({ ...shared, currentValue: String(value), values: [...(spec.values ?? [])] });
      continue;
    }

    items.push({
      ...shared,
      currentValue:
        formatSettingValue(value) === '(provider default)' ? '(provider default)' : String(value),
      submenu: (_current, done) =>
        new TextInputSubmenu(
          `${spec.group} · ${label}`,
          String(draft[spec.key]),
          Boolean(spec.allowEmpty),
          ui,
          done,
        ),
    });
  }

  const provider = systemOneClient.getProviderInfo();
  const paths = settings.paths();

  items.push({
    id: 'status.apiKey',
    label: 'API key',
    description: 'Read-only. Keys are never written to config files or session entries.',
    currentValue: maskedKey(provider),
    submenu: (_current, done) => {
      const currentProvider = systemOneClient.getProviderInfo();
      return new InfoSubmenu(
        ui.accent(ui.bold('Provider · API key')),
        [
          `  provider:     ${currentProvider?.provider ?? '(unconfigured)'}`,
          `  base URL:     ${currentProvider?.baseURL ?? '—'}`,
          `  model:        ${currentProvider?.model ?? '—'}`,
          `  auth:         ${currentProvider ? (currentProvider.authMode === 'none' ? 'not required (local endpoint)' : 'bearer') : '—'}`,
          `  key source:   ${currentProvider?.keyOrigin ?? (currentProvider?.authMode === 'none' ? 'not required' : '(unset)')}`,
          '',
          ui.dim('  Set a key via TYPESAFE_API_KEY, OPENROUTER_API_KEY, or LAYA_API_KEY,'),
          ui.dim('  or a file in ~/.pi/agent/secrets/.'),
          ui.dim('  Keys are never persisted by this TUI.'),
        ],
        done,
      );
    },
  });

  items.push({
    id: 'status.session',
    label: 'Session',
    description: 'Live counters and where each setting came from',
    currentValue: `${systemOneClient.stats.requestsCount} req`,
    submenu: (_current, done) => {
      const currentProvider = systemOneClient.getProviderInfo();
      const currentHealth = systemOneClient.getLayaHealthStatus?.();
      const currentResolved = settings.resolvedSettings;
      return new InfoSubmenu(
        ui.accent(ui.bold('Status · Session')),
        [
          `  configured:  ${systemOneClient.isConfigured() ? 'yes' : 'no'}`,
          `  provider:    ${currentProvider?.provider ?? '—'}`,
          `  model:       ${currentProvider?.model ?? '—'}`,
          `  requests:    ${systemOneClient.stats.requestsCount}`,
          `  tokens:      ${systemOneClient.stats.totalTokens}`,
          `  cost:        ${systemOneClient.stats.totalCostUsd > 0 ? `$${systemOneClient.stats.totalCostUsd.toFixed(6)}` : 'n/a'}`,
          `  fallback (last request): ${systemOneClient.stats.fallback ? `${systemOneClient.stats.fallback.from} → ${systemOneClient.stats.fallback.to}` : 'none'}`,
          ...(currentProvider?.provider === 'laya'
            ? [
                `  health (last check): ${currentHealth?.result ? 'healthy' : (currentHealth?.error ?? 'not checked')}`,
              ]
            : []),
          '',
          ui.dim('  Effective values (layer):'),
          ...SETTING_SPECS.map(
            (spec) =>
              `    ${spec.label.padEnd(20).slice(0, 20)} ${formatSettingValue(currentResolved.values[spec.key])}  (${currentResolved.provenance[spec.key]})`,
          ),
          '',
          ui.dim(`  save target:   ${paths.user}`),
          ui.dim(`  project input: ${paths.project} (read-only)`),
        ],
        done,
      );
    },
  });

  items.push({
    id: 'action.layaHealth',
    label: 'Check Laya health',
    description: 'GET /health on the selected Laya endpoint; no inference request',
    currentValue: 'run',
    submenu: (_current, done) =>
      new LayaHealthSubmenu(systemOneClient, ui, done, requestRender, report),
  });

  items.push({
    id: 'action.test',
    label: 'Test connectivity',
    description: 'Send one System One request to the configured provider',
    currentValue: 'run',
    submenu: (_current, done) =>
      new TestConnectivitySubmenu(systemOneClient, ui, done, requestRender, report),
  });

  return items;
}

type SettingsTab = 'Modes' | 'Provider' | 'Status' | 'Actions';
const TABS: readonly SettingsTab[] = ['Modes', 'Provider', 'Status', 'Actions'];

function tabForItem(id: string): SettingsTab {
  if (id.startsWith('action.')) return 'Actions';
  if (id === 'status.session') return 'Status';
  if (id === 'status.apiKey') return 'Provider';
  return SETTING_SPECS.find((spec) => spec.key === id)?.group ?? 'Status';
}

/** Register `/system-one-settings`, opening the editor as an overlay. */
export function registerSystemOneSettingsCommand(
  pi: ExtensionAPI,
  settings: SettingsService,
  systemOneClient: SystemOneClient,
): void {
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const ui = settingsUiTheme(theme);
        const border = new DynamicBorder((s: string) => theme.fg('accent', s));
        const initial: SystemOneSettings = { ...settings.values };
        const draft: SystemOneSettings = { ...initial };
        let activeTab = 0;
        let submenuOpen = false;
        let confirmDiscard = false;
        let feedback: { kind: FeedbackKind; message: string } | undefined;
        const changedKeys = (): SettingKey[] =>
          SETTING_SPECS.filter((spec) => draft[spec.key] !== initial[spec.key]).map(
            (spec) => spec.key,
          );
        const save = () => {
          const changes: RawSettings = {};
          for (const key of changedKeys()) changes[key] = draft[key];
          if (Object.keys(changes).length === 0) {
            done();
            return;
          }
          try {
            const path = settings.saveUserSettings(changes);
            ctx.ui.notify(`Saved settings to ${path}.`, 'info');
            done();
          } catch (error) {
            report(
              'error',
              `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        const discard = () => {
          if (changedKeys().length > 0) confirmDiscard = true;
          else done();
        };
        const report: Feedback = (kind, message) => {
          feedback = { kind, message };
          tui.requestRender();
        };
        const items = buildSettingItems(
          settings,
          systemOneClient,
          ui,
          () => tui.requestRender(),
          report,
          draft,
        );
        const rowsByTab = new Map(
          TABS.map((tab) => [tab, items.filter((item) => tabForItem(item.id) === tab)]),
        );
        for (const item of items) {
          if (!item.submenu) continue;
          const open = item.submenu;
          item.submenu = (current, close) => {
            submenuOpen = true;
            return open(current, (value, options) => {
              submenuOpen = false;
              close(value, options);
            });
          };
        }

        const baseTheme = getSettingsListTheme();
        const listTheme = {
          ...baseTheme,
          value: (value: string, selected: boolean) => {
            if (value === 'on') return ui.success(value);
            if (value === 'off') return ui.muted(value);
            if (value === '(unset)') return ui.warning(value);
            return baseTheme.value(value, selected);
          },
        };
        const lists = TABS.map((tab) => {
          const rows = rowsByTab.get(tab)!;
          return new SettingsList(
            rows,
            Math.min(rows.length, 10),
            listTheme,
            (id, newValue) => {
              if (isSettingKey(id)) {
                const spec = getSpec(id)!;
                const value = coerceSetting(spec, newValue);
                if (value !== undefined) {
                  draft[id] = value as never;
                  report('warning', `${spec.label}: ${formatSettingValue(value)} · unsaved.`);
                } else {
                  report('warning', `Rejected ${id}: ${newValue}.`);
                }
              }
              tui.requestRender();
            },
            discard,
            { enableSearch: true },
          );
        });

        const refresh = () => {
          const resolved = settings.resolvedSettings;
          for (const spec of SETTING_SPECS) {
            const row = items.find((item) => item.id === spec.key)!;
            row.description = `${spec.description} · ${draft[spec.key] !== initial[spec.key] ? 'Unsaved draft' : `Source: ${resolved.provenance[spec.key]}`}`;
            lists[TABS.indexOf(spec.group)].updateValue(
              spec.key,
              formatSettingValue(draft[spec.key]),
            );
          }
          lists[1].updateValue('status.apiKey', maskedKey(systemOneClient.getProviderInfo()));
          lists[2].updateValue('status.session', `${systemOneClient.stats.requestsCount} req`);
        };

        return {
          render: (width: number) => {
            refresh();
            if (confirmDiscard) {
              return [
                ...border.render(width),
                truncateToWidth(ui.warning(ui.bold('  Discard unsaved changes?')), width),
                truncateToWidth('  Enter discard · Esc keep editing', width),
                ...border.render(width),
              ];
            }
            const tabBar = TABS.map((tab, index) => {
              const label = width < 52 ? tab[0] : tab;
              return index === activeTab ? ui.accent(ui.bold(`[${label}]`)) : ` ${label} `;
            }).join(' ');
            const status = feedback
              ? ui[feedback.kind](
                  `  ${feedback.kind === 'success' ? '✓' : feedback.kind === 'error' ? '✗' : '!'} ${feedback.message}`,
                )
              : '';
            return [
              ...border.render(width),
              truncateToWidth(ui.accent(ui.bold('  pi-system-one settings')), width),
              truncateToWidth(`  ${tabBar}`, width),
              truncateToWidth(ui.dim('  Draft changes · Save writes the user file'), width),
              '',
              ...lists[activeTab].render(width),
              '',
              truncateToWidth(status, width),
              truncateToWidth(
                ui.dim(
                  submenuOpen
                    ? '  Esc return to tab'
                    : `  Ctrl+S Save · Esc ${changedKeys().length ? 'Discard' : 'Close'} · ${changedKeys().length} unsaved · Tab switch`,
                ),
                width,
              ),
              ...border.render(width),
            ];
          },
          invalidate: () => lists.forEach((list) => list.invalidate()),
          handleInput: (data: string) => {
            if (confirmDiscard) {
              if (matchesKey(data, Key.enter)) done();
              else if (matchesKey(data, Key.escape)) confirmDiscard = false;
            } else if (!submenuOpen && matchesKey(data, Key.ctrl('s'))) {
              save();
            } else if (
              !submenuOpen &&
              (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab)))
            ) {
              activeTab =
                (activeTab + (matchesKey(data, Key.tab) ? 1 : TABS.length - 1)) % TABS.length;
            } else {
              lists[activeTab].handleInput(data);
            }
            tui.requestRender();
          },
        };
      },
      { overlay: true },
    );
  };

  pi.registerCommand('system-one-settings', {
    description: 'Open the interactive pi-system-one settings editor',
    handler,
  });
}
