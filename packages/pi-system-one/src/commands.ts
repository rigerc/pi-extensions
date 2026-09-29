import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { SystemOneClient } from './system-one.js';
import type { ToolRouter } from './router.js';
import type { SkillRouter } from './skills.js';
import type { AutoSystemOne } from './auto.js';
import type { AutoModelRouter } from './model-router.js';
import type { SystemOneCompactor } from './compact.js';
import type { AgentOrchestrator } from './orchestrator.js';
import type { ToolGuard } from './tool-guard.js';
import { designEvaluation } from './designer.js';
import type { SystemOneEvaluationRequest } from './types.js';
import { SYSTEM_ONE_GRANTABLE_TOOL_NAMES, isSystemOneTool } from './types.js';
import { describeUnconfigured } from './system-one.js';
import type { SettingsService } from './settings.js';
import type { SettingKey } from './config.js';
import {
  HERDSMAN_JUDGE_DEFINITION,
  HERDSMAN_THINKING_LEVELS,
  buildHerdsmanJudgeDefinition,
  herdsmanJudgeDefinitionPath,
} from './herdsman.js';

export function registerSystemOneCommands(
  pi: ExtensionAPI,
  systemOneClient: SystemOneClient,
  router: ToolRouter,
  skillRouter: SkillRouter,
  auto: AutoSystemOne,
  autoModel?: AutoModelRouter,
  compactor?: SystemOneCompactor,
  agents?: AgentOrchestrator,
  toolGuard?: ToolGuard,
  settings?: SettingsService,
): void {
  const agentMode = agents ?? {
    enabled: false,
    setEnabled: () => {},
    dispatch: async () => ({ accepted: false, error: 'disabled' }),
  };
  const compactMode = compactor ?? { enabled: false, setEnabled: () => {} };
  const modelMode = autoModel ?? { enabled: false, setEnabled: () => {} };
  const guardMode = toolGuard ?? { enabled: false, setEnabled: () => {} };

  /**
   * Save a mode change to the user file when settings are available. Falls back to
   * mutating the live object when commands are registered without a settings service.
   */
  const setMode = (key: SettingKey, value: boolean, fallback: () => void): void => {
    if (settings) settings.set(key, value);
    else fallback();
  };

  /** ` (session)` / ` (env)` / ` (default)` provenance suffix. */
  const layer = (key: SettingKey): string => (settings ? ` (${settings.provenance[key]})` : '');

  /** The two auto-routing paths are independent; a legacy stub may only expose `enabled`. */
  const liveAuto = auto as unknown as { tools?: boolean; skills?: boolean; enabled: boolean };
  const autoTools = (): boolean =>
    settings ? Boolean(settings.values.autoToolRouting) : (liveAuto.tools ?? liveAuto.enabled);
  const autoSkills = (): boolean =>
    settings ? Boolean(settings.values.autoSkillRouting) : (liveAuto.skills ?? liveAuto.enabled);

  /** `/system-one auto` remains the master switch over both routing paths. */
  const setAutoRouting = (enabled: boolean): void => {
    if (settings) {
      settings.saveUserSettings({ autoToolRouting: enabled, autoSkillRouting: enabled });
    } else {
      auto.setEnabled(enabled);
    }
  };

  /**
   * The settings layer is the source of truth when present, so status output and
   * toggle defaults agree with what the TUI shows even if a live object lags.
   */
  const modeValue = (key: SettingKey, live: boolean): boolean =>
    settings ? Boolean(settings.values[key as keyof typeof settings.values]) : live;
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? '').toLowerCase();
    const rest = tokens.slice(1).join(' ');
    const usage =
      'Available options: /system-one status, /system-one skills [query], /system-one test [prompt], /system-one enable, /system-one disable, /system-one auto [on|off], /system-one auto-tools [on|off], /system-one auto-skills [on|off], /system-one auto-model [on|off], /system-one compact [on|off], /system-one auto-agents [on|off], /system-one tool-guard [on|off], /system-one agents [task], /system-one install-herdsman [--model <id>] [--thinking <level>] [--project] [--force], /system-one-settings';

    if (sub === 'status' || sub === '') {
      const info = await systemOneClient.getProviderInfo();
      const configured = systemOneClient.isConfigured();
      const stats = systemOneClient.stats;
      const activeTools = pi.getActiveTools();
      const allTools = pi.getAllTools();
      const activeSet = new Set(activeTools);
      const routable = allTools.filter(
        (t: any) => !activeSet.has(t.name) && !isSystemOneTool(t.name),
      ).length;

      const lines = [
        `System One Status:`,
        `• Provider configured: ${configured ? 'Yes' : 'No'}`,
        ...(info
          ? [
              `• Selected classifier: ${info.provider}/${info.model}${layer('model')}`,
              `• Provider: ${info.label} (${info.api})${layer('provider')}`,
              `• Authentication: ${info.auth}`,
              `• Selection source: ${info.source}`,
            ]
          : [`• ${describeUnconfigured()}`]),
        `• Requests in session: ${stats.requestsCount}`,
        `• Total tokens used: ${stats.totalTokens}`,
        `• Cost (session): ${stats.totalCostUsd > 0 ? `$${stats.totalCostUsd.toFixed(6)}` : 'n/a'}`,
        ...(stats.provider
          ? [
              `• Last response: ${stats.provider} / ${stats.model ?? '(unknown model)'}${stats.lastElapsedMs === undefined ? '' : ` (${stats.lastElapsedMs}ms)`}`,
            ]
          : []),
        ...(stats.truncations
          ? [
              `• Truncated state: ${stats.truncations} request(s), ${stats.truncatedChars ?? 0} chars${
                stats.truncatedItems ? `, ${stats.truncatedItems} items` : ''
              } dropped`,
            ]
          : []),
        ...(stats.fallback
          ? [
              `• Fallback (last request): ${stats.fallback.from} → ${stats.fallback.to} (${stats.fallback.reason})`,
            ]
          : []),
        `• Auto tool routing: ${autoTools() ? 'on' : 'off'}${layer('autoToolRouting')}${autoTools() && !configured ? ' (inactive: System One unconfigured)' : ''}`,
        `• Auto skill routing: ${autoSkills() ? 'on' : 'off'}${layer('autoSkillRouting')}${autoSkills() && !configured ? ' (inactive: System One unconfigured)' : ''}`,
        `• Auto-model: ${modeValue('autoModel', modelMode.enabled) ? 'on' : 'off'}${layer('autoModel')}`,
        `• Tool guard: ${modeValue('toolGuard', guardMode.enabled) ? 'on' : 'off'}${layer('toolGuard')}`,
        `• System One compaction: ${modeValue('compaction', compactMode.enabled) ? 'on' : 'off'}${layer('compaction')}`,
        `• Agent orchestration: ${modeValue('agentOrchestration', agentMode.enabled) ? 'on' : 'off'}${layer('agentOrchestration')}`,
        `• System One tools granted: ${modeValue('systemOneTools', activeSet.has(SYSTEM_ONE_GRANTABLE_TOOL_NAMES[0])) ? 'on' : 'off'}${layer('systemOneTools')}`,
        ...(settings ? [`• Settings files: ${settings.paths().user}`] : []),
        ...(settings?.legacyInputs.length
          ? [
              `• Legacy inputs (deprecated; migrate to System One names): ${settings.legacyInputs.join(', ')}`,
            ]
          : []),
        `• Active tools: ${activeTools.length} / Available: ${allTools.length} (${routable} routable)`,
        ...(stats.lastError ? [`• Last error: ${stats.lastError}`] : []),
      ];

      ctx.ui.notify(lines.join('\n'), 'info');
      return;
    }

    if (sub === 'help') {
      ctx.ui.notify(`System One commands:\n${usage}`, 'info');
      return;
    }

    if (sub === 'test' || sub === 'eval' || sub === 'evaluate') {
      if (!systemOneClient.isConfigured()) {
        ctx.ui.notify(`Cannot run evaluation: ${describeUnconfigured()}`, 'error');
        return;
      }

      const providerLabel = (await systemOneClient.getProviderInfo())?.label ?? 'System One';

      // With a prompt: the active model designs the evaluation. Without one: fixed smoke test.
      let request: SystemOneEvaluationRequest;
      if (rest) {
        ctx.ui.notify(`Designing a System One evaluation for: "${rest}"...`, 'info');
        try {
          request = await designEvaluation(ctx, rest, ctx.signal);
        } catch (err: any) {
          ctx.ui.notify(`Could not design evaluation: ${err?.message || err}`, 'error');
          return;
        }
        ctx.ui.notify(
          `Designed ${Object.keys(request.questions).length} question(s): ${Object.keys(request.questions).join(', ')}\nSending to ${providerLabel}...`,
          'info',
        );
      } else {
        ctx.ui.notify(`Sending test evaluation request to ${providerLabel}...`, 'info');
        request = {
          state: { message: 'Payment processing failed due to credit card expiration.' },
          questions: {
            is_billing: {
              type: 'bool' as const,
              instructions: 'Is this message related to a billing issue?',
            },
            category: {
              type: 'choice' as const,
              instructions: 'Which category does this issue fall into?',
              criteria: {
                billing: 'Billing, invoices, card issues',
                bug: 'Software bug or crash',
                other: 'General questions',
              },
            },
          },
        };
      }

      try {
        const res = await systemOneClient.evaluate(request);

        ctx.ui.notify(
          (rest
            ? `System One Evaluation (${res.elapsedMs}ms):\n`
            : `System One Test Successful (${res.elapsedMs}ms):\n`) +
            Object.entries(res.answers)
              .map(([id, ans]) => {
                const value =
                  ans.type === 'bool'
                    ? `${ans.value}${typeof ans.value === 'number' ? ` (${(ans.value * 100).toFixed(0)}% yes)` : ''}`
                    : `${ans.value}${ans.confidence !== undefined ? ` (confidence: ${ans.confidence})` : ''}`;
                return `• ${id}: ${value}`;
              })
              .join('\n'),
          'info',
        );
      } catch (err: any) {
        ctx.ui.notify(`System One Evaluation Failed: ${err?.message || err}`, 'error');
      }
      return;
    }

    if (sub === 'skills' || sub === 'skill') {
      const query = rest;
      if (!query) {
        const available = skillRouter.getAvailableSkills(ctx);
        ctx.ui.notify(
          `Available skills (${available.length}):\n` +
            available.map((s) => `• ${s.name}: ${s.description.slice(0, 80)}...`).join('\n'),
          'info',
        );
        return;
      }

      ctx.ui.notify(`Searching skills for: "${query}"...`, 'info');
      const res = await skillRouter.findSkills(query, {}, ctx);
      if (!res.primary) {
        ctx.ui.notify(
          res.abstained && res.candidates.length > 0
            ? res.abstainReason === 'none-won'
              ? `No skill is needed for "${query}" (System One chose none).`
              : `No skill was judged relevant for "${query}" (${res.abstainReason ?? 'no answer'}).`
            : `No skills matched "${query}".`,
          'info',
        );
        return;
      }

      const lines = [
        `• /skill:${res.primary.name} (P=${res.primary.probability.toFixed(2)}) - ${res.primary.description}`,
        ...res.runnersUp.map(
          (r) =>
            `• (alternative) /skill:${r.name} (relevance=${r.probability.toFixed(2)}) - ${r.description}`,
        ),
      ];

      ctx.ui.notify(
        `Matching skills for "${query}":\n` +
          lines.join('\n') +
          (res.fallbackUsed
            ? '\n(Note: System One unconfigured/offline — local keyword shortlist, probabilities are not System One judgments)'
            : ''),
        res.fallbackUsed ? 'warning' : 'info',
      );
      return;
    }

    if (sub === 'agents' || sub === 'orchestrate') {
      if (!rest) {
        ctx.ui.notify('Usage: /system-one agents <task>', 'warning');
        return;
      }
      const result = await agentMode.dispatch(rest, ctx);
      if (!result.accepted)
        ctx.ui.notify(
          `Agent orchestration unavailable: ${result.error ?? 'unknown error'}`,
          'warning',
        );
      return;
    }

    if (sub === 'tool-guard' || sub === 'toolguard' || sub === 'guard') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one tool-guard argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled =
        arg === 'on' ? true : arg === 'off' ? false : !modeValue('toolGuard', guardMode.enabled);
      setMode('toolGuard', enabled, () => guardMode.setEnabled(enabled));
      ctx.ui.notify(`System One tool guard ${enabled ? 'enabled' : 'disabled'}.`, 'info');
      return;
    }

    if (sub === 'compact') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one compact argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled =
        arg === 'on' ? true : arg === 'off' ? false : !modeValue('compaction', compactMode.enabled);
      setMode('compaction', enabled, () => compactMode.setEnabled(enabled));
      ctx.ui.notify(
        `System One compaction ${enabled ? 'enabled' : 'disabled'}. Use /compact to run it.`,
        'info',
      );
      return;
    }

    if (sub === 'auto-agents' || sub === 'autoagents') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one auto-agents argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled =
        arg === 'on'
          ? true
          : arg === 'off'
            ? false
            : !modeValue('agentOrchestration', agentMode.enabled);
      setMode('agentOrchestration', enabled, () => agentMode.setEnabled(enabled));
      ctx.ui.notify(`Automatic agent orchestration ${enabled ? 'enabled' : 'disabled'}.`, 'info');
      return;
    }

    if (sub === 'install-herdsman') {
      const tokens2 = rest.split(/\s+/).filter(Boolean);
      let model: string | undefined;
      let thinking: string | undefined;
      let project = false;
      let force = false;
      let badArg: string | undefined;

      for (let i = 0; i < tokens2.length; i += 1) {
        const token = tokens2[i];
        if (token === '--model' || token === '--thinking') {
          const value = tokens2[i + 1];
          if (!value) {
            badArg = token;
            break;
          }
          if (token === '--model') model = value;
          else thinking = value;
          i += 1;
        } else if (token === '--project') {
          project = true;
        } else if (token === '--force') {
          force = true;
        } else {
          badArg = token;
        }
      }

      if (badArg) {
        ctx.ui.notify(
          `Unknown /system-one install-herdsman argument "${badArg}". ${usage}`,
          'warning',
        );
        return;
      }
      if (thinking !== undefined && !(HERDSMAN_THINKING_LEVELS as readonly string[]).includes(thinking)) {
        ctx.ui.notify(
          `install-herdsman --thinking must be one of: ${HERDSMAN_THINKING_LEVELS.join(', ')}.`,
          'warning',
        );
        return;
      }

      const target = herdsmanJudgeDefinitionPath(
        project ? 'project' : 'global',
        ctx.cwd,
        getAgentDir(),
      );
      if (fs.existsSync(target) && !force) {
        ctx.ui.notify(
          `${target} already exists. Re-run with --force to overwrite.`,
          'warning',
        );
        return;
      }

      const extensionPath = fileURLToPath(new URL('../extensions/index.ts', import.meta.url));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buildHerdsmanJudgeDefinition({ extensionPath, model, thinking }));
      } catch (error) {
        ctx.ui.notify(`Could not write ${target}: ${(error as Error).message}`, 'error');
        return;
      }

      ctx.ui.notify(
        `Wrote pi-herdsman definition ${target}. Inside herdr, delegate with agent_delegate { definition: '${HERDSMAN_JUDGE_DEFINITION}', task: ... }.`,
        'info',
      );
      return;
    }

    if (sub === 'auto-model' || sub === 'automodel') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one auto-model argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled =
        arg === 'on' ? true : arg === 'off' ? false : !modeValue('autoModel', modelMode.enabled);
      setMode('autoModel', enabled, () => modelMode.setEnabled(enabled));
      ctx.ui.notify(`System One auto-model mode ${enabled ? 'enabled' : 'disabled'}.`, 'info');
      return;
    }

    if (sub === 'auto') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one auto argument "${rest}". ${usage}`, 'warning');
        return;
      }
      // Master switch: flips both paths together. Use /system-one auto-tools or auto-skills
      // to toggle one path on its own.
      const enabled = arg === 'on' ? true : arg === 'off' ? false : !(autoTools() && autoSkills());
      setAutoRouting(enabled);
      ctx.ui.notify(
        enabled
          ? 'System One auto mode enabled: each prompt routes tools and suggests skills in one shared System One request.'
          : 'System One auto mode disabled.',
        'info',
      );
      return;
    }

    if (sub === 'auto-tools' || sub === 'autotools') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one auto-tools argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled = arg === 'on' ? true : arg === 'off' ? false : !autoTools();
      setMode('autoToolRouting', enabled, () => auto.setToolsEnabled(enabled));
      ctx.ui.notify(
        `System One auto tool routing ${enabled ? 'enabled' : 'disabled'}${enabled ? " (shares the prompt's System One request with skill routing when both are on)" : ''}.`,
        'info',
      );
      return;
    }

    if (sub === 'auto-skills' || sub === 'autoskills') {
      const arg = rest.toLowerCase();
      if (arg !== '' && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify(`Unknown /system-one auto-skills argument "${rest}". ${usage}`, 'warning');
        return;
      }
      const enabled = arg === 'on' ? true : arg === 'off' ? false : !autoSkills();
      setMode('autoSkillRouting', enabled, () => auto.setSkillsEnabled(enabled));
      ctx.ui.notify(
        `System One auto skill routing ${enabled ? 'enabled' : 'disabled'}${enabled ? " (shares the prompt's System One request with tool routing when both are on)" : ''}.`,
        'info',
      );
      return;
    }

    if (sub === 'enable') {
      if (settings) settings.set('systemOneTools', true);
      else
        pi.setActiveTools([
          ...new Set([...pi.getActiveTools(), ...SYSTEM_ONE_GRANTABLE_TOOL_NAMES]),
        ]);
      ctx.ui.notify(
        `System One tools (${SYSTEM_ONE_GRANTABLE_TOOL_NAMES.join(', ')}) enabled${settings ? ' and saved to user settings' : ' for this session'}.`,
        'info',
      );
      return;
    }

    if (sub === 'disable') {
      if (settings) settings.set('systemOneTools', false);
      else pi.setActiveTools(pi.getActiveTools().filter((t) => !isSystemOneTool(t)));
      ctx.ui.notify(
        `System One tools disabled${settings ? ' and saved to user settings' : ' for this session'}.`,
        'info',
      );
      return;
    }

    ctx.ui.notify(`Unknown command /system-one ${sub}.\n${usage}`, 'warning');
  };

  pi.registerCommand('system-one', {
    description:
      'Manage System One classifier integration (TypeSafe, OpenRouter, llama.cpp, or compatible models)',
    handler,
  });
}
