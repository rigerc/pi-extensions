import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JevClient } from "../src/jev.js";
import { ToolRouter } from "../src/router.js";
import { SkillRouter } from "../src/skills.js";
import { AutoJev } from "../src/auto.js";
import { registerJevTools } from "../src/tools.js";
import { registerJevCommands } from "../src/commands.js";
import { AutoModelRouter } from "../src/model-router.js";
import { JevCompactor } from "../src/compact.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { JevAgentHandler } from "../src/agent.js";
import { ToolGuard } from "../src/tool-guard.js";
import { SettingsService } from "../src/settings.js";
import { registerJevSettingsCommand } from "../src/settings-ui.js";

/** Prompts that warrant the multi-agent workflow instead of a single turn. */
export const AUTO_DISPATCH_PATTERN =
  /\b(architecture|refactor|security review|entire repo|parallel|multiple agents|complex migration)\b/i;

export function shouldAutoDispatch(prompt: string): boolean {
  return AUTO_DISPATCH_PATTERN.test(prompt);
}

export default function (pi: ExtensionAPI) {
  const jevClient = new JevClient();
  const router = new ToolRouter(pi, jevClient);
  const skillRouter = new SkillRouter(pi, jevClient);

  // Flags are on-only forcing switches. Environment variables are handled by the
  // settings layer (SettingsService) so file/project config can sit underneath them.
  pi.registerFlag("jev-agents", {
    description: "Enable explicit and automatic orchestration of available agents",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-tool-guard", {
    description: "Validate tool calls with Jev System One to prevent hallucinations",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-compact", {
    description: "Use Jev to preserve important tool history during /compact",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-auto-model", {
    description: "Automatically choose a model for each prompt based on task needs",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-auto-tools", {
    description: "Auto-activate the tools a prompt needs (also via PI_JEV_AUTO_TOOLS=1)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-auto-skills", {
    description: "Auto-suggest matching skills per prompt (also via PI_JEV_AUTO_SKILLS=1)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("jev-auto", {
    description:
      "Enable both auto tool routing and auto skill routing (also via PI_JEV_AUTO=1)",
    type: "boolean",
    default: false,
  });

  const auto = new AutoJev(jevClient, router, skillRouter, false, false);
  const autoModel = new AutoModelRouter(pi, false);
  const compactor = new JevCompactor(jevClient, false);
  const agents = new AgentOrchestrator(pi, jevClient, false);
  agents.installCompletionNotice();

  const toolGuard = new ToolGuard(pi, jevClient, false);
  toolGuard.install();

  const agentHandler = new JevAgentHandler(pi, jevClient);
  agentHandler.install();

  const settings = new SettingsService(pi, jevClient, {
    auto,
    autoModel,
    agents,
    toolGuard,
    compactor,
  });

  registerJevTools(pi, jevClient, router, skillRouter);
  registerJevSettingsCommand(pi, settings, jevClient);
  registerJevCommands(
    pi,
    jevClient,
    router,
    skillRouter,
    auto,
    autoModel,
    compactor,
    agents,
    toolGuard,
    settings
  );

  pi.on("session_start", (_event, ctx) => {
    settings.init(ctx);

    if (!jevClient.isConfigured()) {
      ctx.ui.setStatus("jev", "jev: unconfigured");
      return;
    }

    const paths = [auto.tools ? "tools" : undefined, auto.skills ? "skills" : undefined].filter(
      (p): p is string => Boolean(p)
    );
    const autoLabel = paths.length > 0 ? `jev: auto (${paths.join("+")})` : "jev: ready";
    ctx.ui.setStatus("jev", autoModel.enabled ? "jev: auto-model" : autoLabel);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const result = await compactor.compact(event, ctx);
    if (!result.summary) return;
    ctx.ui.setStatus("jev", `jev: compact kept ${result.kept}/${result.considered}`);
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on("after_provider_response", (event, ctx) => {
    const kind = autoModel.recordProviderResponse(event.status, ctx.model);
    if (kind) ctx.ui.setStatus("jev", `jev: ${kind} → fallback next prompt`);
  });

  pi.on("before_agent_start", async (event, ctx) => {
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
        ctx.ui.setStatus("jev", `jev: ${modelResult.profile} → ${modelResult.model?.id ?? "model"}`);
      }
    }

    if (!auto.anyEnabled) return;

    const result = await auto.route(event.prompt, ctx, ctx.signal);
    if (!result.ran) return;

    if (result.activated.length > 0) {
      ctx.ui.setStatus("jev", `jev: auto (+${result.activated.length} tools)`);
    }

    if (result.skills.length === 0) return;

    return {
      message: {
        customType: "jev-auto",
        display: true,
        content:
          "Jev auto-matched skill(s) for this task. Load the matching SKILL.md before proceeding:\n" +
          result.skills
            .map((s) => `• /skill:${s.name} (P=${s.probability.toFixed(2)})`)
            .join("\n"),
      },
    };
  });
}
