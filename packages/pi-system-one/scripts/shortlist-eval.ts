#!/usr/bin/env node
/**
 * Offline shortlist evaluation over a real, installed skill corpus.
 *
 *   npm run eval:shortlist
 *   npm run eval:shortlist -- --corpus ~/.agents/skills --limit 8
 *
 * No API key, no network, no model call. The shortlist is built locally, so its quality can
 * be measured exhaustively and cheaply — which matters because the shortlist is the recall
 * ceiling for everything above it.
 *
 * Two things this deliberately reports rather than hides:
 *   - the corpus is whatever is installed on this machine, so the numbers are local and not
 *     comparable across machines unless the same roots are used;
 *   - the prompts come from a small set of author-written fixtures, so this is a development
 *     set. It shows direction. It is not a held-out measurement, and it should not be quoted
 *     as one.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  bm25Ranker,
  evaluateShortlist,
  formatMetrics,
  substringRanker,
  type EvalQuery,
  type ShortlistMetrics,
} from '../src/eval/shortlist-metrics.js';
import { discoverSkills } from '../src/eval/skill-corpus.js';

interface Options {
  corpora: string[];
  queriesPath: string;
  limit: number;
  top: number;
}

/** Where skills are installed for a user, independent of which project is open. */
const HOME_CORPORA = [
  path.join(os.homedir(), '.codex', '.tmp', 'plugins', 'plugins'),
  path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules'),
  path.join(os.homedir(), '.pi', 'agent', 'extensions'),
  path.join(os.homedir(), '.agents', 'skills'),
];

/** Directories that hold project-scoped skills, relative to a project root. */
const PROJECT_CORPORA = ['.agents/skills', '.pi/npm/node_modules'];

/**
 * Project skill roots, found by walking up from the working directory.
 *
 * Not derived from a fixed path: the script usually runs from the package directory (npm sets
 * cwd there), which is two levels below the repository root that actually holds `.agents/skills`.
 * A cwd-relative guess silently missed every project skill — including the ones this package
 * exists to route.
 */
function projectCorpora(startDir: string): string[] {
  const roots: string[] = [];
  let current = startDir;

  for (let depth = 0; depth < 4; depth += 1) {
    for (const relative of PROJECT_CORPORA) {
      const candidate = path.join(current, relative);
      if (fs.existsSync(candidate)) roots.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

/** Repository-relative path, so the default query fixture works from the package root. */
const DEFAULT_QUERIES = path.join(process.cwd(), 'bench', 'shortlist-queries.json');

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { corpora: [], queriesPath: DEFAULT_QUERIES, limit: 12, top: 5 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--corpus' || arg === '-c') && next !== undefined) {
      options.corpora.push(next);
      i += 1;
    } else if ((arg === '--queries' || arg === '-q') && next !== undefined) {
      options.queriesPath = next;
      i += 1;
    } else if ((arg === '--limit' || arg === '-k') && next !== undefined) {
      options.limit = Number(next);
      i += 1;
    } else if (arg === '--top' && next !== undefined) {
      options.top = Number(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(readUsage());
      process.exit(0);
    }
  }

  return options;
}

function readUsage(): string {
  return [
    'Usage: npm run eval:shortlist -- [options]',
    '',
    '  -c, --corpus <dir>   Skill root to scan. Repeatable. Defaults to common installs.',
    '  -q, --queries <file> Query fixture JSON. Defaults to bench/shortlist-queries.json.',
    '  -k, --limit <n>      Shortlist size K. Default 12 (SKILL_CANDIDATE_LIMIT).',
    '      --top <n>        How many best/worst rank changes to print. Default 5.',
  ].join('\n');
}

function readQueries(file: string): EvalQuery[] {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);

  return parsed.map((entry, index) => {
    const query = entry as Partial<EvalQuery>;
    if (typeof query.prompt !== 'string' || typeof query.target !== 'string') {
      throw new Error(`${file}: entry ${index} needs string "prompt" and "target"`);
    }
    return { prompt: query.prompt, target: query.target };
  });
}

/** Rank difference per query, most improved first (positive means BM25 moved it up). */
function rankChanges(
  before: ShortlistMetrics,
  after: ShortlistMetrics,
): Array<{ prompt: string; target: string; delta: number; before: number; after: number }> {
  const beforeByPrompt = new Map(before.ranks.map((entry) => [entry.prompt, entry.rank]));
  return after.ranks
    .map((entry) => {
      const previous = beforeByPrompt.get(entry.prompt) ?? entry.rank;
      return {
        prompt: entry.prompt,
        target: entry.target,
        delta: previous - entry.rank,
        before: previous,
        after: entry.rank,
      };
    })
    .filter((entry) => entry.delta !== 0);
}

function printRankChanges(label: string, changes: ReturnType<typeof rankChanges>, top: number): void {
  if (changes.length === 0) return;
  console.log(`\n  ${label}`);
  for (const change of changes.slice(0, top)) {
    const sign = change.delta > 0 ? '+' : '';
    console.log(
      `    ${sign}${change.delta}  rank ${change.before} -> ${change.after}  "${change.prompt}" -> ${change.target}`,
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const corpora =
    options.corpora.length > 0
      ? options.corpora
      : [...new Set([...HOME_CORPORA, ...projectCorpora(process.cwd())])];
  const queries = readQueries(options.queriesPath);

  const skills = discoverSkills(corpora);
  if (skills.length === 0) {
    console.error('No skills found. Pass --corpus <dir> pointing at a directory of SKILL.md files.');
    process.exit(1);
  }

  const candidates = skills.map((skill) => ({
    id: skill.id,
    text: `${skill.name} ${skill.description}`.trim(),
  }));
  const withoutDescription = skills.filter((skill) => skill.description.length === 0).length;

  console.log(`Corpus: ${candidates.length} skills from ${corpora.length} root(s)`);
  console.log(`Query fixtures: ${queries.length} (${options.queriesPath})`);
  console.log(`Shortlist size K: ${options.limit}`);
  if (withoutDescription > 0) {
    // A skill with no description can only be retrieved by its name, so this bounds the
    // achievable score and is worth seeing.
    console.log(`  note: ${withoutDescription} skill(s) have no description to match on`);
  }

  const before = evaluateShortlist(candidates, queries, substringRanker, options.limit);
  const after = evaluateShortlist(candidates, queries, bm25Ranker, options.limit);

  console.log('');
  console.log(formatMetrics('before', before, options.limit));
  console.log(formatMetrics('after', after, options.limit));

  const recallDelta = after.recallAtK - before.recallAtK;
  const mrrDelta = after.mrr - before.mrr;
  console.log(
    `\n  change: recall@${options.limit} ${recallDelta >= 0 ? '+' : ''}${(recallDelta * 100).toFixed(1)}pp, ` +
      `MRR ${mrrDelta >= 0 ? '+' : ''}${mrrDelta.toFixed(3)}`,
  );

  if (before.skipped > 0) {
    console.log(
      `\n  ${before.skipped} fixture(s) skipped: their target is not in this corpus. ` +
        'That is expected on a machine with a different set of skills installed.',
    );
  }

  const changes = rankChanges(before, after);
  printRankChanges(
    'largest improvements',
    [...changes].sort((a, b) => b.delta - a.delta),
    options.top,
  );
  printRankChanges(
    'largest regressions',
    [...changes].sort((a, b) => a.delta - b.delta),
    options.top,
  );
}

main();
