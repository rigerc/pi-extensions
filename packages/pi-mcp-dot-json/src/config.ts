/**
 * Reading a project `.mcp.json`.
 *
 * The file uses the `mcpServers` shape that pi's own `mcp.json` uses, so entries can be copied
 * over from Claude Desktop, Claude Code, or Cursor. Entry validation itself belongs to pi:
 * `pi.registerMcpServer()` rejects an invalid entry with a message meant for the user, so this
 * module only checks what pi cannot know on its own.
 *
 * What is checked here:
 * - the file is JSON with an `mcpServers` object;
 * - the server name is usable as a tool namespace;
 * - `auth` is rejected, because this is a project file and a repository must not choose which
 *   stored credential is sent to a server.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';

/** File this extension reads from the session directory. */
export const DOT_MCP_FILE = '.mcp.json';

/** Top-level key pi's `mcp.json` uses, and the only one this extension reads. */
const SERVERS_KEY = 'mcpServers';

/** Names that differ only in `-` and `_` share a namespace, so only one shape is accepted. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export interface DotMcpServer {
  name: string;
  /**
   * The entry as written in the file. Pi validates it again in `registerMcpServer()`, so this is
   * only known to be shaped like an `mcpServers` entry, not known to be valid.
   */
  config: McpServerConfig;
}

export interface DotMcpParseResult {
  /** Whether the file exists. */
  found: boolean;
  /** Entries worth passing to `pi.registerMcpServer()`, in file order. */
  servers: DotMcpServer[];
  /** Problems found in the file, one per line, phrased for the user. */
  errors: string[];
  /** Non-fatal remarks, such as a pi setting that this file cannot configure. */
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the contents of a `.mcp.json`. A file without an `mcpServers` object defines no servers
 * and is not an error, which matches how pi reads its own config files.
 */
export function parseDotMcpJson(text: string, path: string): DotMcpParseResult {
  const errors: string[] = [];
  const notes: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      found: true,
      servers: [],
      errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`],
      notes,
    };
  }

  if (!isRecord(parsed)) {
    return {
      found: true,
      servers: [],
      errors: [`${path}: expected an object with a "${SERVERS_KEY}" object`],
      notes,
    };
  }

  const raw = parsed[SERVERS_KEY];
  if (raw === undefined) {
    // A project file may hold other MCP client settings; only the server list is ours.
    return { found: true, servers: [], errors, notes };
  }
  if (!isRecord(raw)) {
    return {
      found: true,
      servers: [],
      errors: [`${path}: expected an object with a "${SERVERS_KEY}" object`],
      notes,
    };
  }

  if (parsed.autoEnableCodemode !== undefined) {
    notes.push(
      `${path}: autoEnableCodemode is ignored here; set it beside "mcpServers" in .pi/mcp.json`,
    );
  }

  const servers: DotMcpServer[] = [];
  const namespaces = new Map<string, string>();
  for (const [name, config] of Object.entries(raw)) {
    if (!SERVER_NAME.test(name)) {
      errors.push(`${path}: invalid server name "${name}" (use letters, digits, "_" and "-")`);
      continue;
    }
    if (!isRecord(config)) {
      errors.push(`${path}: server "${name}" must be an object`);
      continue;
    }
    if (config.auth !== undefined) {
      errors.push(
        `${path}: server "${name}": auth is only allowed in ~/.pi/agent/mcp.json, ` +
          'because a repository must not choose which credential is sent',
      );
      continue;
    }
    const namespace = name.replace(/-/g, '_');
    const clash = namespaces.get(namespace);
    if (clash !== undefined) {
      errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
      continue;
    }
    namespaces.set(namespace, name);
    // pi re-validates the entry in registerMcpServer() and reports anything wrong with it.
    servers.push({ name, config: config as unknown as McpServerConfig });
  }

  return { found: true, servers, errors, notes };
}

/** Read and parse a `.mcp.json`. A missing file defines no servers and is not an error. */
export function loadDotMcpServers(path: string): DotMcpParseResult {
  if (!existsSync(path)) {
    return { found: false, servers: [], errors: [], notes: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      found: true,
      servers: [],
      errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`],
      notes: [],
    };
  }
  return parseDotMcpJson(text, path);
}
