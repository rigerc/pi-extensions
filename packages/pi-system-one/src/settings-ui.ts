import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  Key,
  matchesKey,
  SettingsList,
  Text,
  truncateToWidth,
  type SettingItem,
} from '@earendil-works/pi-tui';
import type { SystemOneClient } from './system-one.js';
import { SETTING_SPECS, isSettingKey, type ResolvedSettings } from './config.js';
import {
  PERSIST_SCOPES,
  formatSettingValue,
  type PersistScope,
  type SettingsService,
} from './settings.js';

/** Minimal theme helpers handed to submenu components (they render outside SettingsList). */
export interface SettingsUiTheme {
  accent(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

export function settingsUiTheme(theme: {
  fg: (color: any, text: string) => string;
  bold: (text: string) => string;
}): SettingsUiTheme {
  return {
    accent: (text) => theme.fg('accent', text),
    dim: (text) => theme.fg('dim', text),
    bold: (text) => theme.bold(text),
  };
}

type SubmenuDone = (selectedValue?: string, options?: { navigateTo?: string }) => void;

/** Free-text editor for string settings. Enter saves; empty is only valid when allowed. */
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
    if (this.error) lines.push(truncateToWidth(this.error, width));
    lines.push(truncateToWidth(this.ui.dim('  enter save · esc cancel'), width));
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

export interface Choice {
  value: string;
  label: string;
  description?: string;
}

/**
 * Arrow-key picker for side-effecting rows. The chosen value is handed to `onChoose`
 * and `done()` is called WITHOUT a value, so SettingsList never treats an action as a
 * setting change.
 */
export class ChoiceSubmenu {
  private index = 0;

  constructor(
    private title: string,
    private choices: Choice[],
    private ui: SettingsUiTheme,
    private onChoose: (value: string) => void,
    private done: SubmenuDone,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.index = (this.index - 1 + this.choices.length) % this.choices.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = (this.index + 1) % this.choices.length;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.onChoose(this.choices[this.index]!.value);
      this.done();
      return;
    }
    if (matchesKey(data, Key.escape)) this.done();
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(this.ui.accent(this.ui.bold(this.title)), width)];
    this.choices.forEach((choice, i) => {
      const selected = i === this.index;
      const prefix = selected ? '▶ ' : '  ';
      const label = selected ? this.ui.accent(choice.label) : choice.label;
      const description = choice.description ? this.ui.dim(`  ${choice.description}`) : '';
      lines.push(truncateToWidth(`${prefix}${label}${description}`, width));
    });
    lines.push(truncateToWidth(this.ui.dim('  ↑↓ move · enter choose · esc cancel'), width));
    return lines;
  }

  invalidate(): void {
    /* no cached state */
  }
}

/** Runs one live evaluation so the user can confirm the provider actually works. */
export class TestConnectivitySubmenu {
  private lines: string[] = ['Running one System One request…'];

