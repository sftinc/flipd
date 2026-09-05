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

test('a partial file on disk gains missing fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-state-'));
  await fs.writeFile(path.join(dir, 'state.json'), '{"live":"r1"}');
  const s = await readState(dir);
  assert.equal(s.live, 'r1');
  assert.deepEqual(s.releases, {});
  assert.equal(s.pending, null);
  assert.equal(s.github_id, null);
});
