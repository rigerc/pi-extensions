import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFrontmatter } from '../src/eval/skill-corpus.js';

test('parseSkillFrontmatter reads plain scalars', () => {
  const parsed = parseSkillFrontmatter(
    ['---', 'name: test-driven-development', 'description: Write the failing test first', '---', '', '# Body'].join('\n'),
  );
  assert.deepEqual(parsed, {
    name: 'test-driven-development',
    description: 'Write the failing test first',
  });
});

test('parseSkillFrontmatter unquotes quoted scalars', () => {
  // Real skill files quote names that would otherwise be ambiguous YAML.
  assert.equal(parseSkillFrontmatter('---\nname: "sentry"\n---\n').name, 'sentry');
  assert.equal(parseSkillFrontmatter("---\nname: 'gh-fix-ci'\n---\n").name, 'gh-fix-ci');
});

test('parseSkillFrontmatter joins a folded block scalar', () => {
  const parsed = parseSkillFrontmatter(
    [
      '---',
      'name: typesafe-ai',
      'license: MIT',
      'description: >',
      '  Build AI-powered software with TypeSafe: small units',
      '  of AI intelligence you can use like programming primitives.',
      '  Use when a feature needs programmable common sense.',
      '---',
    ].join('\n'),
  );
  assert.equal(
    parsed.description,
    'Build AI-powered software with TypeSafe: small units of AI intelligence you can use like programming primitives. Use when a feature needs programmable common sense.',
  );
});

test('parseSkillFrontmatter joins a literal block scalar', () => {
  const parsed = parseSkillFrontmatter(
    ['---', 'name: x', 'description: |', '  first line', '  second line', '---'].join('\n'),
  );
  assert.equal(parsed.description, 'first line second line');
});

test('parseSkillFrontmatter ignores unrelated keys and indented body text', () => {
  const parsed = parseSkillFrontmatter(
    [
      '---',
      'name: vdr-index-setup',
      'license: MIT',
      'compatibility: "Agent Skills"',
      'allowed-tools:',
      '  - read',
      '  - write',
      'description: Set up a vector index',
      '---',
      'name: not-frontmatter',
    ].join('\n'),
  );
  assert.deepEqual(parsed, { name: 'vdr-index-setup', description: 'Set up a vector index' });
});

test('parseSkillFrontmatter degrades to empty rather than throwing', () => {
  assert.deepEqual(parseSkillFrontmatter(''), {});
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter\n'), {});
  assert.deepEqual(parseSkillFrontmatter('---\nname: unterminated\n'), {});
  assert.deepEqual(parseSkillFrontmatter('---\n---\n'), { name: undefined, description: undefined });
});

test('parseSkillFrontmatter tolerates a byte order mark', () => {
  assert.equal(parseSkillFrontmatter('\uFEFF---\nname: bom\n---\n').name, 'bom');
});

test('parseSkillFrontmatter reads CRLF line endings', () => {
  // Real plugin skills are CRLF. Before this was handled, `.` failed to match the `\r`, so no
  // field parsed and the whole file was dropped as nameless — a silent loss of every skill
  // authored on Windows.
  const crlf = ['---', 'name: huggingface-datasets', 'description: Dataset Viewer workflows', '---', ''].join('\r\n');
  assert.deepEqual(parseSkillFrontmatter(crlf), {
    name: 'huggingface-datasets',
    description: 'Dataset Viewer workflows',
  });
  assert.deepEqual(parseSkillFrontmatter('---\r\nname: x\r\ndescription: >\r\n  folded\r\n  text\r\n---\r\n'), {
    name: 'x',
    description: 'folded text',
  });
});
