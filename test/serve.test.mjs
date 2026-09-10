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

// "The worker has finished with this attempt", asked of the worker itself.
// Polling state.json instead is what these tests used to do, and it is not the
// same question: deploy() writes `live` at step 6, and runEntry then goes on
// through prune, close and notify, so a state.json poll can fire while the entry
// is still the queue's `running` slot — which is exactly how the `st.running ===
// null` assertion below failed about one run in eighteen.
async function waitIdle(p) {
  await waitFor(async () => {
    const st = await sendCommand(p.sock, { cmd: 'status' });
    return st.ok && st.running === null && st.queued.length === 0;
  });
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
    assert.equal(r.pending, false, 'nothing is flipped');
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

test('check reports an unconfirmed pending release separately from being behind', async () => {
  // The two call for opposite actions: behind wants `flipd run`, pending wants
  // a look first. Folding pending into behind is what let the cron catch-up
  // in docs/operating.md force-build over an unconfirmed flip. So: live at the
  // head with a pending release is pending and not behind.
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  const sha = await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  await fs.mkdir(p.repoDir('r'), { recursive: true });
  await fs.writeFile(path.join(p.repoDir('r'), 'key'), 'not-a-real-key');
  await writeState(p.repoDir('r'), { ...emptyState(), live: 'a', pending: 'b', releases: { a: { sha }, b: { sha: 'y' } } });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const r = await sendCommand(p.sock, { cmd: 'check', name: 'r', setRemote: false }, { timeoutMs: 30000 });
    assert.equal(r.ok, true);
    assert.equal(r.passed, true);
    assert.equal(r.behind, false, 'live is the head');
    assert.equal(r.pending, true, 'b is flipped but unconfirmed');
    assert.ok(r.rows.some(([k, v]) => k === 'pending' && /^b is flipped but unconfirmed/.test(v)), 'the pending row still names the release');
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
    await waitIdle(p);
    const first = (await readState(p.repoDir('r'))).live;
    assert.ok(first, 'the pushed release is live');
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /webhook b{40} w/);

    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r' }), { ok: true, queued: true });
    await waitIdle(p);
    assert.equal((await readState(p.repoDir('r'))).previous, first);
    const second = (await readState(p.repoDir('r'))).live;

    const rb = await sendCommand(p.sock, { cmd: 'rollback', name: 'r' });
    assert.deepEqual(rb, { ok: true, queued: true, target: first });
    await waitIdle(p);
    assert.equal((await readState(p.repoDir('r'))).live, first);
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
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: src.url } });
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /refused/);
    // Both sinks, like the unreadable-state refusal: events.log is the repo's
    // record, journald is where an operator is looking.
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /refused pending b; run flipd rollback r or flipd run r\n/);
    assert.ok(lines.some((l) => l === '[r] refused a push: pending b; run flipd rollback r or flipd run r'), `the refusal is in journald: ${lines}`);
  } finally {
    await svc.close();
  }
});

test('a push to a repo with an unreadable state.json is refused with 200, not lost to a 500', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  await fs.mkdir(p.repoDir('r'), { recursive: true });
  await fs.writeFile(path.join(p.repoDir('r'), 'state.json'), 'not json');
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: src.url } });
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
    // GitHub records a 500 as a failed delivery and will not retry it, so an
    // unguarded readState here does not merely fail loudly: it loses the push.
    assert.equal(res.status, 200);
    assert.match(await res.text(), /refused/);
    assert.ok(lines.some((l) => /\[r\] refused a push:.*state\.json/.test(l)), 'the reason is in journald');
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /refused state\.json is unreadable/);
    const st = await sendCommand(p.sock, { cmd: 'status' });
    assert.equal(st.running, null);
    assert.deepEqual(st.queued, [], 'nothing was queued against a repo whose state cannot be read');
  } finally {
    await svc.close();
  }
});

test('serve closes the hook server if the socket fails to start, so a retry can bind the same port', async () => {
  const p = await makePrefix();
  const port = await getFreePort();
  await fs.mkdir(path.dirname(p.mainConf), { recursive: true });
  await fs.writeFile(p.mainConf, `WEBHOOK_SECRET=testsecret\nLISTEN=127.0.0.1:${port}\nPUBLIC_HOST=deploy.example.com\n`);
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

test('findRepoFor: REPO matches ssh_url case-insensitively, so a lowercase conf still receives a push', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'app', { REPO: 'git@github.com:myorg/myapp.git', BUILD: 'true', DEPLOY: 'true' });
  const find = findRepoFor(p, () => {});
  // GitHub renders ssh_url in the repository's canonical case. ls-remote is
  // case-insensitive, so `check` passes; without this the push never matched
  // and github_id was never recorded, because no webhook run ever happened.
  const repo = await find({ sshUrl: 'git@github.com:MyOrg/MyApp.git', branch: 'main', id: null });
  assert.equal(repo?.name, 'app');
  assert.equal(await find({ sshUrl: 'git@github.com:MyOrg/Other.git', branch: 'main', id: null }), null, 'case is the only thing forgiven');
});

