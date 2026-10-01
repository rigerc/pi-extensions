/**
 * Registering the servers of a `.mcp.json` for the session.
 *
 * `pi.registerMcpServer()` is the whole integration: the built-in MCP support connects registered
 * servers next to the ones from `mcp.json`, `/mcp` lists them with this extension as their source,
 * and a name defined in `mcp.json` still wins. Registrations last for the session, so nothing is
 * written to disk and `/mcp` changes to these servers apply to the session only.
 */
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { DotMcpServer } from './config.js';

/** The part of `ExtensionAPI` used here, so tests can pass a recorder instead of pi. */
export interface McpRegistrar {
  registerMcpServer(name: string, config: McpServerConfig): void;
  unregisterMcpServer(name: string): void;
}

export interface SyncOutcome {
  /** Names registered by this call. */
  registered: string[];
  /** Names unregistered by this call, because the file no longer defines them. */
  removed: string[];
  /** One line per entry pi refused, phrased for the user. */
  errors: string[];
}

/** `Invalid MCP server registered by extension "<path>": <reason>` without the wrapper. */
const REGISTER_ERROR_PREFIX = /^Invalid MCP server registered by extension "[^"]*": /;

/**
 * Make the registered servers match the file: drop names it no longer defines, then register the
 * rest in file order. A refused entry is reported and the remaining entries still register.
 */
export function syncDotMcpServers(
  pi: McpRegistrar,
  servers: readonly DotMcpServer[],
  previouslyRegistered: Iterable<string>,
): SyncOutcome {
  const outcome: SyncOutcome = { registered: [], removed: [], errors: [] };
  const wanted = new Set(servers.map((server) => server.name));

  for (const name of previouslyRegistered) {
    if (wanted.has(name)) continue;
    try {
      pi.unregisterMcpServer(name);
      outcome.removed.push(name);
    } catch (error) {
      outcome.errors.push(describeError(name, error));
    }
  }

  for (const server of servers) {
    try {
      pi.registerMcpServer(server.name, server.config);
      outcome.registered.push(server.name);
    } catch (error) {
      outcome.errors.push(describeError(server.name, error));
    }
  }

  return outcome;
}

function describeError(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `server "${name}": ${message.replace(REGISTER_ERROR_PREFIX, '')}`;
}
