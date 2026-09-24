import test from "node:test";
import assert from "node:assert/strict";
import { AutoJev } from "../src/auto.js";
import { JEV_THRESHOLD } from "../src/skills.js";
import type { JevClient } from "../src/jev.js";
import type { ToolRouter } from "../src/router.js";
import type { SkillRouter } from "../src/skills.js";

function stubs(
  configured = true,
  options: {
    sufficient?: number;
    toolSufficient?: number;
    skillSufficient?: number;
    tools?: string[];
    skills?: string[];
  } = {}
) {
  const calls = { tools: 0, skills: 0, requests: 0, shortlists: 0 };
  const thresholds: number[] = [];
  const requests: any[] = [];
  const sufficient = options.sufficient ?? 0.95;
  const toolSufficient = options.toolSufficient ?? sufficient;
  const skillSufficient = options.skillSufficient ?? sufficient;

  const toolPool = options.tools ?? ["docker_logs"];
  const skillPool = options.skills ?? ["tdd"];

  const jevClient = {
    isConfigured: () => configured,
    evaluate: async (request: any) => {
      calls.requests += 1;
      requests.push(request);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            {
              type: "noul",
              value: id === "coverage__tool"
                ? toolSufficient
                : id === "coverage__skill"
                  ? skillSufficient
                  : id.includes("docker_logs")
                    ? 0.9
                    : 0.8,
            },
          ])
        ),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  } as unknown as JevClient;

  const router = {
    shortlist: (_prompt: string, limit = 10, exclude?: ReadonlySet<string>) => {
      calls.shortlists += 1;
      return toolPool
        .filter((name) => !(exclude?.has(name) ?? false))
        .slice(0, limit)
        .map((name) => ({ name, description: `View ${name} logs` }));
    },
    applyActivation: (probabilities: Record<string, number>, threshold: number, names: string[]) => {
      calls.tools += 1;
      thresholds.push(threshold);
      return names.filter((name) => (probabilities[name] ?? 0) >= threshold);
    },
  } as unknown as ToolRouter;

  const skillRouter = {
    getAvailableSkills: () => skillPool.map((name) => ({ name, description: `Skill ${name}` })),
    shortlist: (
      skills: Array<{ name: string }>,
      _prompt?: string,
      limit = 12,
      exclude?: ReadonlySet<string>
    ) => skills.filter((s) => !(exclude?.has(s.name) ?? false)).slice(0, limit),
    applyRecommendations: (
      probabilities: Record<string, number>,
      threshold: number,
      candidates: Array<{ name: string; description: string }>
    ) => {
      calls.skills += 1;
      thresholds.push(threshold);
      return candidates
        .map((c) => ({ ...c, probability: probabilities[c.name] ?? 0 }))
        .filter((c) => c.probability >= threshold);
    },
  } as unknown as SkillRouter;

  return { jevClient, router, skillRouter, calls, thresholds, requests };
}

test("AutoJev stays off until enabled", async () => {
  const { jevClient, router, skillRouter, calls } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, false);

  const result = await auto.route("inspect docker logs");
  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.equal(calls.tools, 0);
  assert.equal(calls.skills, 0);
  assert.equal(calls.requests, 0);
});

test("AutoJev skips when Jev is unconfigured", async () => {
  const { jevClient, router, skillRouter, calls } = stubs(false);
  const auto = new AutoJev(jevClient, router, skillRouter, true);

  const result = await auto.route("inspect docker logs");
  assert.equal(result.ran, false);
  assert.equal(result.reason, "unconfigured");
  assert.equal(calls.tools + calls.skills, 0);
  assert.equal(calls.requests, 0);
});

test("AutoJev routes tools and skills in one Jev request", async () => {
  const { jevClient, router, skillRouter, calls, requests } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, true);

  const result = await auto.route("write tests for docker logs");
  assert.equal(result.ran, true);
  assert.deepEqual(result.activated, ["docker_logs"]);
  assert.deepEqual(result.skills, [{ name: "tdd", probability: 0.8 }]);
  assert.equal(calls.requests, 1, "one prompt spends exactly one Jev request");
  assert.equal(result.escalated, false, "a sufficient shortlist never widens");
  assert.deepEqual(result.widened, { tools: false, skills: false });
  assert.equal(calls.tools, 1);
  assert.equal(calls.skills, 1);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [
    "coverage__skill",
    "coverage__tool",
    "skill__tdd",
    "tool__docker_logs",
  ]);
  assert.equal("recent_context" in requests[0].state, true, "routers share prompt context with Jev");
});