test('findRepoFor: REPO and ssh_url match by identity — case, scp vs ssh:// with a port, .git and a trailing slash are all forgiven', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'scp', { REPO: 'git@forge.example.com:Team/App.git', BUILD: 'true', DEPLOY: 'true' });
  await writeRepoConf(p, 'plain', { REPO: 'file:///srv/git/other', BUILD: 'true', DEPLOY: 'true' });
  const find = findRepoFor(p, () => {});
  const q = (sshUrl) => find({ sshUrl, branch: 'main', id: null });
  // Forgejo renders ssh_url as ssh://git@host:port/... when SSH is not on 22;
  // the operator wrote the scp form. Same repository.
  assert.equal((await q('ssh://git@forge.example.com:2222/team/app'))?.name, 'scp');
  assert.equal((await q('GIT@FORGE.EXAMPLE.COM:team/app.git/'))?.name, 'scp');
  assert.equal(await q('git@other.example.com:team/app.git'), null, 'a different host is a different repository');
  assert.equal(await q('git@forge.example.com:team/app2.git'), null, 'a different repo is a different repository');
  assert.equal((await q('file:///srv/git/OTHER'))?.name, 'plain', 'an unparsed URL still matches by lowercased string');
  assert.equal(await q('file:///srv/git/other2'), null);
});

test('findRepoFor: the id fallback is scoped to the host, so equal ids on two forges cannot cross-match', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'gh', { REPO: 'git@github.com:o/app.git', BUILD: 'true', DEPLOY: 'true' });
  await writeRepoConf(p, 'fj', { REPO: 'git@forge.example.com:o/app.git', BUILD: 'true', DEPLOY: 'true' });
  // Forgejo ids are small per-instance integers; a collision with another
  // forge's id is ordinary, not a corner case.
  await writeState(p.repoDir('gh'), { ...emptyState(), github_id: 12 });
  await writeState(p.repoDir('fj'), { ...emptyState(), github_id: 12 });
  const find = findRepoFor(p, () => {});
  assert.equal((await find({ sshUrl: 'git@forge.example.com:o/renamed.git', branch: 'main', id: 12 }))?.name, 'fj');
  assert.equal((await find({ sshUrl: 'git@github.com:o/renamed.git', branch: 'main', id: 12 }))?.name, 'gh');
  assert.equal(await find({ sshUrl: 'git@third.example.com:o/renamed.git', branch: 'main', id: 12 }), null, 'same id, unknown host: no match');
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

