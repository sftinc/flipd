import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { makePrefix, makeSourceRepo, writeMain, writeRepoConf } from './helpers.mjs';
import { readState, writeState, emptyState } from '../lib/state.mjs';
import { serve, reconcile, findRepoFor } from '../lib/serve.mjs';
import { sendCommand } from '../lib/socket.mjs';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.once('error', reject);
  });
}

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
  // Poll rather than a fixed sleep: a real clone and worktree add must finish
  // before the flip sets `pending`, and a fixed delay is a flake risk on a
  // loaded machine.
  await waitFor(async () => (await readState(p.repoDir('r'))).pending !== null);
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

test('serve closes the hook server if the socket fails to start, so a retry can bind the same port', async () => {
  const p = await makePrefix();
  const port = await getFreePort();
  await fs.mkdir(path.dirname(p.mainConf), { recursive: true });
  await fs.writeFile(p.mainConf, `WEBHOOK_SECRET=testsecret\nLISTEN=127.0.0.1:${port}\n`);
  // Occupy the socket's path with something createSocketServer cannot bind
  // to: a directory makes its very first `fs.rm(sockPath, {force:true})`
  // throw before it ever attempts to listen — the same "throws after the
  // hook is already up" shape as the real EINVAL this fix was written for.
  await fs.mkdir(p.sock);
  await assert.rejects(serve({ paths: p, journal: () => {} }));
  await fs.rm(p.sock, { recursive: true, force: true });
  // If the failed attempt's hook server were still listening, binding this
  // exact, fixed port again would fail with EADDRINUSE.
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    assert.equal(svc.hookPort, port);
  } finally {
    await svc.close();
  }
});

test('reconcile: one repo failing does not stop reconcile for the others', async () => {
  const p = await makePrefix();
  const good = p.repoDir('good');
  await fs.mkdir(good, { recursive: true });
  await writeState(good, { ...emptyState(), last: { attempt: 't', outcome: null, finished: null } });
  // state.json itself reads fine (so the failure isn't just the already-
  // guarded readState call): current.tmp is a directory instead of a
  // symlink/file, so the unguarded `fs.rm(current.tmp, {force:true})` throws
  // EISDIR partway through this repo's reconcile step.
  const bad = p.repoDir('bad');
  await fs.mkdir(bad, { recursive: true });
  await writeState(bad, emptyState());
  await fs.mkdir(path.join(bad, 'current.tmp'));
  const lines = [];
  await reconcile(p, (l) => lines.push(l));
  const s = await readState(good);
  assert.equal(s.last.outcome, 'interrupted', 'the good repo is still reconciled');
  assert.ok(lines.some((l) => /\[bad\].*reconcile failed/.test(l)), 'the bad repo is journaled, not thrown');
});

test('reconcile leaves the release current still points to, even with no state.json for it', async () => {
  const p = await makePrefix();
  const dir = p.repoDir('r');
  await fs.mkdir(path.join(dir, 'releases', 'live-one'), { recursive: true });
  await fs.symlink('releases/live-one', path.join(dir, 'current'));
  // No state.json at all: emptyState()'s releases map is empty, so a naive
  // sweep would treat every release directory - including the live one - as
  // unregistered.
  await writeState(dir, emptyState());
  await reconcile(p, () => {});
  await fs.stat(path.join(dir, 'releases', 'live-one'));
});

test('findRepoFor: a corrupt state.json for one repo does not break rename-matching for others', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'corrupt', { REPO: 'git@github.com:o/corrupt.git', BUILD: 'true', DEPLOY: 'true' });
  await writeRepoConf(p, 'ok', { REPO: 'git@github.com:o/ok.git', BUILD: 'true', DEPLOY: 'true' });
  await fs.mkdir(p.repoDir('corrupt'), { recursive: true });
  await fs.writeFile(path.join(p.repoDir('corrupt'), 'state.json'), 'not json');
  await writeState(p.repoDir('ok'), { ...emptyState(), github_id: 999 });
  const lines = [];
  const find = findRepoFor(p, (l) => lines.push(l));
  const repo = await find({ sshUrl: 'git@github.com:o/renamed.git', branch: 'main', id: 999 });
  assert.equal(repo?.name, 'ok');
  assert.ok(lines.some((l) => /\[corrupt\].*could not read state/.test(l)));
});

test('shutdown journals a queued-but-not-yet-started entry that gets dropped', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'sleep 5', DEPLOY: 'true' });
  await writeRepoConf(p, 'r2', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r1' }), { ok: true, queued: true });
  await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r1');
  // r2 cannot start while r1 is running: it sits in the queue, not yet
  // started, right up until close() drops it.
  assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r2' }), { ok: true, queued: true });
  assert.deepEqual((await sendCommand(p.sock, { cmd: 'status' })).queued, ['r2']);
  await svc.close();
  assert.ok(lines.some((l) => /\[r2\].*dropped at shutdown/.test(l)), 'the dropped entry is journaled, not silent');
});

test('shutdown waits, bounded, for a still-running deferred ON_FAILURE notification, then leaves it running rather than cutting off its message', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const dir = p.repoDir('r');
  // Longer than the 3s bound, so it is still running when that bound fires;
  // short enough that it finishes on its own shortly after, which this test
  // waits for directly, so nothing is left running past the test itself.
  const marker = path.join(dir, 'onfailure-ran');
  await writeRepoConf(p, 'r', { REPO: 'git@github.com:o/r.git', BUILD: 'true', DEPLOY: 'true', ON_FAILURE: `sleep 4 && touch ${marker}` });
  await fs.mkdir(path.join(dir, 'releases', 'a'), { recursive: true });
  await writeState(dir, {
    ...emptyState(),
    live: 'a',
    releases: { a: { sha: 'x' } },
    last: { attempt: 'startup-attempt', outcome: null, finished: null, sha: 'x', release: 'a', log: null },
  });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  // Let the deferred notification actually start (it is fired right after
  // listen, asynchronously) before shutting down — otherwise this would
  // test "cancelled before it started" rather than "still running when
  // shutdown began".
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await svc.close();
  const elapsed = Date.now() - t0;
  // Bounded to ~3s: genuinely waited (not near-instant) but did not wait for
  // the notification's own 4s duration to finish.
  assert.ok(elapsed >= 2500, `close() should wait close to the 3s bound, not return early (took ${elapsed}ms)`);
  assert.ok(elapsed < 8000, `close() must not wait for the notification to finish on its own (took ${elapsed}ms)`);
  assert.ok(
    lines.some((l) => /\[r\].*ON_FAILURE still running.*leaving it running/.test(l)),
    'the still-running job is journaled by name at the bound, not silently dropped',
  );
  // Not killed: it keeps running after close() returns and finishes on its
  // own. Waiting for that here both proves it and drains it, so this test
  // leaves nothing running behind it.
  await waitFor(async () => { try { await fs.stat(marker); return true; } catch { return false; } });
});