  constructor(
    private systemOneClient: SystemOneClient,
    private ui: SettingsUiTheme,
    private done: SubmenuDone,
    requestRender: () => void,
  ) {
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
        this.ui.accent('Connected.'),
        `  model:    ${response.model}`,
        `  answered: is_billing = ${String(answer?.value)}`,
        `  tokens:   ${response.usage?.totalTokens ?? 0}${cost !== undefined ? `  cost: $${cost.toFixed(6)}` : ''}`,
        `  elapsed:  ${response.elapsedMs}ms`,
      ];
    } catch (error) {
      const provider = this.systemOneClient.getProviderInfo();
      const hint =
        provider?.provider === 'laya'
          ? 'Check that laya-serve is running and the Base URL omits /v1.'
          : 'Check the key source and provider in the rows above.';
      this.lines = [
        this.ui.accent('Failed.'),
        `  ${(error as { message?: string } | undefined)?.message ?? String(error)}`,
        '',
        `  ${hint}`,
      ];
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

function maskedKey(provider: ReturnType<SystemOneClient['getProviderInfo']>): string {
  if (!provider) return '(unset)';
  if (provider.authMode === 'none') return 'not required (local endpoint)';
  return provider.keyOrigin ? `•••••••• (from ${provider.keyOrigin})` : '(unset)';
}

/** Build the SettingsList rows: one per spec, then read-only status and actions. */
export function buildSettingItems(
  settings: SettingsService,
  systemOneClient: SystemOneClient,
  ui: SettingsUiTheme,
  requestRender: () => void,
): SettingItem[] {
  const resolved: ResolvedSettings = settings.resolvedSettings;
  const items: SettingItem[] = [];

  for (const spec of SETTING_SPECS) {
    const label = `${spec.group} · ${spec.label}`;
    const value = resolved.values[spec.key];
    const shared = {
      id: spec.key,
      label,
      description: spec.description,
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
        new TextInputSubmenu(label, String(value), Boolean(spec.allowEmpty), ui, done),
    });
  }

  const provider = systemOneClient.getProviderInfo();
  const paths = settings.paths();

  items.push({
    id: 'status.apiKey',
    label: 'Provider · API key',
    description: 'Read-only. Keys are never written to config files or session entries.',
    currentValue: maskedKey(provider),
    submenu: (_current, done) =>
      new InfoSubmenu(
        ui.accent(ui.bold('Provider · API key')),
        [
          `  provider:     ${provider?.provider ?? '(unconfigured)'}`,
          `  base URL:     ${provider?.baseURL ?? '—'}`,
          `  model:        ${provider?.model ?? '—'}`,
          `  auth:         ${provider?.authMode === 'none' ? 'not required (local endpoint)' : 'bearer'}`,
          `  key source:   ${provider?.keyOrigin ?? (provider?.authMode === 'none' ? 'not required' : '(unset)')}`,
          '',
          ui.dim('  Set a key via TYPESAFE_API_KEY, OPENROUTER_API_KEY, or LAYA_API_KEY,'),
          ui.dim('  or a file in ~/.pi/agent/secrets/.'),
          ui.dim('  Keys are never persisted by this TUI.'),
        ],
        done,
      ),
  });

  items.push({
    id: 'status.session',
    label: 'Status · Session',
    description: 'Live counters and where each setting came from',
    currentValue: `${systemOneClient.stats.requestsCount} req`,
    submenu: (_current, done) =>
      new InfoSubmenu(
        ui.accent(ui.bold('Status · Session')),
        [
          `  configured:  ${systemOneClient.isConfigured() ? 'yes' : 'no'}`,
          `  provider:    ${provider?.provider ?? '—'}`,
          `  model:       ${provider?.model ?? '—'}`,
          `  requests:    ${systemOneClient.stats.requestsCount}`,
          `  tokens:      ${systemOneClient.stats.totalTokens}`,
          `  cost:        ${systemOneClient.stats.totalCostUsd > 0 ? `$${systemOneClient.stats.totalCostUsd.toFixed(6)}` : 'n/a'}`,
          `  fallback:    ${systemOneClient.stats.fallback ? `${systemOneClient.stats.fallback.from} → ${systemOneClient.stats.fallback.to}` : 'none'}`,
          '',
          ui.dim('  Effective values (layer):'),
          ...SETTING_SPECS.map(
            (spec) =>
              `    ${spec.label.padEnd(20).slice(0, 20)} ${formatSettingValue(resolved.values[spec.key])}  (${resolved.provenance[spec.key]})`,
          ),
          '',
          ui.dim(`  user file:    ${paths.user}`),
          ui.dim(`  project file: ${paths.project}`),
        ],
        done,
      ),
  });

  items.push({
    id: 'action.test',
    label: 'Actions · Test connectivity',
    description: 'Send one System One request to the configured provider',
    currentValue: 'run',
    submenu: (_current, done) =>
      new TestConnectivitySubmenu(systemOneClient, ui, done, requestRender),
  });

  items.push({
    id: 'action.persist',
    label: 'Actions · Persist to file',
    description: 'Write the session overrides into a settings file',
    currentValue: 'choose',
    submenu: (_current, done) =>
      new ChoiceSubmenu(
        'Persist to file',
        PERSIST_SCOPES.map((scope) => ({
          value: scope,
          label: scope,
          description: scope === 'user' ? paths.user : scope === 'project' ? paths.project : 'both',
        })),
        ui,
        (scope) => settings.persistToFile(scope as PersistScope),
        done,
      ),
  });

  items.push({
    id: 'action.reset',
    label: 'Actions · Reset to defaults',
    description: 'Clear session overrides, optionally deleting the settings files',
    currentValue: 'reset',
    submenu: (_current, done) =>
      new ChoiceSubmenu(
        'Reset to defaults',
        [
          {
            value: 'session',
            label: 'Clear session overrides',
            description: 'keeps settings files',
          },
          {
            value: 'files',
            label: 'Clear everything',
            description: 'also deletes both settings files',
          },
        ],
        ui,
        (choice) => settings.resetToDefaults(choice === 'files'),
        done,
      ),
  });

  return items;
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
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(new Text(ui.accent(ui.bold('pi-system-one settings')), 1, 0));
        container.addChild(
          new Text(
            ui.dim(
              'Edits apply immediately and persist for this session. Use Persist to file to keep them.',
            ),
            1,
            0,
          ),
        );

        const items = buildSettingItems(settings, systemOneClient, ui, () => tui.requestRender());
        const list = new SettingsList(
          items,
          Math.max(8, Math.min(items.length + 2, 18)),
          getSettingsListTheme(),
          (id, newValue) => {
            if (isSettingKey(id) && !settings.set(id, newValue)) {
              ctx.ui.notify(
                `pi-system-one settings: rejected value "${newValue}" for ${id}`,
                'warning',
              );
            }
            tui.requestRender();
          },
          () => done(),
          { enableSearch: true },
        );

        container.addChild(list);
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
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
  pi.registerCommand('jev-settings', {
    description: 'Deprecated alias for /system-one-settings (supported through 0.8)',
    handler,
  });
}
