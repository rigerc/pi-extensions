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
import type {
  ClassifierModelInfo,
  SystemOneClient,
  SystemOneProviderInfo,
} from './system-one.js';
import {
  PROVIDER_VALUES,
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
            type: 'bool',
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
      const provider = await this.systemOneClient.getProviderInfo();
      const hint = provider
        ? `Check auth with /login ${provider.provider}, or load a local model with /llama.`
        : 'Sign in with /login <provider>, or load a local model with /llama.';
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

/** The classifier catalog and current selection, loaded once when the editor opens. */
export interface ProviderCatalog {
  models: ClassifierModelInfo[];
  info: SystemOneProviderInfo | null;
}

/** Load everything the provider picker and the auth row need, in one snapshot. */
export async function loadProviderCatalog(client: SystemOneClient): Promise<ProviderCatalog> {
  const [models, info] = await Promise.all([client.listAvailable(), client.getProviderInfo()]);
  return { models, info };
}

/** One pickable classifier, or an unavailable provider shown with its remedy. */
export interface ProviderOption {
  /** Setting value: a pi provider id, or `auto`. */
  provider: string;
  /** The classifier id selected alongside the provider, when this is a catalog entry. */
  model?: string;
  name: string;
  /** The wire protocol, e.g. `typesafe-system-one` or `llama-cpp-classify`. */
  api?: string;
  /** False when the provider has no working credentials. */
  selectable: boolean;
  /** How to make an unavailable entry work, e.g. `run /login openrouter`. */
  remedy?: string;
}

/** Catalog entries for one provider, plus providers that still need signing in. */
export interface ProviderGroup {
  provider: string;
  label: string;
  options: ProviderOption[];
}

/**
 * Group the catalog by provider. A provider with no working credentials is still
 * listed — from the documented provider list, or from the current pin — so it is
 * visible with a remedy rather than silently dropped.
 */
export function buildProviderGroups(catalog: ProviderCatalog): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  const groupFor = (provider: string, label: string): ProviderGroup => {
    const existing = groups.get(provider);
    if (existing) return existing;
    const created: ProviderGroup = { provider, label, options: [] };
    groups.set(provider, created);
    return created;
  };

  for (const model of catalog.models) {
    groupFor(model.provider, model.provider).options.push({
      provider: model.provider,
      model: model.id,
      name: model.name,
      api: model.api,
      selectable: true,
    });
  }

  // Providers pi knows about but the catalog cannot reach right now.
  for (const provider of PROVIDER_VALUES) {
    if (provider === 'auto' || groups.has(provider)) continue;
    groupFor(provider, provider).options.push({
      provider,
      name: provider,
      selectable: false,
      remedy: `run /login ${provider}`,
    });
  }

  // A pin that is not in the catalog (no credentials yet, or a local router with no
  // model loaded) stays visible so the selection is never silently changed.
  const info = catalog.info;
  if (info && info.provider !== 'auto' && !groups.has(info.provider)) {
    const local = info.api === 'llama-cpp-classify';
    groupFor(info.provider, info.label).options.push({
      provider: info.provider,
      model: info.model,
      name: info.model,
      api: info.api,
      selectable: info.auth === 'ok',
      remedy: local ? 'load a model with /llama' : `run /login ${info.provider}`,
    });
  }

  const auto: ProviderGroup = {
    provider: 'auto',
    label: 'Auto',
    options: [
      { provider: 'auto', name: 'Use every available classifier', selectable: true },
    ],
  };
  return [auto, ...groups.values()];
}

/**
 * Grouped classifier picker. Unavailable entries stay in the list but cannot be chosen;
 * pressing Enter on them shows the remedy instead.
 */
export class ProviderSubmenu {
  private cursor = 0;
  private message: string | undefined;
  private readonly options: ProviderOption[];

  constructor(
    private readonly groups: ProviderGroup[],
    private readonly currentProvider: string,
    private readonly ui: SettingsUiTheme,
    private readonly done: SubmenuDone,
    private readonly choose: (option: ProviderOption) => void,
  ) {
    this.options = groups.flatMap((group) => group.options);
    const current = this.options.findIndex(
      (option) => option.selectable && option.provider === currentProvider,
    );
    if (current >= 0) this.cursor = current;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      const option = this.options[this.cursor];
      if (option?.selectable) {
        this.choose(option);
        this.done();
      } else if (option) {
        this.message = `${option.name} is not ready — ${option.remedy ?? 'unavailable'}.`;
      } else {
        this.done();
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
      this.message = undefined;
    } else if (matchesKey(data, Key.down)) {
      this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
      this.message = undefined;
    }
  }

