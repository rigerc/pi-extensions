import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { isJevTool } from "./types.js";
import { lastAssistantToolCalls } from "./context.js";

/** Blocking cutoff for the anti-hallucination Noul. High because blocking a call is destructive. */
export const HALLUCINATION_THRESHOLD = 0.85;

/**
 * Tools whose path arguments must already exist. `write` is deliberately absent:
 * creating a file at a new path is valid, so a missing path there is not evidence of
 * anything. Existence for the rest is a filesystem question with a correct answer, so
 * it is checked directly instead of being asked of a model that cannot see the disk.
 */
export const EXISTING_PATH_TOOLS: readonly string[] = ["read", "edit", "grep", "find", "ls"];

/** Argument keys that hold a path across the built-in tools. */
export const PATH_KEYS: readonly string[] = [
  "path",
  "paths",
  "file_path",
  "filePath",
  "file",
  "files",
  "dir",
  "directory",
  "cwd",
  "root",
];

export interface ToolCallCheckResult {
  valid: boolean;
  blocked?: boolean;
  reason?: string;
  probability?: number;
  /** Which check produced the verdict, for diagnostics. */
  source?: "path-check" | "jev";
  elapsedMs: number;
}

/** Patterns, URLs, home-relative paths, and flag-like values are not ours to resolve. */
function isCheckablePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return false;
  if (/[*?[\]{}]/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (trimmed.startsWith("~") || trimmed.startsWith("-")) return false;
  return true;
}

/** Collect path-valued arguments, bounded in depth so a hostile input cannot loop. */
export function collectPathValues(input: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || input === null || typeof input !== "object") return out;

  if (Array.isArray(input)) {
    for (const item of input) collectPathValues(item, out, depth + 1);
    return out;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && PATH_KEYS.includes(key)) out.push(value);
    else if (value !== null && typeof value === "object") collectPathValues(value, out, depth + 1);
  }
  return out;
}

/** Path arguments that do not exist on disk. Empty when the tool is not checkable this way. */
export function findMissingPaths(toolName: string, input: unknown, cwd: string): string[] {
  if (!EXISTING_PATH_TOOLS.includes(toolName)) return [];

  const missing = new Set<string>();
  for (const value of collectPathValues(input)) {
    if (!isCheckablePath(value)) continue;
    if (!fs.existsSync(path.resolve(cwd, value))) missing.add(value);
  }
  return [...missing];
}

export class ToolGuard {
  public enabled: boolean;