test('close() waits for the in-flight attempt to finish writing, not merely until its bound exists', async () => {
  // The drain's bound is a tunable, and a wrong value goes green unless
  // something asserts what the wait is for. Nothing else in the suite exercises
  // serve()'s close() with an attempt actually in flight: the "shutdown
  // mid-build" test drives runEntry directly with its own AbortController.
  //
  // The property is not the elapsed time — abort() kills the build at once, so a
  // healthy shutdown here is fast — but that close() does not return until the
  // attempt has recorded its own outcome. A `finished` still null at this point
  // is exactly what startup reads as "the service died inside that attempt".
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'sleep 3', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r' }), { ok: true, queued: true });
  await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r');
  await svc.close();
  const s = await readState(p.repoDir('r'));
  assert.ok(s.last, 'the attempt announced itself');
  assert.ok(s.last.finished, 'close() returned only after the attempt wrote its outcome');
  assert.equal(s.last.outcome, 'interrupted');
  await assert.rejects(fs.stat(path.join(p.repoDir('r'), 'current')), 'a build killed by shutdown never flipped');
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

test('a forged newline in pusher or ssh_url cannot forge an events.log or journal line', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    const sign = (b) => 'sha256=' + createHmac('sha256', 'testsecret').update(b).digest('hex');

    // `pusher` is whatever GitHub relays from the payload. A signature proves
    // the sender holds the secret; it does not make the field safe to write to
    // a log. A newline here would append a second, fabricated events.log line.
    const evil = 'w\n2026-01-01T00:00:00.000Z ok FORGED-EVENT everything is fine';
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'b'.repeat(40), pusher: { name: evil }, repository: { ssh_url: src.url, id: 4242 } });
    assert.equal((await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body), 'x-github-event': 'push' } })).status, 202);
    await waitIdle(p);

    // The property is not that the text disappears -- seeing what was actually
    // sent is the point of a log -- but that it cannot become a *line*. Every
    // events.log line must still begin with a timestamp, so a reader (or a
    // future parser) can never mistake payload text for a record flipd wrote.
    const ev = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
    for (const l of ev.trim().split('\n')) {
      assert.match(l, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \S/, `every events.log line starts with a timestamp: ${l}`);
    }
    assert.ok(/webhook b{40} w\?/.test(ev), 'the pusher is recorded, with the newline neutralised to a visible marker');

    // Same field, same hazard, the other sink: the rename path journals the
    // pushed ssh_url and writes it to events.log.
    const renamed = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: 'git@github.com:o/n.git\nFORGED-JOURNAL rest of line', id: 4242 } });
    await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body: renamed, headers: { 'x-hub-signature-256': sign(renamed), 'x-github-event': 'push' } });
    await waitIdle(p);

    for (const l of lines) assert.ok(!l.includes('\n'), `no journal line contains a newline: ${JSON.stringify(l)}`);
    assert.ok(lines.some((l) => /git@github\.com:o\/n\.git\?FORGED-JOURNAL/.test(l)), 'the url is still logged, on one line, with the newline neutralised');
    const ev2 = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
    for (const l of ev2.trim().split('\n')) {
      assert.match(l, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \S/, `still one timestamped line each: ${l}`);
    }
  } finally {
    await svc.close();
  }
});

test('the webhook events line carries the delivery id, cut to 40; a coalesced push says so in its reply', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'sleep 5', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const sign = (b) => 'sha256=' + createHmac('sha256', 'testsecret').update(b).digest('hex');
    const post = (body, delivery) => fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body), 'x-github-event': 'push', ...(delivery === undefined ? {} : { 'x-github-delivery': delivery }) } });
    // r1 is running for the whole test, so every push to it is coalesced
    // into the run-again flag and the reply has to say so.
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r1' }), { ok: true, queued: true });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r1');

    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'c'.repeat(40), pusher: { name: 'w' }, repository: { ssh_url: src.url } });
    const first = await post(body, '72d3162e-cc78-11e3-81ab-4c9367dc0958');
    assert.equal(first.status, 202);
    assert.equal(await first.text(), 'queued r1 (running; will run again after)');
    const second = await post(body, 'd'.repeat(200));
    assert.equal(second.status, 202);
    const third = await post(body);   // no header
    assert.equal(third.status, 202);
    // No pusher: the field's separator must go with it, not leave a third space.
    const nobody = JSON.stringify({ ref: 'refs/heads/main', after: 'e'.repeat(40), repository: { ssh_url: src.url } });
    assert.equal((await post(nobody, 'aaaaaaaa-0000-0000-0000-000000000000')).status, 202);

    const events = await fs.readFile(path.join(p.repoLog('r1'), 'events.log'), 'utf8');
    assert.match(events, /webhook c{40} w  delivery=72d3162e-cc78-11e3-81ab-4c9367dc0958\n/);
    assert.match(events, new RegExp(`webhook c{40} w  delivery=d{40}\\n`), 'a long id is cut to 40, not carried whole');
    assert.match(events, /webhook c{40} w\n/, 'no header, no delivery= field');
    assert.match(events, /webhook e{40}  delivery=aaaaaaaa-0000-0000-0000-000000000000\n/, 'no pusher: sha, two spaces, the id');
    assert.match(events, /queued webhook \(running; will run again after\)/);
  } finally {
    await svc.close();
  }
});

