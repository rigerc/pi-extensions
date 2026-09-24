import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SystemOneClient } from '../src/system-one.js';
import { ToolRouter } from '../src/router.js';
import { SkillRouter } from '../src/skills.js';
import { AutoSystemOne } from '../src/auto.js';
import { registerSystemOneTools } from '../src/tools.js';
import { registerSystemOneCommands } from '../src/commands.js';
import { AutoModelRouter } from '../src/model-router.js';
import { SystemOneCompactor } from '../src/compact.js';
import { AgentOrchestrator } from '../src/orchestrator.js';
import { SystemOneAgentHandler } from '../src/agent.js';
import { ToolGuard } from '../src/tool-guard.js';
import { SettingsService } from '../src/settings.js';
import { registerSystemOneSettingsCommand } from '../src/settings-ui.js';

/** Prompts that warrant the multi-agent workflow instead of a single turn. */
export const AUTO_DISPATCH_PATTERN =
  /\b(architecture|refactor|security review|entire repo|parallel|multiple agents|complex migration)\b/i;

export function shouldAutoDispatch(prompt: string): boolean {
  return AUTO_DISPATCH_PATTERN.test(prompt);
}

export default function (pi: ExtensionAPI) {
  const systemOneClient = new SystemOneClient();
  const router = new ToolRouter(pi, systemOneClient);
  const skillRouter = new SkillRouter(pi, systemOneClient);

  // Flags are on-only forcing switches. Environment variables are handled by the
  // settings layer (SettingsService) so file/project config can sit underneath them.
  const registerFlag = (canonical: string, legacy: string, description: string): void => {
    pi.registerFlag(canonical, { description, type: 'boolean', default: false });
    pi.registerFlag(legacy, {
      description: `Deprecated alias for --${canonical} (supported through 0.8)`,
      type: 'boolean',
      default: false,
    });
  };

  registerFlag(
    'system-one-agents',
    'jev-agents',
    'Enable explicit and automatic orchestration of available agents',
  );
  registerFlag(
    'system-one-tool-guard',
    'jev-tool-guard',
    'Validate tool calls with System One to prevent hallucinations',
  );
  registerFlag(
    'system-one-compact',
    'jev-compact',
    'Use System One to preserve important tool history during /compact',
  );
  registerFlag(
    'system-one-auto-model',
    'jev-auto-model',
    'Automatically choose a model for each prompt based on task needs',
  );
  registerFlag(
    'system-one-auto-tools',
    'jev-auto-tools',
    'Auto-activate the tools a prompt needs (also via PI_SYSTEM_ONE_AUTO_TOOLS=1)',
  );
  registerFlag(
    'system-one-auto-skills',
    'jev-auto-skills',
    'Auto-suggest matching skills per prompt (also via PI_SYSTEM_ONE_AUTO_SKILLS=1)',
  );
  registerFlag(
    'system-one-auto',
    'jev-auto',
    'Enable both auto tool routing and auto skill routing (also via PI_SYSTEM_ONE_AUTO=1)',
  );

  const auto = new AutoSystemOne(systemOneClient, router, skillRouter, false, false);
  const autoModel = new AutoModelRouter(pi, false);
  const compactor = new SystemOneCompactor(systemOneClient, false);
  const agents = new AgentOrchestrator(pi, systemOneClient, false);
  agents.installCompletionNotice();

  const toolGuard = new ToolGuard(pi, systemOneClient, false);
  toolGuard.install();

  const agentHandler = new SystemOneAgentHandler(pi, systemOneClient);
  agentHandler.install();

  const settings = new SettingsService(pi, systemOneClient, {
    auto,
    autoModel,
    agents,
    toolGuard,
    compactor,
  });

  registerSystemOneTools(pi, systemOneClient, router, skillRouter);
  registerSystemOneSettingsCommand(pi, settings, systemOneClient);
  registerSystemOneCommands(
    pi,
    systemOneClient,
    router,
    skillRouter,
    auto,
    autoModel,
    compactor,
    agents,
    toolGuard,
    settings,
  );

  pi.on('session_start', (_event, ctx) => {
    settings.init(ctx);

    if (!systemOneClient.isConfigured()) {
      ctx.ui.setStatus('system-one', 'system-one: unconfigured');
      return;
    }

    const paths = [auto.tools ? 'tools' : undefined, auto.skills ? 'skills' : undefined].filter(
      (p): p is string => Boolean(p),
    );
    const autoLabel =
      paths.length > 0 ? `system-one: auto (${paths.join('+')})` : 'system-one: ready';
    ctx.ui.setStatus('system-one', autoModel.enabled ? 'system-one: auto-model' : autoLabel);
  });

  pi.on('session_before_compact', async (event, ctx) => {
    const result = await compactor.compact(event, ctx);
    if (!result.summary) return;
    ctx.ui.setStatus('system-one', `system-one: compact kept ${result.kept}/${result.considered}`);
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on('after_provider_response', (event, ctx) => {
    const kind = autoModel.recordProviderResponse(event.status, ctx.model);
    if (kind) {
      ctx.ui.setStatus('system-one', `system-one: ${kind} → fallback next prompt`);
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    // Agent orchestration and auto-model are independent opt-in modes, so neither may
    // ride on the auto tool/skill routing switch.
    if (agents.enabled && shouldAutoDispatch(event.prompt)) {
      await agents.dispatch(event.prompt, ctx, true);
    }

    if (autoModel.enabled) {
      const modelResult = await autoModel.route(event.prompt, ctx, {
        hasImages: Boolean(event.images?.length),
      });
      if (modelResult.changed) {
        ctx.ui.setStatus(
          'system-one',
          `system-one: ${modelResult.profile} → ${modelResult.model?.id ?? 'model'}`,
        );
      }
    }

    if (!auto.anyEnabled) return;

    const result = await auto.route(event.prompt, ctx, ctx.signal);
    if (!result.ran) return;

    if (result.activated.length > 0) {
      ctx.ui.setStatus('system-one', `system-one: auto (+${result.activated.length} tools)`);
    }

    if (result.skills.length === 0) return;

    return {
      message: {
        customType: 'system-one-auto',
        display: true,
        content:
          'System One auto-matched skill(s) for this task. Load the matching SKILL.md before proceeding:\n' +
          result.skills.map((s) => `• /skill:${s.name} (P=${s.probability.toFixed(2)})`).join('\n'),
      },
    };
  });
}