test("AutoJev widens once when the coverage answer says the shortlist was incomplete", async () => {
  // The local term-overlap shortlist is the recall ceiling; the coverage Noul is the
  // only signal that can recover a candidate it dropped. A pool larger than the
  // candidate limit makes the first pass visibly partial.
  const tools = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
  const { jevClient, router, skillRouter, calls, requests } = stubs(true, {
    sufficient: 0.1,
    tools,
  });
  // Tools only: the skill pool would otherwise need its own oversized fixture.
  const auto = new AutoJev(jevClient, router, skillRouter, true, false);

  const result = await auto.route("inspect every docker log stream");

  assert.equal(result.escalated, true);
  assert.deepEqual(result.widened, { tools: true, skills: false });
  assert.equal(calls.requests, 2, "widening costs exactly one extra request");
  assert.equal(requests[0].state.tools.length, 10, "the first pass is bounded by the candidate limit");
  assert.deepEqual(
    requests[1].state.tools.map((t: any) => t.name),
    ["tool_10", "tool_11"],
    "the second pass judges only what the first pass never saw"
  );
  assert.equal(result.activated.length, 12, "both passes contribute to the activation");
  assert.deepEqual(result.skills, []);
});

test("AutoJev keeps first-pass results when the widening pass fails", async () => {
  let call = 0;
  const jevClient = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      call += 1;
      if (call > 1) throw new Error("second request failed");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", value: id.startsWith("coverage__") ? 0.05 : 0.9 },
          ])
        ),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  } as unknown as JevClient;
  const tools = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
  const { router, skillRouter } = stubs(true, { tools });

  const result = await new AutoJev(jevClient, router, skillRouter, true, false).route("docker");
  assert.equal(result.ran, true);
  assert.equal(result.escalated, false);
  assert.deepEqual(result.widened, { tools: false, skills: false });
  assert.equal(result.activated.length, 10, "the first verdicts survive a failed retry");
});

test("AutoJev ignores slash commands and concurrent prompts, and never throws", async () => {
  const { jevClient, router, skillRouter } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, true);

  assert.equal((await auto.route("/jev status")).reason, "empty-prompt");
  assert.equal((await auto.route("   ")).reason, "empty-prompt");

  const failing = new AutoJev(
    {
      isConfigured: () => true,
      evaluate: async () => {
        throw new Error("boom");
      },
    } as unknown as JevClient,
    router,
    skillRouter,
    true
  );
  const failed = await failing.route("anything");
  assert.equal(failed.ran, false);
  assert.equal(failed.reason, "error");

  // A run in flight makes the next prompt skip instead of queueing.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowClient = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      await gate;
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", value: 0.9 }])
        ),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  } as unknown as JevClient;
  const slow = new AutoJev(slowClient, router, skillRouter, true);
  const first = slow.route("first");
  const second = await slow.route("second");
  assert.equal(second.reason, "busy");
  release();
  assert.equal((await first).ran, true);
});

test("AutoJev routes only tools when the skill path is off", async () => {
  const { jevClient, router, skillRouter, calls, requests } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, true, false);

  const result = await auto.route("write tests for docker logs");
  assert.equal(result.ran, true);
  assert.equal(result.toolRouting, true);
  assert.equal(result.skillRouting, false);
  assert.deepEqual(result.activated, ["docker_logs"]);
  assert.deepEqual(result.skills, []);
  assert.equal(calls.requests, 1);
  assert.equal(calls.skills, 0, "the disabled path must spend no work");
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [
    "coverage__tool",
    "tool__docker_logs",
  ]);
  assert.deepEqual(requests[0].state.available_skills, []);
});

test("AutoJev routes only skills when the tool path is off", async () => {
  const { jevClient, router, skillRouter, calls, requests } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, false, true);

  const result = await auto.route("write tests for docker logs");
  assert.equal(result.ran, true);
  assert.equal(result.toolRouting, false);
  assert.equal(result.skillRouting, true);
  assert.deepEqual(result.activated, []);
  assert.deepEqual(result.skills, [{ name: "tdd", probability: 0.8 }]);
  assert.equal(calls.tools, 0, "the disabled path must spend no work");
  assert.equal(calls.requests, 1);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [
    "coverage__skill",
    "skill__tdd",
  ]);
  assert.deepEqual(requests[0].state.tools, []);
});

