import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { capState, JevClient } from "./jev.js";
import { describeUnconfigured } from "./jev.js";
import type { JevAnswerResult } from "./types.js";

/**
 * Jev serves a 32K-token window, and a gate's evidence is a whole diff, file, or
 * pipeline log. Cap what is sent and tell the judge it is partial: a gate that
 * silently passes on unseen evidence is worse than one that fails.
 */
export const MAX_GATE_STATE_CHARS = 48_000;

/** Per-file cap for untracked files folded into the diff state. */
export const MAX_UNTRACKED_FILE_CHARS = 4_000;

export interface GateEvidence {
  text: string;
  /** Evidence was cut or could not be read in full. */
  truncated: boolean;
}

export interface GateOptions {
  criteria: string;
  threshold?: number;
  state?: string | Record<string, unknown>;
  diff?: boolean;
  file?: string;
  json?: boolean;
  failOpen?: boolean;
  model?: string;
}

export interface GateResult {
  passed: boolean;
  /** False when the gate passed without a Jev judgment (fail-open on config/API error). */
  evaluated: boolean;
  /** Null when no evaluation ran; never fabricated as certainty. */
  probability: number | null;
  confidence?: number;
  criteria: string;
  threshold: number;
  elapsedMs: number;
  /** True when the evidence was cut to fit Jev's context window. */
  truncated: boolean;
  answer?: JevAnswerResult;
  error?: string;
}

