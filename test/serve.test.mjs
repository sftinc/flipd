import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { makePrefix, makeSourceRepo, writeMain, writeRepoConf } from './helpers.mjs';
import { readState, writeState, emptyState } from '../lib/state.mjs';
import { serve, reconcile } from '../lib/serve.mjs';
import { sendCommand } from '../lib/socket.mjs';

async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

test('reconcile: an unfinished attempt is interrupted; a finished failed deploy is not re-reported; orphan releases go', async () => {
  const p = await makePrefix();
  const dir = p.repoDir('r');
  await fs.mkdir(path.join(dir, 'releases', 'orphan'), { recursive: true });
  await fs.mkdir(path.join(dir, 'releases', 'b'), { recursive: true });
  await writeState(dir, { ...emptyState(), live: 'a', pending: 'b', releases: { a: { sha: 'x' }, b: { sha: 'y' } }, last: { attempt: 't', outcome: null, finished: null } });
  await fs.symlink('releases/b', path.join(dir, 'current.tmp'));
  const lines = [];
  await reconcile(p, (l) => lines.push(l));
  let s = await readState(dir);
  assert.equal(s.pending, 'b');
  assert.equal(s.last.outcome, 'interrupted');
  assert.ok(s.last.finished);
  await assert.rejects(fs.lstat(path.join(dir, 'current.tmp')));
  await assert.rejects(fs.stat(path.join(dir, 'releases', 'orphan')));
  await fs.stat(path.join(dir, 'releases', 'b'));
  const events = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
  assert.equal((events.match(/interrupted/g) || []).length, 1);
  assert.ok(lines.some((l) => /rollback r/.test(l)));

  // Second start: last is final now, pending still set. No new interrupted event.
  lines.length = 0;
  await reconcile(p, (l) => lines.push(l));
  const again = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
  assert.equal((again.match(/interrupted/g) || []).length, 1);
  assert.ok(lines.some((l) => /unconfirmed|pending/.test(l)));
});

test('reconcile: a real run that was interrupted mid-deploy reads as interrupted', async () => {
  const p = await makePrefix();
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'sleep 30' });
  const { runEntry } = await import('../lib/run.mjs');
  const { loadRepo } = await import('../lib/config.mjs');
  const { loadMain } = await import('../lib/config.mjs');
  await writeMain(p);
  const ac = new AbortController();
  const ctx = { paths: p, main: await loadMain(p), repo: await loadRepo(p, 'r'), now: () => new Date(), protectedTargets: () => ({ targets: [], reserved: false }), signal: ac.signal, journal: () => {}, graceMs: 200 };
  const running = runEntry(ctx, { kind: 'webhook', name: 'r' });
  await new Promise((r) => setTimeout(r, 1500));
  // Simulate the crash: the process dies here, so close never runs. Take the on-disk state as it is now.
  const midState = await readState(p.repoDir('r'));
  assert.ok(midState.pending, 'flipped');
  assert.equal(midState.last.finished, null);
  ac.abort();
  await running;
  // Put the mid-run state back as if the crash had happened, then reconcile.
  await writeState(p.repoDir('r'), midState);
  const lines = [];
  await reconcile(p, (l) => lines.push(l));
  const s = await readState(p.repoDir('r'));
  assert.equal(s.last.outcome, 'interrupted');
  assert.equal(s.pending, midState.pending);
});

test('check runs on the worker through the socket, refuses when busy', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  const sha = await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'sleep 3', DEPLOY: 'true' });
  await fs.mkdir(p.repoDir('r'), { recursive: true });
  await fs.writeFile(path.join(p.repoDir('r'), 'key'), 'not-a-real-key');
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const r = await sendCommand(p.sock, { cmd: 'check', name: 'r', setRemote: false }, { timeoutMs: 30000 });
    assert.equal(r.ok, true);
    assert.equal(r.passed, true);
    assert.equal(r.behind, true, 'nothing is live yet');
    const text = r.rows.map(([k, v]) => `${k} ${v}`).join('\n');
    assert.match(text, /clone created/);
    assert.match(text, new RegExp(`main ${sha.slice(0, 7)}.*live: none.*behind`));
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r' }), { ok: true, queued: true });
    await new Promise((res) => setTimeout(res, 300));
    const busy = await sendCommand(p.sock, { cmd: 'check', name: 'r', setRemote: false }, { timeoutMs: 30000 });
    assert.equal(busy.ok, false);
    assert.match(busy.error, /^busy: running r, 0 queued$/);
  } finally {
    await svc.close();
  }
});

test('a signed push builds; run and rollback go through the socket; status reports the queue', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'b'.repeat(40), pusher: { name: 'w' }, repository: { ssh_url: src.url } });
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
    assert.equal(res.status, 202);
    await waitFor(async () => (await readState(p.repoDir('r'))).live !== null);
    const first = (await readState(p.repoDir('r'))).live;
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /webhook b{40} w/);

    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r' }), { ok: true, queued: true });
    await waitFor(async () => (await readState(p.repoDir('r'))).previous === first);
    const second = (await readState(p.repoDir('r'))).live;

    const rb = await sendCommand(p.sock, { cmd: 'rollback', name: 'r' });
    assert.deepEqual(rb, { ok: true, queued: true, target: first });
    await waitFor(async () => (await readState(p.repoDir('r'))).live === first);
    assert.equal((await readState(p.repoDir('r'))).previous, second);

    const st = await sendCommand(p.sock, { cmd: 'status' });
    assert.equal(st.ok, true);
    assert.equal(st.running, null);
    assert.deepEqual(st.queued, []);

    assert.equal((await sendCommand(p.sock, { cmd: 'run', name: 'nope' })).ok, false);
  } finally {
    await svc.close();
  }
});

test('a renamed repository still matches by id, and says so', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    const sign = (b) => 'sha256=' + createHmac('sha256', 'testsecret').update(b).digest('hex');
    const first = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: src.url, id: 777 } });
    assert.equal((await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body: first, headers: { 'x-hub-signature-256': sign(first), 'x-github-event': 'push' } })).status, 202);
    await waitFor(async () => (await readState(p.repoDir('r'))).live !== null);
    assert.equal((await readState(p.repoDir('r'))).github_id, 777);
    const renamed = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: 'git@github.com:o/newname.git', id: 777 } });
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body: renamed, headers: { 'x-hub-signature-256': sign(renamed), 'x-github-event': 'push' } });
    assert.equal(res.status, 202);
    assert.ok(lines.some((l) => /renamed: now git@github\.com:o\/newname\.git/.test(l)));
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /renamed now/);
  } finally {
    await svc.close();
  }
});

test('a push while pending is refused with 200', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const dir = p.repoDir('r');
  await fs.mkdir(dir, { recursive: true });
  await writeState(dir, { ...emptyState(), live: 'a', pending: 'b', releases: { a: { sha: 'x' }, b: { sha: 'y' } } });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: src.url } });
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /refused/);
  } finally {
    await svc.close();
  }
});
