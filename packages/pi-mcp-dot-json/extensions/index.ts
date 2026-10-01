/**
 * Use a project's `.mcp.json` as an MCP source in pi.
 *
 * Pi reads `~/.pi/agent/mcp.json` and, in a trusted project, `.pi/mcp.json`. Repositories written
 * for other MCP clients keep their servers in `.mcp.json` instead, where pi does not look. This
 * extension reads that file from the session directory and registers each server with
 * `pi.registerMcpServer()`, which the built-in MCP support connects, lists in `/mcp`, and keeps for
 * the session. The built-in MCP support, `mcp.json`, `/mcp`, and codemode all keep working: an
 * entry whose name `mcp.json` also defines is won by `mcp.json`.
 *
 * Registrations need the session directory and the trust decision, both only known once a session
 * starts, so the file is read from `session_start` rather than from the factory.
 *
 * The notifications below reach the user, not the model, so this extension also states in the
 * system prompt that the project's MCP servers live in `.mcp.json`. Without it, an agent asked to
 * add a server follows pi's own documentation and writes `.pi/mcp.json` or runs `pi mcp add`,
 * both of which win over this file.
 */
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DOT_MCP_FILE, loadDotMcpServers } from '../src/config.js';
import { DOT_MCP_SECTION, renderDotMcpSection } from '../src/prompt.js';
import { syncDotMcpServers, type SyncOutcome } from '../src/register.js';

/** Names listed in a message before it collapses into a count. */
const MAX_LISTED_NAMES = 8;

interface DotMcpState {
  /** Absolute path the file is read from, which is the session directory. */
  path: string;
  /** Whether that file exists. */
  found: boolean;
  /** Whether a session start has filled in the fields below. */
  started: boolean;
  /** Whether the session may load project configuration. */
  trusted: boolean;
  /** Servers registered from the file in the last session start. */
  registered: string[];
  errors: string[];
  notes: string[];
}

export default function (pi: ExtensionAPI) {
  /** Names this extension has registered, so a later session start can drop what a file dropped. */
  let registeredNames: string[] = [];
  let state: DotMcpState = {
    path: '',
    found: false,
    started: false,
    trusted: false,
    registered: [],
    errors: [],
    notes: [],
  };
  /** Last message shown, so a resume that changes nothing stays quiet. */
  let lastMessage: string | undefined;

  function notifyOnce(ctx: ExtensionContext, message: string): void {
    if (message === lastMessage) return;
    lastMessage = message;
    ctx.ui.notify(message, 'info');
  }

  pi.on('session_start', async (_event, ctx) => {
    const path = join(ctx.cwd, DOT_MCP_FILE);
    const trusted = ctx.isProjectTrusted();
    const loaded = trusted
      ? loadDotMcpServers(path)
      : { found: false, servers: [], errors: [], notes: [] as string[] };

    // Servers registered by this extension are replaced, so an edited or removed entry does not
    // outlive the session that read it.
    const outcome: SyncOutcome = syncDotMcpServers(pi, loaded.servers, registeredNames);
    registeredNames = loaded.servers.map((server) => server.name);

    state = {
      path,
      found: loaded.found,
      started: true,
      trusted,
      registered: outcome.registered,
      errors: [...loaded.errors, ...outcome.errors],
      notes: loaded.notes,
    };

    if (!trusted) {
      notifyOnce(ctx, `${DOT_MCP_FILE} ignored: this project is not trusted.`);
      return;
    }
    if (outcome.registered.length === 0 && state.errors.length === 0 && state.notes.length === 0) {
      return;
    }
    const lines: string[] = [];
    if (outcome.registered.length > 0) {
      lines.push(`${DOT_MCP_FILE}: registered ${summarizeNames(outcome.registered)}.`);
    }
    for (const note of state.notes) lines.push(note);
    for (const error of state.errors) lines.push(`${DOT_MCP_FILE}: ${error}`);
    notifyOnce(ctx, lines.join(' '));
  });

  // Recomputed per prompt, so an entry added to the file reaches the model once the session reloads.
  pi.on('before_agent_start', async (event, ctx) => {
    event.systemPromptOptions.sections[DOT_MCP_SECTION] = renderDotMcpSection({
      path: state.path || join(ctx.cwd, DOT_MCP_FILE),
      found: state.found,
      started: state.started,
      trusted: state.trusted,
      registered: state.registered,
    });
  });

  pi.registerCommand('mcp-json', {
    description: `Show the MCP servers this session took from ${DOT_MCP_FILE}`,
    handler: async (_args, ctx) => {
      ctx.ui.notify(report(state), state.errors.length > 0 ? 'warning' : 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    // Registrations belong to the runtime that made them and are dropped with it; unregistering
    // here would only disconnect servers the process is about to release anyway.
    registeredNames = [];
    lastMessage = undefined;
  });
}

/** `a, b, c` or `a, b, c and 4 more`, so a large file cannot flood the footer. */
function summarizeNames(names: readonly string[]): string {
  if (names.length <= MAX_LISTED_NAMES) return names.join(', ');
  const remaining = names.length - MAX_LISTED_NAMES;
  return `${names.slice(0, MAX_LISTED_NAMES).join(', ')} and ${remaining} more`;
}

function report(state: DotMcpState): string {
  const lines = [
    `${DOT_MCP_FILE}: ${state.path || 'session directory'}${state.found ? '' : ' (not found)'}.`,
  ];
  if (!state.trusted) {
    lines.push(
      'This project is not trusted, so its file is not read. Grant project trust and restart.',
    );
    return lines.join('\n');
  }
  lines.push(
    `Servers: ${state.registered.length > 0 ? summarizeNames(state.registered) : 'none'}.`,
  );
  for (const note of state.notes) lines.push(`Note: ${note}`);
  for (const error of state.errors) lines.push(`Error: ${error}`);
  return lines.join('\n');
}
