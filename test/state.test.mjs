// test/state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState, readState, writeState } from '../lib/state.mjs';

test('missing state reads as empty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-state-'));
  assert.deepEqual(await readState(dir), emptyState());
});

test('round trip, and a stale tmp file is ignored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-state-'));
  const s = { ...emptyState(), live: 'r1', releases: { r1: { sha: 'a'.repeat(40), root: '.', deploy: 'x', built: 't' } } };
  await writeState(dir, s);
  await fs.writeFile(path.join(dir, 'state.json.tmp'), '{ broken');
  assert.deepEqual(await readState(dir), s);
  const names = await fs.readdir(dir);
  assert.ok(names.includes('state.json'));
});

test('concurrent writes all land, none fails on a shared temporary file, and none is left behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-state-'));
  // With one fixed `state.json.tmp` these truncate each other: the loser's
  // rename finds nothing (ENOENT) or moves half-written bytes over the real
  // file. Promise.all surfaces the first such rejection.
  const writes = [];
  for (let i = 0; i < 200; i++) writes.push(writeState(dir, { ...emptyState(), live: `r${i}` }));
  await Promise.all(writes);
  const s = await readState(dir);
  assert.match(s.live, /^r\d+$/, 'the file that survives is a whole one, not a truncated mix');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n !== 'state.json'), [], 'no temporary file is left behind');
});

test('a partial file on disk gains missing fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-state-'));
  await fs.writeFile(path.join(dir, 'state.json'), '{"live":"r1"}');
  const s = await readState(dir);
  assert.equal(s.live, 'r1');
  assert.deepEqual(s.releases, {});
  assert.equal(s.pending, null);
  assert.equal(s.github_id, null);
});
