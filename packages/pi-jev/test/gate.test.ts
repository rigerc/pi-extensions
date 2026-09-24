import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  capGateState,
  collectGitEvidence,
  evaluateGate,
  parseGateArgs,
  resolveGateState,
  MAX_GATE_STATE_CHARS,
} from "../src/gate.js";
import { capState, JevClient } from "../src/jev.js";

function temporaryRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-gate-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

/** Exercise the real JevClient state caps while replacing only network transport. */
function recordingClient() {
  const client = new JevClient();
  client.setApiKey("test-key");
  const requests: any[] = [];
  (client as any).getClient = () => ({ systemOne: async (request: any) => {
    requests.push(request);
    return { answers: { gate_passed: { noul: 0.9 } }, model: "test", usage: {} };
  } });
  return { client, requests };
}

test("parseGateArgs parses flags and criteria correctly", () => {
  const args = ["--criteria", "All tests pass", "-p", "0.85", "--diff", "--json", "--fail-open"];
  const opts = parseGateArgs(args);
  assert.equal(opts.criteria, "All tests pass");
  assert.equal(opts.threshold, 0.85);
  assert.equal(opts.diff, true);
  assert.equal(opts.json, true);
  assert.equal(opts.failOpen, true);
});

test("parseGateArgs handles positional criteria", () => {
  const args = ["Code is clean and modular", "-p", "0.9"];
  const opts = parseGateArgs(args);
  assert.equal(opts.criteria, "Code is clean and modular");
  assert.equal(opts.threshold, 0.9);
});

test("resolveGateState returns provided state string or diff fallback", () => {
  const state = resolveGateState({ criteria: "test", state: "function foo() { return 42; }" });
  assert.equal(state, "function foo() { return 42; }");
});

test("evaluateGate fails open when unconfigured if failOpen is true", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => false;

  const result = await evaluateGate(
    { criteria: "Must not break build", failOpen: true },
    mockClient
  );
  assert.equal(result.passed, true);
  assert.equal(result.evaluated, false, "no Jev judgment happened");
  assert.equal(result.probability, null, "a policy pass must not fabricate certainty");
  assert.match(result.error ?? "", /unconfigured/i);
});

test("evaluateGate marks an evaluated pass as evaluated", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: { gate_passed: { type: "noul", value: 0.92, confidence: 0.95 } },
    model: "jev-latest",
    elapsedMs: 45,
  });

  const result = await evaluateGate({ criteria: "ok", state: "x" }, mockClient);
  assert.equal(result.evaluated, true);
  assert.equal(result.probability, 0.92);
});

test("evaluateGate evaluates gate condition with JevClient", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: {
      gate_passed: {
        type: "noul",
        value: 0.92,
        confidence: 0.95,
      },
    },
    model: "jev-latest",
    elapsedMs: 45,
  });

  const passResult = await evaluateGate(
    { criteria: "Clean TypeScript with no any", threshold: 0.8, state: "const x: number = 1;" },
    mockClient
  );
  assert.equal(passResult.passed, true);
  assert.equal(passResult.probability, 0.92);

  const failResult = await evaluateGate(
    { criteria: "Clean TypeScript with no any", threshold: 0.95, state: "const x: number = 1;" },
    mockClient
  );
  assert.equal(failResult.passed, false);
  assert.equal(failResult.truncated, false);
});

test("capGateState marks evidence it had to cut", () => {
  const long = "x".repeat(500);
  const cut = capGateState(long, 100);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /\[truncated 400 chars/);

  const short = capGateState("ok", 100);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "ok");
});

