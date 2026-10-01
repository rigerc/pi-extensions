/**
 * Telling the model where this project's MCP servers live.
 *
 * The `session_start` notifications and the `/mcp-json` report reach the user, not the model. An
 * agent asked to add an MCP server therefore reads only pi's own documentation and reaches for
 * `pi mcp add` or `.pi/mcp.json`, both of which take precedence over `.mcp.json` and put the server
 * in the wrong scope. A short system prompt section is the fix, and it is the same mechanism the
 * built-in MCP extension uses for its `mcp_servers` section.
 *
 * The text is injected whenever the extension is loaded, including in a project that has no
 * `.mcp.json` yet: that is exactly the case where an agent would otherwise create the wrong file.
 * Pi diffs prompt sections per prompt, so an unchanged section is not re-sent.
 */
import { DOT_MCP_FILE } from './config.js';

/** System prompt section name. Must match `/^[a-z][a-z0-9_-]*$/`, or pi rejects the prompt. */
export const DOT_MCP_SECTION = 'dot_mcp_json';

/** Names listed before they collapse into a count, so a large file cannot flood the prompt. */
const MAX_LISTED_NAMES = 8;

/** What the section needs to know about the current session. */
export interface DotMcpPromptState {
  /** Absolute path the file is read from, which is the session directory. */
  path: string;
  /** Whether that file exists. */
  found: boolean;
  /** Whether `session_start` has run, so `trusted` and `registered` describe this session. */
  started: boolean;
  /** Whether the session may load project configuration. */
  trusted: boolean;
  /** Servers registered from the file in the last session start, in file order. */
  registered: readonly string[];
}

/**
 * The section body: where the servers are, how to change them, and what not to use instead. Kept
 * to a single paragraph so it reads as one instruction rather than a document.
 */
export function renderDotMcpSection(state: DotMcpPromptState): string {
  const file = state.path || DOT_MCP_FILE;
  const parts = [
    `MCP servers for this project are configured in ${file}, in the \`mcpServers\` shape, and registered by the pi-mcp-dot-json extension.`,
    'To add, change, or remove a server, edit that file.',
    'Do not run `pi mcp add` and do not write `.pi/mcp.json`: both take precedence over it, so the server would end up in the wrong scope.',
  ];
  if (state.found) {
    parts.push(
      'Give a new entry a one-line `description` so other agents know when to reach for it.',
      `Defined now: ${summarizeNames(state.registered)}.`,
    );
  } else {
    parts.push(
      `It does not exist yet: create ${file} with a \`mcpServers\` object when this project needs a server.`,
    );
  }
  parts.push('Changes apply after `/reload` or in the next session.');
  if (state.started && !state.trusted) {
    parts.push(
      `This project is not trusted, so ${file} is not read yet: no server from it connects until project trust is granted and pi restarts.`,
    );
  }
  return parts.join(' ');
}

/** `a, b, c`, `none`, or `a, b, c and 4 more`. */
function summarizeNames(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  if (names.length <= MAX_LISTED_NAMES) return names.join(', ');
  return `${names.slice(0, MAX_LISTED_NAMES).join(', ')} and ${names.length - MAX_LISTED_NAMES} more`;
}