  render(width: number): string[] {
    const lines = [this.ui.accent(this.ui.bold('Classifier · Provider'))];
    const catalogued = this.options.filter(
      (option) => option.selectable && option.provider !== 'auto',
    ).length;
    if (catalogued === 0) {
      lines.push(
        this.ui.warning(
          '  No classifier is available. Sign in with /login <provider>, or load one with /llama.',
        ),
      );
    }
    for (const group of this.groups) {
      if (group.options.length === 0) continue;
      lines.push(this.ui.dim(`  ${group.label} (${group.provider})`));
      for (const option of group.options) {
        const selected = option === this.options[this.cursor];
        const marker = selected ? '› ' : '  ';
        const name = option.model ? `${option.name} [${option.model}]` : option.name;
        const api = option.api ? ` · ${option.api}` : '';
        const current = option.provider === this.currentProvider ? ' (current)' : '';
        if (option.selectable) {
          const text = `${marker}${name}${api}${current}`;
          lines.push(selected ? this.ui.accent(text) : text);
        } else {
          lines.push(
            this.ui.muted(`${marker}${name}`) +
              this.ui.dim(`${api}${current} — ${option.remedy ?? 'unavailable'}`),
          );
        }
      }
    }
    if (this.message) lines.push('', this.ui.warning(`  ${this.message}`));
    lines.push('', this.ui.dim('  ↑/↓ move · Enter select · Esc cancel'));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    /* no cached state */
  }
}

/** Short, secret-free auth label for the read-only auth row. */
function authStatusLabel(info: SystemOneProviderInfo | null): string {
  return info ? info.auth : 'not configured';
}

/** Build the SettingsList rows from the draft, plus read-only status and diagnostics. */
export function buildSettingItems(
  settings: SettingsService,
  systemOneClient: SystemOneClient,
  ui: SettingsUiTheme,
  requestRender: () => void,
  report: Feedback = () => {},
  draft: SystemOneSettings = settings.values,
  catalog: ProviderCatalog = { models: [], info: null },
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

    if (spec.key === 'provider') {
      items.push({
        ...shared,
        currentValue: String(value),
        submenu: (_current, done) =>
          new ProviderSubmenu(
            buildProviderGroups(catalog),
            String(draft.provider),
            ui,
            done,
            (option) => {
              draft.provider = option.provider;
              if (option.model) draft.model = option.model;
              report(
                'warning',
                `${spec.label}: ${option.provider}${option.model ? `/${option.model}` : ''} · unsaved.`,
              );
              requestRender();
            },
          ),
      });
      continue;
    }

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

  const info = catalog.info;
  const paths = settings.paths();

  items.push({
    id: 'status.auth',
    label: 'Auth status',
    description: 'Read-only. pi owns credentials; this package never reads or stores a key.',
    currentValue: authStatusLabel(info),
    submenu: (_current, done) =>
      new InfoSubmenu(
        ui.accent(ui.bold('Classifier · Auth status')),
        [
          `  provider:     ${info?.provider ?? '(unconfigured)'}`,
          `  label:        ${info?.label ?? '—'}`,
          `  model:        ${info?.model ?? '—'}`,
          `  api:          ${info?.api ?? '—'}`,
          `  auth:         ${info?.auth ?? 'not configured'}`,
          `  selection:    ${info?.source ?? '—'}`,
          '',
          ui.dim("  Auth is pi's: run /login <provider>, set the provider env var,"),
          ui.dim('  or load a local model with /llama. No key is read or shown here.'),
        ],
        done,
      ),
  });

  items.push({
    id: 'status.session',
    label: 'Session',
    description: 'Live counters and where each setting came from',
    currentValue: `${systemOneClient.stats.requestsCount} req`,
    submenu: (_current, done) => {
      const currentResolved = settings.resolvedSettings;
      return new InfoSubmenu(
        ui.accent(ui.bold('Status · Session')),
        [
          `  configured:  ${systemOneClient.isConfigured() ? 'yes' : 'no'}`,
          `  provider:    ${info?.provider ?? '—'}`,
          `  model:       ${info?.model ?? '—'}`,
          `  api:         ${info?.api ?? '—'}`,
          `  auth:        ${info?.auth ?? 'not configured'}`,
          `  requests:    ${systemOneClient.stats.requestsCount}`,
          `  tokens:      ${systemOneClient.stats.totalTokens}`,
          `  cost:        ${systemOneClient.stats.totalCostUsd > 0 ? `$${systemOneClient.stats.totalCostUsd.toFixed(6)}` : 'n/a'}`,
          `  fallback (last request): ${systemOneClient.stats.fallback ? `${systemOneClient.stats.fallback.from} → ${systemOneClient.stats.fallback.to}` : 'none'}`,
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
    id: 'action.test',
    label: 'Test connectivity',
    description: 'Send one System One request to the configured provider',
    currentValue: 'run',
    submenu: (_current, done) =>
      new TestConnectivitySubmenu(systemOneClient, ui, done, requestRender, report),
  });

  return items;
}

type SettingsTab = 'Modes' | 'Classifier' | 'Status' | 'Actions';
const TABS: readonly SettingsTab[] = ['Modes', 'Classifier', 'Status', 'Actions'];

function tabForItem(id: string): SettingsTab {
  if (id.startsWith('action.')) return 'Actions';
  if (id === 'status.session') return 'Status';
  if (id === 'status.auth') return 'Classifier';
  return SETTING_SPECS.find((spec) => spec.key === id)?.group ?? 'Status';
}

/** Register `/system-one-settings`, opening the editor as an overlay. */
export function registerSystemOneSettingsCommand(
  pi: ExtensionAPI,
  settings: SettingsService,
  systemOneClient: SystemOneClient,
): void {
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    // The catalog is async; load it once so the list renders from a stable snapshot.
    const catalog = await loadProviderCatalog(systemOneClient);
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
          catalog,
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
          lists[1].updateValue('status.auth', authStatusLabel(catalog.info));
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