export function parseGateArgs(args: string[]): GateOptions {
  const options: GateOptions = {
    criteria: "",
    threshold: 0.7,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--criteria") {
      options.criteria = args[++i] || "";
    } else if (arg === "-p" || arg === "--min-prob" || arg === "--threshold") {
      const val = parseFloat(args[++i] || "0.7");
      if (!isNaN(val)) options.threshold = val;
    } else if (arg === "-d" || arg === "--diff") {
      options.diff = true;
    } else if (arg === "-f" || arg === "--file") {
      options.file = args[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-open") {
      options.failOpen = true;
    } else if (arg === "-m" || arg === "--model") {
      options.model = args[++i];
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (!options.criteria && !arg.startsWith("-")) {
      options.criteria = arg;
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Usage: jev-gate [options] [criteria]

Post-run gate check using Jev System One evaluation (TypeSafe, OpenRouter, or local Laya).
Exits with 0 if evaluation meets threshold, non-zero otherwise.

Provider credentials come from TYPESAFE_API_KEY or OPENROUTER_API_KEY
(or ~/.pi/agent/secrets/{typesafe,openrouter}_api_key). Local Laya is keyless by
default; select it with PI_JEV_PROVIDER=laya and optionally set LAYA_API_KEY.
PI_JEV_API_KEY and PI_JEV_BASE_URL are generic overrides.

Options:
  -c, --criteria <text>      Acceptance criteria to check against output/diff
  -p, --threshold <num>      Minimum passing probability (default: 0.7)
  -d, --diff                 Use git diff (HEAD), cached and untracked files as state
  -f, --file <path>          Read state from file
      --json                 Output result in JSON format
      --fail-open            Exit 0 even on API or config error
  -m, --model <model>        Override Jev model (default: jev-latest)
  -h, --help                 Show this help message

Examples:
  subagent gate: "npx pi-jev-gate -c 'Tests pass and no new any types' -d"
  pipeline gate: "git diff | npx pi-jev-gate -c 'All exports documented'"
`);
}

/**
 * `git diff HEAD` omits untracked files, so a change made entirely of new files used
 * to be judged as "No git changes detected" — a gate would confidently pass criteria
 * it never saw evidence for. Include untracked paths and their contents.
 */
export function collectGitEvidence(cwd = process.cwd()): GateEvidence {
  const run = (args: string[]): string => {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(result.error?.message ?? result.stderr?.trim() ?? "Git evidence collection failed");
    }
    return result.stdout ?? "";
  };

  let hasHead = true;
  try {
    run(["rev-parse", "--verify", "HEAD"]);
  } catch {
    // An initial repository has no HEAD yet, but staged files are still evidence.
    hasHead = false;
  }
  const tracked = run(hasHead ? ["diff", "HEAD"] : ["diff", "--cached"]).trim();
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);

  const sections: string[] = [];
  let truncated = false;
  if (tracked) sections.push(tracked);

  if (untracked.length > 0) {
    sections.push(`Untracked files (git diff omits these):\n${untracked.map((f) => `- ${f}`).join("\n")}`);
    for (const file of untracked) {
      try {
        const content = fs.readFileSync(path.resolve(cwd, file), "utf8");
        const capped = capGateState(content, MAX_UNTRACKED_FILE_CHARS);
        truncated ||= capped.truncated;
        sections.push(
          `--- untracked: ${file} ---\n${capped.text}`
        );
      } catch {
        truncated = true;
        sections.push(`--- untracked: ${file} ---\n[omitted: file could not be read]`);
      }
    }
  }

  return { text: sections.length > 0 ? sections.join("\n\n") : "No git changes detected.", truncated };
}

/** Text-only compatibility wrapper; evaluation uses the accompanying completeness flag. */
export function collectGitState(cwd = process.cwd()): string {
  return collectGitEvidence(cwd).text;
}

/** Cut gate evidence to fit the window, marking the cut so the judge can see it. */
export function capGateState(
  text: string,
  maxChars = MAX_GATE_STATE_CHARS
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const dropped = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n…[truncated ${dropped} chars: the evidence below the cut was not shown]`,
    truncated: true,
  };
}

export function resolveGateEvidence(options: GateOptions): GateEvidence {
  if (options.state !== undefined) {
    return { text: typeof options.state === "string" ? options.state : JSON.stringify(options.state, null, 2), truncated: false };
  }

  if (options.diff) {
    return collectGitEvidence();
  }

  if (options.file) {
    try {
      return { text: fs.readFileSync(options.file, "utf8"), truncated: false };
    } catch (e: any) {
      throw new Error(`Failed to read file ${options.file}: ${e.message}`);
    }
  }

  // Read from stdin if available and not TTY
  if (!process.stdin.isTTY) {
    try {
      return { text: fs.readFileSync(0, "utf8"), truncated: false };
    } catch {
      // Ignore read error
    }
  }

  return { text: "No state provided.", truncated: false };
}

export function resolveGateState(options: GateOptions): string {
  return resolveGateEvidence(options).text;
}

export async function evaluateGate(options: GateOptions, jevClient?: JevClient): Promise<GateResult> {
  const client = jevClient ?? new JevClient();
  const threshold = options.threshold ?? 0.7;

  if (!options.criteria.trim()) {
    throw new Error("Missing criteria for gate check. Provide --criteria <text>.");
  }

  if (!client.isConfigured()) {
    if (options.failOpen) {
      // Passing without an evaluation is a policy decision, not a model judgment:
      // report `evaluated: false` and a null probability rather than a false 1.0.
      return {
        passed: true,
        evaluated: false,
        probability: null,
        criteria: options.criteria,
        threshold,
        elapsedMs: 0,
        truncated: false,
        error: "Jev unconfigured (fail-open enabled)",
      };
    }
    throw new Error(describeUnconfigured());
  }

  const evidence = resolveGateEvidence(options);
  const gateCap = capGateState(evidence.text);
  // Apply the client's caps before constructing the completeness flag. Otherwise
  // its per-field limit can cut `output` after the gate has claimed it is complete.
  const capped = capState({ output: gateCap.text, criteria: options.criteria, truncated: false });
  const truncated = evidence.truncated || gateCap.truncated || capped.truncatedChars > 0 || capped.truncatedItems > 0;
  const state = { ...(capped.value as Record<string, unknown>), truncated };

  const response = await client.evaluate({
    state,
    model: options.model,
    questions: {
      gate_passed: {
        type: "noul",
        instructions: {
          question: "Does `output` satisfy `criteria`?",
          note: "Judge the output as given against the stated criteria only; do not infer requirements the criteria do not state. When `truncated` is true the output is incomplete, so answer no if the criteria depend on content that may have been cut.",
        },
        criteria: {
          true: { what: `The output satisfies: ${options.criteria}` },
          false: { what: `The output does not satisfy: ${options.criteria}` },
        },
      },
    },
  });

  const answer = response.answers["gate_passed"];
  const probability = typeof answer?.value === "number" ? answer.value : Number(answer?.value ?? 0);
  const passed = probability >= threshold;

  return {
    passed,
    evaluated: true,
    probability,
    confidence: answer?.confidence,
    criteria: options.criteria,
    threshold,
    truncated,
    elapsedMs: response.elapsedMs,
    answer,
  };
}
