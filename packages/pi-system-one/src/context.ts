/**
 * Conversation context shared with System One routing questions.
 *
 * Routers judge one prompt at a time, but follow-ups ("do the same for the tool
 * guard", "yes, go ahead") carry almost no signal on their own: the lexical shortlist
 * and the model both miss what the previous turn established. Sending the tail of the
 * last assistant message gives the judgment the minimum context needed to interpret
 * an abbreviated task, and it is hard-capped so a long final answer cannot crowd the
 * candidate list out of the backend's bounded context window.
 */

/** Tail length of the previous assistant message, shared by every routing path. */
export const RECENT_CONTEXT_CHARS = 1500;

interface BranchEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

interface BranchReader {
  getBranch?(): readonly unknown[];
}

export interface AssistantToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Tail of the last assistant text in the session branch, or "" when there is none. */
export function lastAssistantText(sessionManager?: BranchReader | null): string {
  let branch: readonly unknown[] = [];
  try {
    branch = sessionManager?.getBranch?.() ?? [];
  } catch {
    return '';
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as BranchEntry | undefined;
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;

    const text = content
      .filter((part): part is { type: string; text: string } => {
        const candidate = part as { type?: unknown; text?: unknown } | null;
        return candidate?.type === 'text' && typeof candidate.text === 'string';
      })
      .map((part) => part.text)
      .join('\n')
      .trim();

    if (text) return text.slice(-RECENT_CONTEXT_CHARS);
  }
  return '';
}

/** Read the tail from an extension context without ever throwing. */
export function recentContextFrom(ctx?: unknown): string {
  try {
    const sessionManager = (ctx as { sessionManager?: BranchReader } | undefined)?.sessionManager;
    return lastAssistantText(sessionManager);
  } catch {
    return '';
  }
}

/**
 * Tool calls from the most recent assistant message. Pi preflights sibling tool calls
 * from one assistant message before executing any of them, so a `write` in the same
 * batch has not happened yet when another call is checked.
 */
export function lastAssistantToolCalls(sessionManager?: BranchReader | null): AssistantToolCall[] {
  let branch: readonly unknown[] = [];
  try {
    branch = sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as BranchEntry | undefined;
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) return [];

    return content
      .filter((part): part is AssistantToolCall & { type: string } => {
        const candidate = part as (Partial<AssistantToolCall> & { type?: unknown }) | null;
        return (
          candidate?.type === 'toolCall' &&
          typeof candidate.name === 'string' &&
          typeof candidate.arguments === 'object' &&
          candidate.arguments !== null
        );
      })
      .map((part) => ({ name: part.name, arguments: part.arguments }));
  }
  return [];
}