  constructor(
    private pi: ExtensionAPI,
    private jevClient: JevClient,
    enabled = false
  ) {
    this.enabled = enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public install(): void {
    this.pi.on("tool_call", async (event, ctx) => {
      if (!this.enabled) return;
      if (isJevTool(event.toolName)) return;

      // The deterministic path check runs with or without Jev: it costs nothing and
      // already covers the most common hallucination, a path that is simply not there.
      const check = await this.checkToolCall(event.toolName, event.input, ctx, ctx.signal);
      if (check.blocked) {
        ctx.ui.setStatus("jev", `jev: blocked hallucinated ${event.toolName}`);
        return {
          block: true,
          reason: check.reason ?? "Blocked by Jev tool-guard: hallucinated or invalid tool arguments detected.",
        };
      }
    });

    this.pi.on("tool_result", async (event, ctx) => {
      if (!this.enabled || !this.jevClient.isConfigured()) return;
      if (isJevTool(event.toolName)) return;
      if (!event.isError) return;

      const enhancement = await this.enhanceErrorResult(
        event.toolName,
        event.input,
        event.content,
        ctx,
        ctx.signal
      );
      if (enhancement) {
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n[Jev Anti-Hallucination Guidance]: ${enhancement}` },
          ],
        };
      }
    });
  }

  /** The tool's own contract, so argument shape can be judged against it rather than guessed. */
  private describeTool(toolName: string): { description?: string; parameters?: unknown } | null {
    try {
      const tools = (this.pi as { getAllTools?(): unknown[] }).getAllTools?.() ?? [];
      const found = tools.find((tool) => (tool as { name?: string }).name === toolName) as
        | { description?: string; parameters?: unknown }
        | undefined;
      return found ? { description: found.description, parameters: found.parameters } : null;
    } catch {
      return null;
    }
  }

  /** Paths a `write`/`edit` in the same assistant batch is about to create. */
  private pathsCreatedInThisBatch(ctx: ExtensionContext | undefined, cwd: string): Set<string> {
    const claimed = new Set<string>();
    try {
      const sessionManager = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as
        | Parameters<typeof lastAssistantToolCalls>[0]
        | undefined;
      for (const call of lastAssistantToolCalls(sessionManager)) {
        if (call.name !== "write" && call.name !== "edit") continue;
        for (const value of collectPathValues(call.arguments)) {
          if (isCheckablePath(value)) claimed.add(path.resolve(cwd, value));
        }
      }
    } catch {
      // Sibling detection is an optimization; a failure just means the check stands.
    }
    return claimed;
  }

  public async checkToolCall(
    toolName: string,
    input: unknown,
    ctx?: ExtensionContext,
    signal?: AbortSignal
  ): Promise<ToolCallCheckResult> {
    const startTime = Date.now();
    if (!this.enabled || isJevTool(toolName)) {
      return { valid: true, elapsedMs: 0 };
    }

    // 1. Deterministic: does every path argument exist? A sibling `write` in the same
    // assistant batch has not executed yet, so a path it is about to create counts.
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const claimed = this.pathsCreatedInThisBatch(ctx, cwd);
    const missing = findMissingPaths(toolName, input, cwd).filter(
      (candidate) => !claimed.has(path.resolve(cwd, candidate))
    );
    if (missing.length > 0) {
      return {
        valid: false,
        blocked: true,
        source: "path-check",
        probability: 1,
        reason: `Jev tool-guard blocked ${toolName}: ${missing
          .map((p) => `"${p}"`)
          .join(", ")} ${missing.length > 1 ? "do not exist" : "does not exist"} in ${cwd}. Verify with ls/find before guessing paths.`,
        elapsedMs: Date.now() - startTime,
      };
    }

    // 2. Model judgment, only for what the filesystem cannot answer.
    if (!this.jevClient.isConfigured()) {
      return { valid: true, elapsedMs: Date.now() - startTime };
    }

    try {
      const tool = this.describeTool(toolName);
      const response = await this.jevClient.evaluate(
        {
          state: {
            tool: toolName,
            description: tool?.description,
            parameters: input,
            schema: tool?.parameters,
          },
          questions: {
            invalid_parameters: {
              type: "noul",
              instructions: {
                question: "Are the arguments in `parameters` nonsensical, malformed, or fabricated for `tool`?",
                inspect: "`parameters`",
                note: "Judge the arguments against `schema` and `description`, the tool's actual contract. Answer no when the values are well-formed for this tool, even if unusual.",
              },
              criteria: {
                true: {
                  what: "Argument names, types, or values cannot be valid for this tool",
                  examples: ["A numeric limit passed as an object"],
                },
                false: {
                  what: "Arguments are well-formed for this tool",
                  examples: ['{ "command": "ls -la" }'],
                },
              },
            },
          },
        },
        signal
      );

      const prob = Number(response.answers["invalid_parameters"]?.value ?? 0);
      const isHallucinated = prob >= HALLUCINATION_THRESHOLD;

      return {
        valid: !isHallucinated,
        blocked: isHallucinated,
        source: "jev",
        reason: isHallucinated
          ? `Jev tool-guard detected hallucinated parameters in ${toolName} call (P=${prob.toFixed(2)}). Check arguments against the tool schema.`
          : undefined,
        probability: prob,
        elapsedMs: Date.now() - startTime,
      };
    } catch {
      // Fail open on evaluation error
      return { valid: true, elapsedMs: Date.now() - startTime };
    }
  }

  public async enhanceErrorResult(
    toolName: string,
    input: unknown,
    content: unknown[],
    ctx?: ExtensionContext,
    signal?: AbortSignal
  ): Promise<string | null> {
    if (!this.enabled || !this.jevClient.isConfigured()) return null;

    try {
      const errorText = JSON.stringify(content);
      const response = await this.jevClient.evaluate(
        {
          state: {
            tool: toolName,
            input,
            cwd: (ctx as { cwd?: string } | undefined)?.cwd,
            error: errorText,
          },
          questions: {
            error_category: {
              type: "choice",
              instructions: "What is the primary root cause of this tool execution failure?",
              criteria: {
                missing_file: "File or directory path does not exist (potential hallucinated path)",
                syntax_flag: "Invalid command syntax, unknown flags, or bad parameter structure",
                permission_env: "Permission denied or missing environment dependency",
                runtime_other: "Expected runtime logic failure or test failure",
                other: "None of the above categories fits this failure",
              },
            },
          },
        },
        signal
      );

      const cause = String(response.answers["error_category"]?.value ?? "");
      if (cause === "missing_file") {
        return "Path not found. Verify actual workspace files with ls/find before guessing paths.";
      }
      if (cause === "syntax_flag") {
        return "Invalid syntax or flag options. Check command/tool specification before retrying.";
      }
      return null;
    } catch {
      return null;
    }
  }
}
