import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
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
import { SYSTEM_ONE_TOOL_NAMES, isSystemOneTool } from './types.js';
import { SYSTEM_ONE_THRESHOLD } from './skills.js';
import { describeUnconfigured } from './system-one.js';
import type { SettingsService } from './settings.js';
import type { SettingKey } from './config.js';

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
   * Write a mode change through the settings layer when available, so it lands in the
   * session overrides and stays visible in `/system-one-settings`. Falls back to mutating the
   * live object directly when commands are registered without a settings service.
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
      settings.set('autoToolRouting', enabled);
      settings.set('autoSkillRouting', enabled);
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
      'Available options: /system-one status, /system-one skills [query], /system-one test [prompt], /system-one enable, /system-one disable, /system-one auto [on|off], /system-one auto-tools [on|off], /system-one auto-skills [on|off], /system-one auto-model [on|off], /system-one compact [on|off], /system-one auto-agents [on|off], /system-one tool-guard [on|off], /system-one agents [task], /system-one-settings';

    if (sub === 'status' || sub === '') {
      const origin = systemOneClient.getKeyOrigin();
      const info = systemOneClient.getProviderInfo();
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
        `• Configured: ${
          configured
            ? origin
              ? `Yes (from ${origin})`
              : info?.authMode === 'none'
                ? 'Yes (local endpoint; no key required)'
                : 'Yes'
            : 'No'
        }`,
        ...(info
          ? [
              `• Provider: ${info.provider} (${info.baseURL})${layer('provider')}`,
              `• Model: ${info.model}${layer('model')}`,
              `• Authentication: ${info.authMode === 'none' ? 'not required' : 'bearer'}`,
            ]
          : []),
        `• Requests in session: ${stats.requestsCount}`,
        `• Total tokens used: ${stats.totalTokens}`,
        ...(stats.totalCostUsd > 0 ? [`• Cost (session): $${stats.totalCostUsd.toFixed(6)}`] : []),
        ...(stats.truncations
          ? [
              `• Truncated state: ${stats.truncations} request(s), ${stats.truncatedChars ?? 0} chars${
                stats.truncatedItems ? `, ${stats.truncatedItems} items` : ''
              } dropped`,
            ]
          : []),
        ...(stats.fallback
          ? [`• Fallback: ${stats.fallback.from} → ${stats.fallback.to} (${stats.fallback.reason})`]
          : []),
        `• Auto tool routing: ${autoTools() ? 'on' : 'off'}${layer('autoToolRouting')}${autoTools() && !configured ? ' (inactive: System One unconfigured)' : ''}`,
        `• Auto skill routing: ${autoSkills() ? 'on' : 'off'}${layer('autoSkillRouting')}${autoSkills() && !configured ? ' (inactive: System One unconfigured)' : ''}`,
        `• Auto-model: ${modeValue('autoModel', modelMode.enabled) ? 'on' : 'off'}${layer('autoModel')}`,
        `• Tool guard: ${modeValue('toolGuard', guardMode.enabled) ? 'on' : 'off'}${layer('toolGuard')}`,
        `• System One compaction: ${modeValue('compaction', compactMode.enabled) ? 'on' : 'off'}${layer('compaction')}`,
        `• Agent orchestration: ${modeValue('agentOrchestration', agentMode.enabled) ? 'on' : 'off'}${layer('agentOrchestration')}`,
        `• System One tools granted: ${modeValue('systemOneTools', activeSet.has(SYSTEM_ONE_TOOL_NAMES[0])) ? 'on' : 'off'}${layer('systemOneTools')}`,
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

      const providerLabel = systemOneClient.getProviderInfo()?.label ?? 'System One';

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
              type: 'noul' as const,
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
                  ans.type === 'noul'
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
      const res = await skillRouter.findSkills(query, SYSTEM_ONE_THRESHOLD, ctx);
      if (res.recommended.length === 0) {
        ctx.ui.notify(`No skills matched "${query}".`, 'info');
        return;
      }

      ctx.ui.notify(
        `Matching skills for "${query}":\n` +
          res.recommended
            .map((r) => `• /skill:${r.name} (P=${r.probability.toFixed(2)}) - ${r.description}`)
            .join('\n') +
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
      else pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SYSTEM_ONE_TOOL_NAMES])]);
      ctx.ui.notify(
        `System One tools (${SYSTEM_ONE_TOOL_NAMES.join(', ')}) enabled for this session.`,
        'info',
      );
      return;
    }

    if (sub === 'disable') {
      if (settings) settings.set('systemOneTools', false);
      else pi.setActiveTools(pi.getActiveTools().filter((t) => !isSystemOneTool(t)));
      ctx.ui.notify('System One tools disabled for this session.', 'info');
      return;
    }

    ctx.ui.notify(`Unknown command /system-one ${sub}.\n${usage}`, 'warning');
  };

  pi.registerCommand('system-one', {
    description:
      'Manage System One integration (TypeSafe, OpenRouter, local Laya, or compatible models)',
    handler,
  });
  pi.registerCommand('jev', {
    description: 'Deprecated alias for /system-one (supported through 0.8)',
    handler,
  });
}
