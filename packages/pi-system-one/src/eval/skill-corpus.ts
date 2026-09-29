/**
 * Read a skill corpus off disk for offline evaluation.
 *
 * A skill's `name` and `description` in its SKILL.md frontmatter are the only text routing
 * ever sees, so they are the only text the evaluation scores. Parsing is deliberately
 * narrow — two keys out of a much larger format — rather than a general YAML reader, and it
 * is written to degrade to an empty description rather than to throw on a file it does not
 * understand.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CorpusSkill {
  /** Bare skill name, which is also its id: routing keys capabilities by name. */
  id: string;
  name: string;
  description: string;
  /** Path the entry came from, for inspecting a surprising result. */
  source: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

const KEY_VALUE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
/** YAML block scalar headers whose content arrives on the following indented lines. */
const BLOCK_SCALAR = /^[|>][+-]?$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && last === first) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract `name` and `description` from a leading `---` frontmatter block.
 *
 * Handles the three shapes that actually occur: a plain scalar, a quoted scalar, and a
 * folded or literal block (`>` / `|`) whose continuation lines are indented. A folded block
 * is joined with spaces because retrieval tokenises on whitespace-word boundaries anyway,
 * so line breaks carry no signal.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  // Normalise line endings first. A CR before the newline breaks every `$`-anchored match
  // below (`.` does not match `\r`), which silently drops whole files — plugin skills authored
  // on Windows are CRLF, and a skill with no parsed name is invisible to routing.
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return {};

  const blockStart = text.indexOf('\n');
  if (blockStart === -1) return {};
  const blockEnd = text.indexOf('\n---', blockStart);
  if (blockEnd === -1) return {};

  const lines = text.slice(blockStart + 1, blockEnd).split('\n');
  const fields: Record<string, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s/.test(line)) continue;

    const match = KEY_VALUE.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = (match[2] ?? '').trim();
    if (key === undefined) continue;

    if (BLOCK_SCALAR.test(rawValue)) {
      const collected: string[] = [];
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1] ?? '')) {
        i += 1;
        collected.push((lines[i] ?? '').trim());
      }
      fields[key] = collected.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }

    fields[key] = unquote(rawValue);
  }

  return { name: fields.name, description: fields.description };
}

/** Recursively collect every `SKILL.md` under `root`. Missing roots are ignored. */
function findSkillFiles(root: string, depth = 0): string[] {
  if (depth > 12) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSkillFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      files.push(full);
    }
  }
  return files;
}

/**
 * Build a corpus from one or more roots.
 *
 * Deduplicated by name, first occurrence wins, because that is what the routers do: Pi
 * exposes skills through a name-keyed map, so two copies of one skill are one candidate to
 * routing and must be one candidate here, or the evaluation would be scoring a corpus
 * larger than the one the router ever sees. Entries with no usable name are dropped.
 */
export function discoverSkills(roots: readonly string[]): CorpusSkill[] {
  const byName = new Map<string, CorpusSkill>();

  for (const root of roots) {
    for (const file of findSkillFiles(root)) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(content);
      const name = frontmatter.name?.trim();
      if (!name || byName.has(name)) continue;

      byName.set(name, {
        id: name,
        name,
        description: frontmatter.description?.trim() ?? '',
        source: file,
      });
    }
  }

  return [...byName.values()];
}
