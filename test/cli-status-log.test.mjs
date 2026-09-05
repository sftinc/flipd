import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePrefix, writeMain, writeRepoConf } from './helpers.mjs';
import { writeState, emptyState } from '../lib/state.mjs';
import status from '../lib/cli/status.mjs';
import log from '../lib/cli/log.mjs';

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}

test('status: rows, PENDING, stale hook host, service down', async () => {
  const p = await makePrefix();
  await writeMain(p, 'PUBLIC_HOST=new.example.com\n');
  await writeRepoConf(p, 'a', { REPO: 'git@github.com:o/a.git', BUILD: 'x', DEPLOY: 'y', HOOK_HOST: 'old.example.com' });
  await writeRepoConf(p, 'b', { REPO: 'git@github.com:o/b.git', BUILD: 'x', DEPLOY: 'y', BRANCH: 'dev' });
  await writeRepoConf(p, 'c', { REPO: 'z', TYPO: '1' });
  await writeState(p.repoDir('a'), { ...emptyState(), live: 'r1', pending: 'r2', releases: { r1: { sha: 'a'.repeat(40) }, r2: { sha: 'b'.repeat(40) } }, last: { attempt: 't', outcome: 'deploy failed', finished: '2026-09-05T08:14:02Z', log: '/l' } });
  const o = io();
  assert.equal(await status([], { paths: p, ...o }), 0);
  const text = o.out();
  assert.match(text, /^a\s+main\s+aaaaaaa\s+DEPLOY FAILED.*service down/m);
  assert.match(text, /PENDING r2/);
  assert.match(text, /webhook.*old\.example\.com.*new\.example\.com/);
  assert.match(text, /^b\s+dev\s+-\s+never/m);
  assert.match(text, /^c\s+config error/m);
  const one = io();
  assert.equal(await status(['b'], { paths: p, ...one }), 0);
  assert.ok(!one.out().includes('\na'));
  assert.equal(await status(['zzz'], { paths: p, ...io() }), 1);
});

test('status: a corrupt state.json for one repo does not hide the rest', async () => {
  const p = await makePrefix();
  await writeMain(p);
  await writeRepoConf(p, 'broken', { REPO: 'git@github.com:o/broken.git', BUILD: 'x', DEPLOY: 'y' });
  await writeRepoConf(p, 'healthy', { REPO: 'git@github.com:o/healthy.git', BUILD: 'x', DEPLOY: 'y' });
  await fs.mkdir(p.repoDir('broken'), { recursive: true });
  await fs.writeFile(path.join(p.repoDir('broken'), 'state.json'), '{ not json');
  const o = io();
  assert.equal(await status([], { paths: p, ...o }), 0);
  const text = o.out();
  assert.match(text, /^broken\s+main/m);
  assert.match(text, /^healthy\s+main\s+-\s+never/m);
});

test('log prints the latest attempt log', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'a', { REPO: 'x', BUILD: 'x', DEPLOY: 'y' });
  await fs.mkdir(p.repoLog('a'), { recursive: true });
  await fs.writeFile(path.join(p.repoLog('a'), '2026-01-01T00-00-00Z.log'), 'old');
  await fs.writeFile(path.join(p.repoLog('a'), '2026-01-02T00-00-00Z.log'), 'new');
  const o = io();
  assert.equal(await log(['a'], { paths: p, ...o }), 0);
  assert.equal(o.out(), 'new');
  const none = io();
  assert.equal(await log(['zzz'], { paths: p, ...none }), 1);
  const bad = io();
  assert.equal(await log(['../x'], { paths: p, ...bad }), 1);
  assert.match(bad.err(), /repo name/);
});