test('a push during shutdown is refused with 503, not answered 202 for work that was discarded', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  // What this test needs is the window where the queue is stopped and the
  // listener is still up. close() runs queue.stop() and abort.abort()
  // synchronously before its first await, so `stopping` is guaranteed the
  // moment svc.close() returns. The window's *width* is not what the shape
  // of this test suggests: BUILD never runs. waitFor sees the queue's
  // `running` slot, which kick() fills before awaiting the runner, so the
  // abort lands while runEntry is still in clone/fetch, and killing that
  // git child ends the drain in about 3ms -- not the 5s sleep, and nowhere
  // near the 20s drain bound. The client wins by roughly a millisecond
  // because a loopback connect needs fewer event-loop turns than
  // kill -> SIGCHLD -> writeState -> appendEvent -> log.close(). Measured
  // 89/89 clean, 64 of those under concurrent load. A loss would be a loud
  // ECONNREFUSED, never a false pass: even a fast drain leaves stopped ===
  // true, so the 503 assertion cannot pass for the wrong reason. Making the
  // window genuinely wide (a marker file BUILD touches, then waitFor it)
  // would cost the suite the full 10s graceMs on every run, for a race that
  // did not reproduce in 89 tries.
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'trap "" TERM; sleep 5', DEPLOY: 'true' });
  await writeRepoConf(p, 'r2', { REPO: 'git@github.com:o/r2.git', BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r1' }), { ok: true, queued: true });
  await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r1');
  const closing = svc.close();   // queue.stop() has run by the time this returns
  try {
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: 'git@github.com:o/r2.git' } });
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${svc.hookPort}/deploy`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push' } });
    assert.equal(res.status, 503);
    assert.equal(await res.text(), 'refused r2 (stopping)');
    assert.match(await fs.readFile(path.join(p.repoLog('r2'), 'events.log'), 'utf8'), /refused stopping\n/);
    // A shutdown is when an operator is on journalctl, not in a per-repo file.
    assert.ok(lines.some((l) => l === '[r2] refused a push: stopping; redeliver it from GitHub once flipd is back'), `the refusal is in journald: ${lines}`);
  } finally {
    await closing;
  }
});

test('now on run and rollback reaches the worker and skips STOP; without it STOP refuses', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', STOP: 'exit 1', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r' }), { ok: true, queued: true });
    await waitIdle(p);
    let s = await readState(p.repoDir('r'));
    assert.equal(s.last.outcome, 'stop failed');
    assert.equal(s.live, null);

    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r', now: true }), { ok: true, queued: true });
    await waitIdle(p);
    s = await readState(p.repoDir('r'));
    assert.equal(s.last.outcome, 'ok');
    const first = s.live;
    assert.ok(first);

    assert.deepEqual(await sendCommand(p.sock, { cmd: 'run', name: 'r', now: true }), { ok: true, queued: true });
    await waitIdle(p);
    s = await readState(p.repoDir('r'));
    assert.equal(s.previous, first);

    const refused = await sendCommand(p.sock, { cmd: 'rollback', name: 'r' });
    assert.deepEqual(refused, { ok: true, queued: true, target: first });
    await waitIdle(p);
    s = await readState(p.repoDir('r'));
    assert.equal(s.last.outcome, 'stop failed');
    assert.notEqual(s.live, first);

    const rb = await sendCommand(p.sock, { cmd: 'rollback', name: 'r', now: true });
    assert.deepEqual(rb, { ok: true, queued: true, target: first });
    await waitIdle(p);
    s = await readState(p.repoDir('r'));
    assert.equal(s.live, first);

    const events = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
    assert.match(events, /queued manual --now\n/);
    assert.match(events, /rollback queued, target \S+ --now\n/);
  } finally {
    await svc.close();
  }
});

test('no PUBLIC_HOST: no hook listener, no secret needed, and both the shutdown and the failed-socket-bind paths survive the null hook', async () => {
  const p = await makePrefix();
  await fs.mkdir(path.dirname(p.mainConf), { recursive: true });
  await fs.writeFile(p.mainConf, 'LISTEN=127.0.0.1:0\n');   // no PUBLIC_HOST, no WEBHOOK_SECRET
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    assert.equal(svc.hookPort, null);
    assert.ok(lines.includes('webhook listener off: PUBLIC_HOST is not set'), `journal: ${lines}`);
    assert.ok(!lines.some((l) => /listening on/.test(l)), 'nothing claims to listen');
    const st = await sendCommand(p.sock, { cmd: 'status' });
    assert.equal(st.ok, true, 'the socket is up regardless: SSH triggers, run and rollback all go through it');
  } finally {
    await svc.close();   // the shutdown path with hook === null
  }
  // The socket-bind-failure path, which closes the hook server when there is
  // one: a directory at the socket path makes createSocketServer's own
  // fs.rm throw ERR_FS_EISDIR. Matching that code, not just any rejection,
  // is what pins the `if (hook)` guard: drop the guard and hook.close(r) is
  // called on null instead, which rejects with a TypeError and would slip
  // past a bare assert.rejects unnoticed.
  await fs.mkdir(p.sock);
  await assert.rejects(serve({ paths: p, journal: () => {} }), (e) => e.code === 'ERR_FS_EISDIR');
  await fs.rm(p.sock, { recursive: true, force: true });
});

test('trigger over the socket is the webhook without a payload: queued as webhook via ssh, coalesces mid-run, labelled everywhere', async () => {
  const p = await makePrefix();
  await writeMain(p, '', { publicHost: null });   // no HTTP door at all; the socket is the way in
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'sleep 1', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r' }), { ok: true, accepted: true });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r');
    // A second trigger while the first runs coalesces, and is still accepted:
    // the push is covered by work already accepted, as the hook answers 202.
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r' }), { ok: true, accepted: true, reason: 'running; will run again after' });
    await waitIdle(p);
    const s = await readState(p.repoDir('r'));
    assert.equal(s.last.trigger, 'coalesced', 'the catch-up rerun is labelled for what it is');
    const events = await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
    assert.match(events, /queued ssh\n/);
    assert.match(events, /queued ssh \(running; will run again after\)\n/);
    assert.match(events, /started \S+ ssh /);
    assert.match(events, /started \S+ coalesced /);
    assert.ok(lines.includes('[r] ssh ok'), `journald uses the label too: ${lines}`);
    assert.ok(lines.some((l) => /^\[r\] coalesced (ok|skipped)$/.test(l)), `and for the rerun: ${lines}`);
    // An unknown repo throws as it does for run.
    assert.equal((await sendCommand(p.sock, { cmd: 'trigger', name: 'nope' })).ok, false);
  } finally {
    await svc.close();
  }
});

test('trigger while pending or with an unreadable state is refused, in the hook\'s words, in both sinks, and nothing is queued', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const dir = p.repoDir('r');
  await fs.mkdir(dir, { recursive: true });
  await writeState(dir, { ...emptyState(), live: 'a', pending: 'b', releases: { a: { sha: 'x' }, b: { sha: 'y' } } });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  try {
    // --wait on a refusal answers at once: there is nothing to wait for.
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r', wait: true }), { ok: false, refused: 'pending b' });
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /refused pending b; run flipd rollback r or flipd run r\n/);
    assert.ok(lines.includes('[r] refused a trigger: pending b; run flipd rollback r or flipd run r'), `journald: ${lines}`);
    assert.deepEqual((await sendCommand(p.sock, { cmd: 'status' })).queued, []);
    await fs.writeFile(path.join(dir, 'state.json'), 'not json');
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r' }), { ok: false, refused: 'state.json is unreadable' });
    assert.match(await fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8'), /refused state\.json is unreadable/);
    assert.deepEqual((await sendCommand(p.sock, { cmd: 'status' })).queued, []);
  } finally {
    await svc.close();
  }
});

test('trigger during shutdown is refused as stopping, in both sinks, with the trigger door\'s own recovery advice, and nothing is queued', async () => {
  const p = await makePrefix();
  await writeMain(p, '', { publicHost: null });   // no HTTP door; only the socket is under test
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  // Same technique as the webhook's shutdown test above: close() runs
  // queue.stop() and abort.abort() synchronously before its first await, so
  // `stopping` is guaranteed the instant svc.close() returns — no waitFor,
  // no race. r1's BUILD never actually runs (the abort lands during
  // fetch/checkout); r2 needs no reachable REPO because the refusal returns
  // before any fetch is attempted.
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'trap "" TERM; sleep 5', DEPLOY: 'true' });
  await writeRepoConf(p, 'r2', { REPO: 'git@github.com:o/r2.git', BUILD: 'true', DEPLOY: 'true' });
  const lines = [];
  const svc = await serve({ paths: p, journal: (l) => lines.push(l) });
  assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r1' }), { ok: true, accepted: true });
  await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r1');
  const closing = svc.close();   // queue.stop() has run by the time this returns
  try {
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r2' }), { ok: false, refused: 'stopping' });
    assert.match(await fs.readFile(path.join(p.repoLog('r2'), 'events.log'), 'utf8'), /refused stopping\n/);
    // The record itself does not distinguish doors — only journald's advice does.
    assert.ok(lines.some((l) => l === '[r2] refused a trigger: stopping; trigger again once flipd is back'), `journald: ${lines}`);
    assert.deepEqual((await sendCommand(p.sock, { cmd: 'status' })).queued, []);
  } finally {
    await closing;
  }
});

test('trigger --wait holds the reply until the covering attempt settles: ok, then skipped, then a failure', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const wait = () => sendCommand(p.sock, { cmd: 'trigger', name: 'r', wait: true }, { timeoutMs: null });
    assert.deepEqual(await wait(), { ok: true, outcome: 'ok' });
    assert.deepEqual(await wait(), { ok: true, outcome: 'skipped' }, 'already live: the webhook rule, not run\'s override');
    await src.commit({ a: '2' });
    await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'false', DEPLOY: 'true' });
    assert.deepEqual(await wait(), { ok: true, outcome: 'build failed' });
  } finally {
    await svc.close();
  }
});

test('trigger --wait: a conf that breaks before the worker reaches it answers config failed', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'sleep 1', DEPLOY: 'true' });
  await writeRepoConf(p, 'r2', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    await sendCommand(p.sock, { cmd: 'run', name: 'r1' });   // holds the worker
    const waiting = sendCommand(p.sock, { cmd: 'trigger', name: 'r2', wait: true }, { timeoutMs: null });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).queued.includes('r2'));
    await fs.writeFile(p.repoConf('r2'), 'nonsense\n');   // the handler already loaded it; the worker will not
    assert.deepEqual(await waiting, { ok: true, outcome: 'config failed' });
  } finally {
    await svc.close();
  }
});

test('trigger --wait: a client that goes away does not cancel the build', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'sleep 1', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    const conn = net.createConnection(p.sock);
    conn.on('error', () => {});
    conn.on('connect', () => conn.write(`${JSON.stringify({ cmd: 'trigger', name: 'r', wait: true })}\n`));
    // Wait for the build to actually be in flight before dropping the
    // connection, rather than a fixed delay: a fixed delay only proves the
    // build ran within *some* window, and under load (this is the slowest
    // file in the suite, running concurrently with other files) it can elapse
    // before the handler's readState + enqueue have even finished, destroying
    // the connection before anything was queued at all. Observing `running`
    // both removes that race and proves the claim the test makes — the
    // client was still connected when the build actually started.
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r');
    conn.destroy();
    await waitIdle(p);
    assert.equal((await readState(p.repoDir('r'))).last.outcome, 'ok', 'the build ran to completion');
  } finally {
    await svc.close();
  }
});

test('close answers an open trigger --wait with stopping when its entry is dropped', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r1', { REPO: src.url, BUILD: 'sleep 5', DEPLOY: 'true' });
  await writeRepoConf(p, 'r2', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    await sendCommand(p.sock, { cmd: 'run', name: 'r1' });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r1');
    const waiting = sendCommand(p.sock, { cmd: 'trigger', name: 'r2', wait: true }, { timeoutMs: null });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).queued.includes('r2'));
    const closing = svc.close();
    assert.deepEqual(await waiting, { ok: false, refused: 'stopping' });
    await closing;
  } finally {
    // svc.close() is memoized (closing is cached and re-returned), so this is
    // a no-op on the pass-through path above and the safety net if waitFor or
    // the assertion throws first — without it, a thrown waitFor here leaves a
    // listening socket server behind for the rest of the run, in the file
    // that other tests are least able to afford it in.
    await svc.close();
  }
});

test('trigger --wait against a repo already building follows the coalesced rerun, not the build already in flight', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'sleep 1', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    assert.deepEqual(await sendCommand(p.sock, { cmd: 'trigger', name: 'r' }), { ok: true, accepted: true });
    await waitFor(async () => (await sendCommand(p.sock, { cmd: 'status' })).running === 'r');
    // A wrong handler that only awaits `covered` when `enqueue` reports
    // `queued: true` would answer `accepted` immediately here too — this is
    // the branch that catches it: `r` is already building, so this trigger's
    // `covered` is the queue's promise for the *rerun* the running build owes
    // afterwards (queue.mjs's `runAgain`), not the build already in flight.
    // Following the wrong one would answer for a push this trigger never saw.
    const waiting = sendCommand(p.sock, { cmd: 'trigger', name: 'r', wait: true }, { timeoutMs: null });
    assert.deepEqual(await waiting, { ok: true, outcome: 'skipped' }, 'the rerun sees the same head the in-flight build is about to make live, so it has nothing to do');
    const s = await readState(p.repoDir('r'));
    assert.equal(s.last.trigger, 'coalesced', 'confirms the reply was answered for the rerun entry, not the build already running');
  } finally {
    await svc.close();
  }
});