test("evaluateGate tells the judge when the evidence was truncated", async () => {
  // A gate that silently passes on unseen evidence is worse than one that fails, so
  // the cut is reported both to Jev and to the caller.
  const requests: any[] = [];
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (request: any) => {
    requests.push(request);
    return {
      answers: { gate_passed: { type: "noul", value: 0.9 } },
      model: "jev-latest",
      elapsedMs: 3,
    };
  };

  const result = await evaluateGate(
    {
      criteria: "No new any types",
      threshold: 0.7,
      state: "y".repeat(MAX_GATE_STATE_CHARS + 10),
    },
    mockClient
  );

  assert.equal(result.truncated, true);
  assert.equal(requests[0].state.truncated, true);
  assert.match(requests[0].state.output, /\[truncated \d+ chars/);
});

test("evaluateGate keeps untruncated evidence intact", async () => {
  const requests: any[] = [];
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (request: any) => {
    requests.push(request);
    return {
      answers: { gate_passed: { type: "noul", value: 0.9 } },
      model: "jev-latest",
      elapsedMs: 3,
    };
  };

  const result = await evaluateGate(
    { criteria: "Clean", threshold: 0.7, state: "const x = 1;" },
    mockClient
  );

  assert.equal(result.truncated, false);
  assert.equal(requests[0].state.truncated, false);
  assert.equal(requests[0].state.output, "const x = 1;");
});

test("git evidence includes nested and quoted paths, staged files, and respects ignores", () => {
  const dir = temporaryRepo();
  try {
    fs.mkdirSync(path.join(dir, "new"));
    const files = ["new/nested.ts", "with space.ts", "café.ts", "tab\tfile.ts"];
    for (const [i, file] of files.entries()) fs.writeFileSync(path.join(dir, file), `UNTRACKED_CONTENT_${i}`);
    fs.writeFileSync(path.join(dir, "staged.ts"), "STAGED_CONTENT");
    execFileSync("git", ["add", "staged.ts"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "IGNORED_CONTENT");

    const evidence = collectGitEvidence(dir);
    for (const [i, file] of files.entries()) {
      assert.ok(evidence.text.includes(file));
      assert.ok(evidence.text.includes(`UNTRACKED_CONTENT_${i}`));
    }
    assert.match(evidence.text, /STAGED_CONTENT/);
    assert.doesNotMatch(evidence.text, /IGNORED_CONTENT/);
    assert.equal(evidence.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git per-file truncation reaches the gate request and result", async () => {
  const dir = temporaryRepo();
  const originalCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(dir, "long.ts"), "x".repeat(5000) + "UNSEEN_TAIL");
    const evidence = collectGitEvidence(dir);
    assert.equal(evidence.truncated, true);
    assert.match(evidence.text, /\[truncated \d+ chars/);
    assert.doesNotMatch(evidence.text, /UNSEEN_TAIL/);

    process.chdir(dir);
    const { client, requests } = recordingClient();
    const result = await evaluateGate({ criteria: "No violations", diff: true }, client);
    assert.equal(result.truncated, true);
    assert.equal(requests[0].state.truncated, true);
    assert.match(requests[0].state.output, /\[truncated \d+ chars/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gate marks client per-field cuts as truncated before sending the request", async () => {
  for (const length of [20000, MAX_GATE_STATE_CHARS + 100]) {
    const { client, requests } = recordingClient();
    const result = await evaluateGate({ criteria: "No violations", state: "x".repeat(length) + "UNSEEN_TAIL" }, client);
    const state = requests[0].state;
    assert.equal(result.truncated, true);
    assert.equal(state.truncated, true);
    assert.match(state.output, /\[truncated \d+ chars/);
    assert.doesNotMatch(state.output, /UNSEEN_TAIL/);
    assert.equal(capState(state).truncatedChars, 0, "the client cannot introduce another unreported cut");
    assert.equal(capState(state).truncatedItems, 0);
  }
});

test("unreadable untracked files are explicitly marked as omitted evidence", () => {
  const dir = temporaryRepo();
  try {
    fs.symlinkSync("missing-target", path.join(dir, "broken-link"));
    const evidence = collectGitEvidence(dir);
    assert.equal(evidence.truncated, true);
    assert.match(evidence.text, /broken-link/);
    assert.match(evidence.text, /omitted: file could not be read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git collection failures do not become successful empty-change judgments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-no-git-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const { client, requests } = recordingClient();
    await assert.rejects(evaluateGate({ criteria: "No violations", diff: true }, client));
    assert.equal(requests.length, 0);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
