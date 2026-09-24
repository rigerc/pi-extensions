import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JevClient } from "../src/jev.js";
import { SESSION_ENTRY_TYPE } from "../src/config-store.js";
import { SettingsService, type ModeControllers, type SettingsHost } from "../src/settings.js";

export interface ModeProbe {
  enabled: boolean;
  setEnabled(value: boolean): void;
}

/** AutoJev exposes two independent routing paths rather than one switch. */
export interface AutoProbe {
  toolsEnabled: boolean;
  skillsEnabled: boolean;
  setToolsEnabled(value: boolean): void;
  setSkillsEnabled(value: boolean): void;
}

function modeProbe(): ModeProbe {
  return {
    enabled: false,
    setEnabled(value: boolean) {
      this.enabled = value;
    },
  };
}

function autoProbe(): AutoProbe {
  return {
    toolsEnabled: false,
    skillsEnabled: false,
    setToolsEnabled(value: boolean) {
      this.toolsEnabled = value;
    },
    setSkillsEnabled(value: boolean) {
      this.skillsEnabled = value;
    },
  };
}

export interface HarnessOptions {
  env?: Record<string, string>;
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
  branchEntries?: Array<Record<string, unknown>>;
  activeTools?: string[];
}

export interface SettingsHarness {
  service: SettingsService;
  host: SettingsHost;
  modes: ModeControllers & {
    auto: AutoProbe;
    autoModel: ModeProbe;
    agents: ModeProbe;
    toolGuard: ModeProbe;
    compactor: ModeProbe;
  };
  entries: Array<{ customType: string; data: unknown }>;
  providerOverrides: Array<Record<string, unknown>>;
  activeTools(): string[];
  setFlag(name: string, value: unknown): void;
  pathFor(scope: "user" | "project"): string;
  sessionBranch(): Array<Record<string, unknown>>;
  cleanup(): void;
}

/** Settings files live in a temp dir and the env is explicit, so tests never touch $HOME. */
export function makeSettingsHarness(options: HarnessOptions = {}): SettingsHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-settings-"));
  const userPath = path.join(dir, "home", "pi-jev.json");
  const projectPath = path.join(dir, "project", ".pi", "pi-jev.json");

  const write = (target: string, data: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ version: 1, ...data }, null, 2)}\n`);
  };
  if (options.user) write(userPath, options.user);
  if (options.project) write(projectPath, options.project);

  const flags = new Map<string, unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let activeTools = [...(options.activeTools ?? ["read"])];

  const host: SettingsHost = {
    getFlag: (name) => flags.get(name),
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools) => {
      activeTools = [...tools];
    },
    appendEntry: (customType, data) => {
      entries.push({ customType, data });
    },
  };

  const modes = {
    auto: autoProbe(),
    autoModel: modeProbe(),
    agents: modeProbe(),
    toolGuard: modeProbe(),
    compactor: modeProbe(),
  };

  const providerOverrides: Array<Record<string, unknown>> = [];
  const jevClient = {
    setProviderOverrides: (overrides: Record<string, unknown>) => {
      providerOverrides.push({ ...overrides });
    },
    getProviderInfo: () => ({
      provider: "openrouter",
      label: "OpenRouter",
      baseURL: "https://openrouter.ai/api",
      model: "jev-latest",
      keyOrigin: "$OPENROUTER_API_KEY",
      authMode: "bearer",
    }),
    stats: { requestsCount: 0, totalTokens: 0, totalCostUsd: 0 },
    isConfigured: () => true,
  } as unknown as JevClient;

  const service = new SettingsService(host, jevClient, modes, {
    env: options.env ?? {},
    userPath,
    projectPath,
  });

  const branch = [...(options.branchEntries ?? [])];

  return {
    service,
    host,
    modes: modes as SettingsHarness["modes"],
    entries,
    providerOverrides,
    activeTools: () => [...activeTools],
    setFlag: (name, value) => flags.set(name, value),
    pathFor: (scope) => (scope === "user" ? userPath : projectPath),
    sessionBranch: () => branch,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Shape one `pi.appendEntry("pi-jev-config", …)` entry as it appears in a session branch. */
export function configEntry(data: Record<string, unknown>): Record<string, unknown> {
  return { type: "custom", customType: SESSION_ENTRY_TYPE, data };
}
