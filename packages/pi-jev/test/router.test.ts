import test from "node:test";
import assert from "node:assert/strict";
import { ToolRouter, TOOL_CANDIDATE_LIMIT, TOOL_QUESTION_PREFIX } from "../src/router.js";
import { JEV_THRESHOLD } from "../src/skills.js";
import { JevClient } from "../src/jev.js";

test("ToolRouter shortlists inactive tools correctly using local keywords", () => {
  const mockTools = [
    { name: "read", description: "Read files from disk" },
    { name: "bash", description: "Execute shell commands" },
    { name: "docker_logs", description: "View container docker logs and inspect status" },
    { name: "git_push", description: "Push commits to remote git repository" },
  ];

  let activeTools = ["read", "bash"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  const jevClient = new JevClient();
  const router = new ToolRouter(mockPi, jevClient);

  const candidates = router.shortlist("docker container logs");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].name, "docker_logs");
});

test("ToolRouter findAndActivate fallback when unconfigured does not activate unjudged tools", async () => {
  const mockTools = [
    { name: "read", description: "Read files" },
    { name: "sqlite_query", description: "Query sqlite database" },
    { name: "postgres_query", description: "Query postgres database" },
  ];

  let activeTools = ["read"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  // Stub unconfigured client: local runs may have a real API key or secret file.
  const jevClient = { isConfigured: () => false } as unknown as JevClient;
  const router = new ToolRouter(mockPi, jevClient);

  const result = await router.findAndActivate("run SQL query against sqlite");
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.activated, []);
  assert.equal(result.probabilities["sqlite_query"], 0);
  assert.deepEqual(activeTools, ["read"]); // preserves existing without expanding
});

test("ToolRouter never offers its own jev tools as candidates", async () => {
  // Regression: after /jev disable, routing used to re-activate jev_find_skill/jev_evaluate.
  const mockTools = [
    { name: "read", description: "Read files" },
    { name: "jev_find_tools", description: "Find and activate tools" },
    { name: "jev_find_skill", description: "Find matching skills" },
    { name: "jev_evaluate", description: "Typed evaluations" },
    { name: "sqlite_query", description: "Query sqlite" },
  ];
  let activeTools = ["read"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  const jevClient = { isConfigured: () => false } as unknown as JevClient;
  const router = new ToolRouter(mockPi, jevClient);

  const candidates = router.shortlist("evaluate skills and find tools").map((c) => c.name);
  assert.ok(!candidates.includes("jev_find_tools"));
  assert.ok(!candidates.includes("jev_find_skill"));
  assert.ok(!candidates.includes("jev_evaluate"));

  const result = await router.findAndActivate("evaluate skills and find tools");
  assert.deepEqual(result.activated, []);
});

test("ToolRouter accepts a probability exactly at the shared threshold and rejects below it", async () => {
  const withProbability = (value: number | undefined) => {
    const jevClient = {
      isConfigured: () => value !== undefined,
      evaluate: async () => ({
        answers: value === undefined ? {} : { [`${TOOL_QUESTION_PREFIX}sqlite_query`]: { type: "noul", value } },
        model: "m",
        elapsedMs: 1,
      }),
    } as unknown as JevClient;
    const pi: any = {
      getAllTools: () => [{ name: "sqlite_query", description: "Query sqlite" }],
      getActiveTools: () => [],
      setActiveTools: () => {},
    };
    return new ToolRouter(pi, jevClient);
  };

  const atCutoff = await withProbability(JEV_THRESHOLD).findAndActivate("query sqlite");
  assert.deepEqual(atCutoff.activated, ["sqlite_query"]);
  assert.equal(atCutoff.fallbackUsed, false);

  const belowCutoff = await withProbability(JEV_THRESHOLD - 0.01).findAndActivate("query sqlite");
  assert.deepEqual(belowCutoff.activated, []);
});

test("ToolRouter caps candidates so a Jev request stays within the model's context budget", async () => {
  // OpenRouter serves Jev with a 32K context window: never send an unbounded tool list.
  const manyTools = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Query database table number ${i} with sqlite`,
  }));

  const jevClient = {
    isConfigured: () => true,
    evaluate: async () => ({ answers: {}, model: "m", elapsedMs: 1 }),
  } as unknown as JevClient;
  const pi: any = {
    getAllTools: () => manyTools,
    getActiveTools: () => [],
    setActiveTools: () => {},
  };

  const router = new ToolRouter(pi, jevClient);
  assert.equal(router.shortlist("query database", 10).length, 10);

  const result = await router.findAndActivate("query database");
  assert.equal(result.candidates.length, 10);
});

test("JevClient handles unconfigured state safely without throwing in check", () => {
  const client = new JevClient();
  assert.equal(typeof client.isConfigured(), "boolean");
});

test("ToolRouter shortlist can exclude tools a previous pass already judged", () => {
  const pi: any = {
    getAllTools: () => [
      { name: "docker_logs", description: "Docker logs" },
      { name: "docker_stop", description: "Docker stop" },
    ],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const router = new ToolRouter(pi, new JevClient());

  assert.equal(router.shortlist("docker", 10).length, 2);
  assert.deepEqual(
    router.shortlist("docker", 10, new Set(["docker_logs"])).map((t) => t.name),
    ["docker_stop"]
  );
});

test("ToolRouter widens once when coverage says the shortlist was incomplete", async () => {
  const pool = Array.from({ length: TOOL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Query specialty table ${i}`,
  }));
  const requests: any[] = [];
  const activated: string[][] = [];
  let activeTools: string[] = [];
  const pi: any = {
    getAllTools: () => pool,
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
      activated.push(names);
    },
  };
  const mockJev = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      requests.push(request);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", value: id.startsWith("coverage__") ? 0.1 : 0.9 },
          ])
        ),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  } as unknown as JevClient;

  const result = await new ToolRouter(pi, mockJev).findAndActivate("specialty query");

  assert.equal(result.escalated, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].state.tools.length, TOOL_CANDIDATE_LIMIT);
  assert.deepEqual(
    requests[1].state.tools.map((t: any) => t.name),
    [`tool_${TOOL_CANDIDATE_LIMIT}`]
  );
  assert.equal(result.activated.length, TOOL_CANDIDATE_LIMIT + 1);
  assert.equal(activeTools.length, TOOL_CANDIDATE_LIMIT + 1, "activation stays additive across passes");
});

test("ToolRouter keeps first-pass verdicts when the widening pass fails", async () => {
  const pool = Array.from({ length: TOOL_CANDIDATE_LIMIT + 1 }, (_, i) => ({
    name: `tool_${i}`,
    description: "Query specialty table",
  }));
  let call = 0;
  const pi: any = {
    getAllTools: () => pool,
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const mockJev = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      call += 1;
      if (call > 1) throw new Error("second pass failed");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", value: id.startsWith("coverage__") ? 0.02 : 0.9 },
          ])
        ),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  } as unknown as JevClient;

  const result = await new ToolRouter(pi, mockJev).findAndActivate("specialty query");
  assert.equal(result.escalated, false);
  assert.equal(result.activated.length, TOOL_CANDIDATE_LIMIT);
});