test("AutoJev is disabled when both routing paths are off", async () => {
  const { jevClient, router, skillRouter, calls } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, false, false);

  assert.equal(auto.anyEnabled, false);
  assert.equal((await auto.route("anything")).reason, "disabled");
  assert.equal(calls.tools + calls.skills, 0);
  assert.equal(calls.requests, 0);
});

test("AutoJev paths can be toggled independently", async () => {
  const { jevClient, router, skillRouter, calls } = stubs();
  const auto = new AutoJev(jevClient, router, skillRouter, false);

  auto.setToolsEnabled(true);
  assert.equal(auto.tools, true);
  assert.equal(auto.skills, false);
  assert.equal(auto.anyEnabled, true);

  auto.setSkillsEnabled(true);
  auto.setToolsEnabled(false);
  assert.equal(auto.tools, false);
  assert.equal(auto.skills, true);

  await auto.route("anything");
  assert.equal(calls.tools, 0, "only the enabled path runs");
  assert.equal(calls.skills, 1);
  assert.equal(calls.requests, 1);

  auto.setEnabled(false);
  assert.equal(auto.anyEnabled, false, "setEnabled remains a master switch for both");
});

test("auto mode spends one request and applies the shared activation threshold", async () => {
  // Auto mode must use the same cutoff as the router and command defaults, and must
  // not pay for a second request when both paths are on.
  const { jevClient, router, skillRouter, calls, thresholds } = stubs();

  await new AutoJev(jevClient, router, skillRouter, true).route("anything");
  assert.equal(calls.requests, 1);
  assert.deepEqual(thresholds, [JEV_THRESHOLD, JEV_THRESHOLD]);
});

test("AutoJev widens only the path Jev judged incomplete", async () => {
  // A tool-only shortfall must not spend questions on new skills: the second request
  // carries tool questions only, and only the tool path is reported as widened.
  const tools = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
  const { jevClient, router, skillRouter, calls, requests } = stubs(true, {
    toolSufficient: 0.1,
    skillSufficient: 0.95,
    tools,
  });

  const result = await new AutoJev(jevClient, router, skillRouter, true, true).route("docker");

  assert.equal(calls.requests, 2);
  assert.deepEqual(result.widened, { tools: true, skills: false });
  assert.equal(result.escalated, true);
  assert.deepEqual(
    Object.keys(requests[1].questions).filter((id) => id.startsWith("skill__")),
    [],
    "the sufficient skill path contributes no questions to the widening pass"
  );
  assert.deepEqual(requests[1].state.available_skills, []);
  assert.equal(calls.skills, 1, "skills are judged once, in the shared first request");
});

test("AutoJev widens skills alone when only the skill shortlist was incomplete", async () => {
  const skills = Array.from({ length: 13 }, (_, i) => `skill_${i}`);
  const { jevClient, router, skillRouter, calls, requests } = stubs(true, {
    toolSufficient: 0.95,
    skillSufficient: 0.1,
    skills,
  });

  const result = await new AutoJev(jevClient, router, skillRouter, true, true).route("write tests");

  assert.equal(calls.requests, 2);
  assert.deepEqual(result.widened, { tools: false, skills: true });
  assert.equal(
    Object.keys(requests[1].questions).some((id) => id.startsWith("tool__")),
    false,
    "a sufficient tool path contributes no questions to the widening pass"
  );
  assert.deepEqual(requests[1].state.tools, []);
  assert.equal(calls.tools, 1, "tools are judged once, in the shared first request");
});

test("AutoJev widening never enables a disabled path", async () => {
  const tools = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
  const { jevClient, router, skillRouter, calls, requests } = stubs(true, {
    toolSufficient: 0.1,
    tools,
  });

  // Skills off: even the widening pass must carry no skill state or questions.
  const result = await new AutoJev(jevClient, router, skillRouter, true, false).route("docker");

  assert.equal(result.widened.skills, false);
  assert.equal(calls.skills, 0, "the disabled path is never judged, first pass or widening");
  for (const request of requests) {
    assert.deepEqual(request.state.available_skills, []);
    assert.equal(
      Object.keys(request.questions).some((id) => id.startsWith("skill__")),
      false
    );
  }
});
