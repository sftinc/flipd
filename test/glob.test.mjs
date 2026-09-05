// test/glob.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, anyMatches } from '../lib/glob.mjs';

const table = [
  ['mta/**', 'mta/listener/main.mjs', true],
  ['mta/**', 'mta', false],
  ['mta/*', 'mta/a.mjs', true],
  ['mta/*', 'mta/sub/a.mjs', false],
  ['**/*.md', 'README.md', true],
  ['**/*.md', 'docs/a/b.md', true],
  ['**/*.md', 'docs/a/b.mdx', false],
  ['docs/**', 'docs/x', true],
  ['a?c', 'abc', true],
  ['a?c', 'a/c', false],
  ['lib/(x).js', 'lib/(x).js', true],
  ['*.js', 'a.js', true],
  ['*.js', 'dir/a.js', false],
];

for (const [pattern, file, expected] of table) {
  test(`${pattern} vs ${file} → ${expected}`, () => {
    assert.equal(globToRegExp(pattern).test(file), expected);
  });
}

test('anyMatches: empty WATCH means everything, IGNORE removes', () => {
  assert.equal(anyMatches(['x/y'], [], []), true);
  assert.equal(anyMatches(['x/y'], [], ['x/**']), false);
  assert.equal(anyMatches(['docs/a.md', 'mta/x.mjs'], ['mta/**'], ['**/*.md']), true);
  assert.equal(anyMatches(['docs/a.md', 'mta/x.md'], ['mta/**'], ['**/*.md']), false);
  assert.equal(anyMatches([], [], []), false);
});
