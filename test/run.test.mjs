// test/run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePrefix, makeSourceRepo, writeRepoConf, tmpdir } from './helpers.mjs';
import { loadRepo } from '../lib/config.mjs';
import { readState, writeState } from '../lib/state.mjs';
import { runEntry, runOnFailure, resolveRollbackTarget } from '../lib/run.mjs';
import { runCheck } from '../lib/check.mjs';
import { gitEnv, setRemoteUrl } from '../lib/git.mjs';

const MAIN = { listen: { host: '127.0.0.1', port: 0 }, publicHost: null, webhookSecret: 's', keep: 5, logKeep: 50, logMaxBytes: 52428800 };

async function setup({ build = 'echo built > built.marker', deploy = 'echo deployed > deployed.marker', extra = {} } = {}) {
  const p = await makePrefix();
  const src = await makeSourceRepo();
  const sha1 = await src.commit({ 'README.md': 'a', 'mta/x.mjs': '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: build, DEPLOY: deploy, ...extra });
  const repo = await loadRepo(p, 'r');
  const targets = [];
  const ctx = { paths: p, main: MAIN, repo, now: () => new Date(), protectedTargets: () => ({ targets, reserved: false }), journal: () => {}, graceMs: 200 };
  const state = () => readState(p.repoDir('r'));
  const current = async () => path.basename(await fs.readlink(path.join(p.repoDir('r'), 'current')));
  const logs = async () => (await fs.readdir(p.repoLog('r'))).filter((n) => n !== 'events.log').sort();
  const events = async () => fs.readFile(path.join(p.repoLog('r'), 'events.log'), 'utf8');
  return { p, src, sha1, repo, ctx, targets, state, current, logs, events };
}

test('first run: fetch, build, flip, deploy, state ok', async () => {
  const t = await setup();
  const outcome = await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  assert.equal(outcome, 'ok');
  const s = await t.state();
  assert.ok(s.live.endsWith(`-${t.sha1.slice(0, 7)}`));
  assert.equal(s.previous, null);
  assert.equal(s.pending, null);
  assert.equal(s.releases[s.live].sha, t.sha1);
  assert.equal(s.last.outcome, 'ok');
  assert.equal(s.last.release, s.live);
  assert.equal(await t.current(), s.live);
  const rel = path.join(t.p.repoDir('r'), 'releases', s.live);
  assert.equal((await fs.readFile(path.join(rel, 'built.marker'), 'utf8')).trim(), 'built');
  assert.equal((await fs.readFile(path.join(rel, 'deployed.marker'), 'utf8')).trim(), 'deployed');
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /outcome: ok/);
  assert.doesNotMatch(log, /submodules:/, 'a repo without .gitmodules gets no submodule line');
  assert.match(await t.events(), /finished .* ok /);
});

test('same sha is skipped; forced run builds a second directory and keeps the first as previous', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const first = (await t.state()).live;
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'skipped');
  assert.match(await t.events(), /skipped .*already live/);
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'ok');
  const s = await t.state();
  assert.notEqual(s.live, first);
  assert.equal(s.previous, first);
  assert.equal(await t.current(), s.live);
  assert.equal((await t.logs()).length, 3, 'skip has a log too');
});

test('watch filter: ignored-only change skips, watched change builds, diff is against live', async () => {
  const t = await setup({ extra: { WATCH: 'mta/**', IGNORE: '**/*.md' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  await t.src.commit({ 'docs/n.md': 'x' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'skipped');
  await t.src.commit({ 'CHANGELOG.md': 'y' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'skipped');
  const sha4 = await t.src.commit({ 'mta/y.mjs': '2' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  assert.equal((await t.state()).releases[(await t.state()).live].sha, sha4);
});

test('build failure leaves current untouched and the directory for inspection', async () => {
  const t = await setup({ build: 'echo nope >&2; exit 7' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'build failed');
  const s = await t.state();
  assert.equal(s.live, null);
  assert.equal(s.pending, null);
  assert.equal(s.last.outcome, 'build failed');
  await assert.rejects(t.current());
  assert.equal(Object.keys(s.releases).length, 1);
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /nope/);
  assert.match(log, /exit 7/);
});

test('deploy failure: current flipped, live unchanged, pending set, webhook refused, rollback restores', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'exit 1' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'deploy failed');
  let s = await t.state();
  assert.equal(s.live, good);
  assert.equal(s.previous, null);
  assert.ok(s.pending && s.pending !== good);
  assert.equal(await t.current(), s.pending);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /flipd rollback r/);

  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'refused');
  assert.match(await t.events(), /refused/);

  const target = resolveRollbackTarget(s);
  assert.equal(target, good);
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'echo deployed > deployed.marker' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target }), 'ok');
  s = await t.state();
  assert.equal(s.live, good);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), good);
  assert.equal(s.last.trigger, 'rollback');
  assert.equal(s.last.release, good);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /target release/);
});

test('rollback after two good deploys flips to previous and swaps', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const a = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const b = (await t.state()).live;
  const target = resolveRollbackTarget(await t.state());
  assert.equal(target, a);
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target }), 'ok');
  const s = await t.state();
  assert.equal(s.live, a);
  assert.equal(s.previous, b);
  assert.equal(await t.current(), a);
});

test('rollback state update is in terms of the target when a run landed in between', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const a = (await t.state()).live;
  await t.src.commit({ 'mta/1.mjs': '1' });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const b = (await t.state()).live;
  const target = resolveRollbackTarget(await t.state());   // a, captured now
  await t.src.commit({ 'mta/2.mjs': '2' });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });   // c lands before the rollback runs
  const c = (await t.state()).live;
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target }), 'ok');
  const s = await t.state();
  assert.equal(s.live, a);
  assert.equal(s.previous, c, 'previous is what was live at execution, not b');
  assert.ok(s.releases[b], 'b is still a release');
});

test('prune runs after failures too, never touching live, previous, pending, or a queued rollback target', async () => {
  const t = await setup({ build: 'exit 1' });
  t.ctx.main = { ...MAIN, keep: 1 };
  for (let i = 0; i < 4; i++) {
    await t.src.commit({ [`f${i}`]: 'x' });
    await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  }
  let dirs = await fs.readdir(path.join(t.p.repoDir('r'), 'releases'));
  assert.equal(dirs.length, 1, 'failed builds pruned down to KEEP');
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  const a = (await t.state()).live;
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  const b = (await t.state()).live;
  t.targets.push(a);
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  dirs = await fs.readdir(path.join(t.p.repoDir('r'), 'releases'));
  assert.ok(dirs.includes(a), 'queued rollback target survives');
  const s = await t.state();
  assert.ok(dirs.includes(s.live) && dirs.includes(s.previous));
  // Deterministic, not just bounded: with KEEP=1, exactly one release beyond
  // {a (protected), live, previous} survives, and it is `b` — the most recently
  // built of the unprotected candidates, since real build timestamps strictly
  // increase and the oldest one (from the earlier failed-build loop) loses the slot.
  assert.deepEqual([...dirs].sort(), [a, b, s.previous, s.live].sort(), `exactly a, live, previous, and b survive: ${dirs}`);
});

test('REPO changed after clone is refused until set-remote', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const other = await makeSourceRepo();
  await other.commit({ a: '1' });
  await writeRepoConf(t.p, 'r', { REPO: other.url, BUILD: 'true', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'fetch failed');
  assert.match(await fs.readFile((await t.state()).last.log, 'utf8'), /REPO changed/);
});

test('two forced runs in the same second get distinct ids', async () => {
  const t = await setup();
  const fixed = new Date('2026-09-05T08:14:02Z');
  t.ctx.now = () => fixed;
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  const s = await t.state();
  assert.equal(s.live, `2026-09-05T08-14-02Z-2-${t.sha1.slice(0, 7)}`);
  assert.equal(s.previous, `2026-09-05T08-14-02Z-${t.sha1.slice(0, 7)}`);
  assert.deepEqual(await t.logs(), ['2026-09-05T08-14-02Z-2.log', '2026-09-05T08-14-02Z.log']);
});

test('output past LOG_MAX_BYTES is truncated once', async () => {
  const t = await setup({ build: 'yes | head -c 5000' });
  t.ctx.main = { ...MAIN, logMaxBytes: 1000 };
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  assert.equal((log.match(/output truncated/g) || []).length, 1);
  assert.ok(log.length < 4000);
});

test('shutdown mid-build is interrupted with current untouched; stale current.tmp is cleaned on the next attempt', async () => {
  const t = await setup({ build: 'sleep 30' });
  const ac = new AbortController();
  t.ctx.signal = ac.signal;
  setTimeout(() => ac.abort(), 300);
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'interrupted');
  assert.equal((await t.state()).pending, null);
  await fs.symlink('releases/nowhere', path.join(t.p.repoDir('r'), 'current.tmp'));
  t.ctx.signal = undefined;
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'ok');
  await assert.rejects(fs.lstat(path.join(t.p.repoDir('r'), 'current.tmp')));
});

test('an env file cannot replace PATH or a DEPLOY_* variable', async () => {
  const t = await setup({ build: 'echo "$PATH|$DEPLOY_NAME|$MINE|$DEPLOY_FUTURE" > build.out' });
  // DEPLOY_FUTURE is the whole point of the prefix rule: the spec forbids an env
  // file setting *any* name beginning DEPLOY_, "whether or not flipd uses
  // it today", so that a variable added in a later version cannot be one an env
  // file has already been silently supplying. Object.hasOwn covers only the
  // eight names set today, so without the startsWith arm this line is the only
  // thing that fails.
  await fs.writeFile(t.p.envFile('r', 'build'), 'PATH=/evil\nDEPLOY_NAME=x\nMINE=ok\nDEPLOY_FUTURE=x\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const s = await t.state();
  const out = (await fs.readFile(path.join(t.p.repoDir('r'), 'releases', s.live, 'build.out'), 'utf8')).trim();
  assert.equal(out, '/usr/local/bin:/usr/bin:/bin|r|ok|', 'DEPLOY_FUTURE never reaches the command');
  assert.match(await fs.readFile(s.last.log, 'utf8'), /refused PATH DEPLOY_NAME DEPLOY_FUTURE/);
});

test('a malformed deploy env file after the flip is a deploy failure with the rollback line', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  await t.src.commit({ 'mta/q.mjs': '9' });
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'garbage\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'deploy failed');
  const s = await t.state();
  assert.ok(s.pending);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /next: flipd rollback r/);
});

test('a confirmed deploy is final on disk the instant it is confirmed, not merely by the time runEntry returns', async () => {
  // The truthful-`interrupted` promise: startup reads a null last.finished as
  // "the service died inside this attempt", so a crash between DEPLOY exiting
  // zero and close() must not be able to relabel a confirmed deploy as
  // interrupted. That requires the confirmation and the finalisation of `last`
  // to be one write, which nothing tested — moving them apart killed no test.
  // prune is the first thing that happens after deploy() returns, so its call to
  // ctx.protectedTargets is the earliest observable moment after the
  // confirmation; reading state.json there reads what a crash at that instant
  // would leave behind.
  const t = await setup();
  let atConfirm = null;
  t.ctx.protectedTargets = () => { atConfirm ??= readState(t.p.repoDir('r')); return { targets: [], reserved: false }; };
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const snap = await atConfirm;
  assert.ok(snap, 'prune ran, so the snapshot was taken');
  assert.equal(snap.pending, null, 'pending is cleared in that same write');
  assert.ok(snap.live, 'live names the confirmed release');
  assert.equal(snap.last.outcome, 'ok');
  assert.ok(snap.last.finished, 'last.finished is already non-null: a crash here reads as ok, not as interrupted');
});

test('state.last is on disk from the moment an attempt opens', async () => {
  const t = await setup({ build: 'sleep 30' });
  const ac = new AbortController();
  t.ctx.signal = ac.signal;
  const running = runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  await new Promise((r) => setTimeout(r, 800));
  const mid = await t.state();
  assert.ok(mid.last && mid.last.finished === null, 'open attempt is visible with finished=null');
  ac.abort();
  assert.equal(await running, 'interrupted');
  assert.ok((await t.state()).last.finished);
});

test('an empty commit builds even with WATCH set; ON_FAILURE runs after a failure and cannot change it', async () => {
  const t = await setup({ extra: { WATCH: 'mta/**' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const first = (await t.state()).live;
  await t.src.commit({}, 'redeploy');   // empty commit
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  assert.notEqual((await t.state()).live, first);

  const marker = path.join(t.p.repoDir('r'), 'notified.txt');
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'exit 9', DEPLOY: 'true', ON_FAILURE: `echo "$DEPLOY_NAME $DEPLOY_OUTCOME $DEPLOY_ATTEMPT_ID" > ${marker}; exit 5` });
  t.ctx.repo = await loadRepo(t.p, 'r');
  await t.src.commit({ 'mta/z.mjs': 'z' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'build failed');
  const s = await t.state();
  assert.equal((await fs.readFile(marker, 'utf8')).trim(), `r build failed ${s.last.attempt}`);
  assert.match(await t.events(), /notified .* exit 5/);
  assert.equal(s.last.outcome, 'build failed');
});

test('shutdown after BUILD does not flip: no new pending during a stop', async () => {
  const t = await setup({ build: 'sleep 1' });
  const ac = new AbortController();
  t.ctx.signal = ac.signal;
  setTimeout(() => ac.abort(), 300);   // lands during BUILD; the killed build reports interrupted
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'interrupted');
  assert.equal((await t.state()).pending, null);
  await assert.rejects(t.current());
  // And an abort that lands after BUILD finished but before flip: same answer.
  // Depends on exactly two ctx.now() calls happening before this one: openAttemptLog's
  // own id-generation call, then `started = now()` — making the checkout's
  // `built: now().toISOString()` the third. If lib/log.mjs ever calls `now()` more
  // than once while opening an attempt, this abort silently lands somewhere else
  // (most likely inside the id-collision retry loop) and stops testing this race.
  const t2 = await setup({ build: 'true' });
  const ac2 = new AbortController();
  t2.ctx.signal = ac2.signal;
  const origNow = t2.ctx.now;
  let calls = 0;
  t2.ctx.now = () => { if (++calls === 3) ac2.abort(); return origNow(); };   // built time is the third call, just before flip
  assert.equal(await runEntry(t2.ctx, { kind: 'webhook', name: 'r' }), 'interrupted');
  assert.equal((await t2.state()).pending, null);
});

test('a webhook entry records the repository id, and prune is deferred while a rollback is reserved', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r', githubId: 4242 });
  assert.equal((await t.state()).github_id, 4242);
  await t.src.commit({ 'mta/w.mjs': 'w' });   // a same-sha webhook is 'skipped' and builds nothing (see the skip test above)
  await runEntry(t.ctx, { kind: 'webhook', name: 'r', githubId: 1 });
  assert.equal((await t.state()).github_id, 4242, 'first id wins');
  t.ctx.main = { ...MAIN, keep: 0 };
  t.ctx.protectedTargets = () => ({ targets: [], reserved: true });
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  const s = await t.state();
  assert.match(await fs.readFile(s.last.log, 'utf8'), /prune deferred/);
  assert.ok(Object.keys(s.releases).length >= 3, 'nothing pruned while reserved');
});

test('ON_FAILURE output is masked before it reaches events.log', async () => {
  const t = await setup({ build: 'exit 1', extra: { ON_FAILURE: 'echo "leak=$TOK_D"' } });
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'TOK_D=deploysecret99\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const ev = await t.events();
  assert.match(ev, /notified .* exit 0  leak=\*\*\*/);
  assert.ok(!ev.includes('deploysecret99'));
});

test('a secret from an env file is masked when BUILD echoes it', async () => {
  const t = await setup({ build: 'echo "token=$TOK"; env | grep TOK' });
  await fs.writeFile(t.p.envFile('r', 'build'), 'TOK=verysecretvalue123\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  assert.ok(!log.includes('verysecretvalue123'));
  assert.match(log, /token=\*\*\*/);
});

test('env files reach only their phase, and the log lists key names not values', async () => {
  const t = await setup({ build: 'echo "B=$TOK_B D=$TOK_D" > build.out', deploy: 'echo "B=$TOK_B D=$TOK_D" > deploy.out' });
  // At least 8 characters (the mask's own length floor) so this line actually
  // exercises masking rather than passing merely because a 7-char value was
  // never going to be found in the log regardless of whether it was masked.
  await fs.writeFile(t.p.envFile('r', 'build'), 'TOK_B=secretbbbb\n');
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'TOK_D=secretdddd\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const s = await t.state();
  const rel = path.join(t.p.repoDir('r'), 'releases', s.live);
  assert.equal((await fs.readFile(path.join(rel, 'build.out'), 'utf8')).trim(), 'B=secretbbbb D=');
  assert.equal((await fs.readFile(path.join(rel, 'deploy.out'), 'utf8')).trim(), 'B= D=secretdddd');
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /build env.*TOK_B/);
  assert.ok(!log.includes('secretbbbb') && !log.includes('secretdddd'));
});

test('a live sha unreachable in the clone (a force-push, or one pruned away) falls through to build rather than wedging', async () => {
  const t = await setup({ extra: { WATCH: 'mta/**' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const dir = t.p.repoDir('r');
  // Simulate what a force-push eventually produces: the recorded live sha is
  // no longer an object the bare clone can compare against at all (whether
  // because it was pruned out after becoming unreachable, or never fetched).
  const before = await readState(dir);
  before.releases[before.live].sha = '0'.repeat(40);
  await writeState(dir, before);
  const sha2 = await t.src.commit({ 'mta/z.mjs': 'z' });
  const outcome = await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  assert.equal(outcome, 'ok', 'cannot compare -> build, not a wedged fetch failure');
  const s = await t.state();
  assert.equal(s.releases[s.live].sha, sha2);
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /cannot compare against live/);
  assert.ok(!log.includes('at async'), 'no stack trace journalled for a routine comparison failure');
  // And it does not keep failing: the next push is unaffected, no wedge.
  await t.src.commit({ 'mta/z2.mjs': 'z2' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
});

test('an env-file key that shadows an Object.prototype member is not falsely refused', async () => {
  const t = await setup({ build: 'echo "$toString|$hasOwnProperty|$constructor" > proto.out' });
  await fs.writeFile(t.p.envFile('r', 'build'), 'toString=a\nhasOwnProperty=b\nconstructor=c\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  const out = (await fs.readFile(path.join(t.p.repoDir('r'), 'releases', s.live, 'proto.out'), 'utf8')).trim();
  assert.equal(out, 'a|b|c');
  assert.doesNotMatch(await fs.readFile(s.last.log, 'utf8'), /refused/);
});

test('an env-file key of __proto__ is refused rather than merged into the environment object', async () => {
  const t = await setup({ build: 'node -e "console.log(Object.getPrototypeOf(process.env) === null)" > proto.out' });
  await fs.writeFile(t.p.envFile('r', 'build'), '__proto__=polluted\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  assert.match(await fs.readFile(s.last.log, 'utf8'), /refused __proto__/);
});

test('ON_FAILURE output masks a build secret too, not only this attempt\'s deploy env', async () => {
  const t = await setup({
    build: 'echo "token=$TOK_B" > build.out; exit 1',
    extra: { ON_FAILURE: 'cat "$DEPLOY_RELEASE_DIR/build.out"' },
  });
  await fs.writeFile(t.p.envFile('r', 'build'), 'TOK_B=buildsecret9999\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'build failed');
  const ev = await t.events();
  assert.ok(!ev.includes('buildsecret9999'), 'a build secret surfaced via ON_FAILURE must still be masked');
  assert.match(ev, /notified .* exit 0  token=\*\*\*/);
});

test('runOnFailure masks the error message on its failure path too, not only the notifier\'s output', async () => {
  // runOnFailure writes to events.log twice: once with the notifier's output,
  // which has always been scrubbed, and once — from its catch arm — with the
  // message of whatever went wrong instead. That second line is the one sink in
  // this module a secret could still reach.
  //
  // The failure is injected rather than provoked, deliberately: the realistic
  // throws in this try (a spawn that fails, a missing directory) carry paths in
  // their messages, not env values, so provoking one would test that the
  // scrubber ran on text with nothing to find. What has to hold is the general
  // property — an error message that quotes something masked is masked before it
  // is written — so the injected message quotes exactly that.
  const t = await setup();
  const secret = 'deploysecret99';
  const repo = { ...t.repo, onFailure: 'true' };
  const paths = { ...t.p, repoDir: () => { throw new Error(`cannot open the working directory for ${secret}`); } };
  await runOnFailure({ paths, journal: () => {} }, repo, {
    attemptId: 'injected-attempt', outcome: 'build failed', sha: null, releaseId: null, logFile: null,
    envFile: new Map([['TOK_D', secret]]), mask: [secret],
  });
  const ev = await t.events();
  assert.match(ev, /notified injected-attempt failed to run: cannot open the working directory for \*\*\*/);
  assert.ok(!ev.includes(secret), 'the catch arm masks before it writes, like the success arm');
});

test('prune\'s worktree removal carries the shutdown signal: it is interrupted, not run to completion', async () => {
  // prune runs inside the work close() drains, so its git calls must be
  // abortable. The observable difference between an aborted removal and a
  // completed one is the bare clone's worktree admin directory: `git worktree
  // remove` deletes <gitDir>/worktrees/<id>, and a removal killed before it gets
  // there leaves that entry behind for the next attempt's `worktree prune`.
  const t = await setup();
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });   // a: becomes live
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });   // b: live, a is previous
  const doomed = (await t.state()).previous;              // a: about to lose its protection
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });   // c: live, b previous, a a candidate
  const admin = path.join(t.p.repoDir('r'), 'git', 'worktrees');
  assert.ok((await fs.readdir(admin)).includes(doomed), 'the clone knows about that worktree to begin with');

  // Now a shutdown: the attempt itself is interrupted before it builds anything,
  // and step 7 still prunes — with the signal already aborted.
  const ac = new AbortController();
  ac.abort();
  t.ctx.signal = ac.signal;
  t.ctx.main = { ...MAIN, keep: 0 };
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'interrupted');
  await assert.rejects(fs.stat(path.join(t.p.repoDir('r'), 'releases', doomed)), 'the directory is removed either way');
  assert.ok((await fs.readdir(admin)).includes(doomed), 'the removal was killed by the shutdown signal rather than completing');

  // And it is transient, not a leak: the next attempt's `worktree prune` clears it.
  t.ctx.signal = undefined;
  await runEntry(t.ctx, { kind: 'manual', name: 'r' });
  assert.ok(!(await fs.readdir(admin)).includes(doomed), 'the next attempt clears the stale admin entry');
});

test('a malformed env line is not echoed verbatim into the attempt log', async () => {
  const t = await setup();
  await fs.writeFile(t.p.envFile('r', 'build'), 'thisisasecretlookingvalue\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'build failed');
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  assert.ok(!log.includes('thisisasecretlookingvalue'));
  assert.match(log, /env file: line 1/);
});

test('the run path bounds its git calls: a fetch that outlives the timeout is a fetch failure, not a hung queue', async () => {
  // Until this, gitOpts carried no timeoutMs at all, so git() ran with no timer:
  // a stalled fetch never settled, runEntry never returned, and every other repo
  // starved behind a queue slot that could only be cleared by a restart. One
  // millisecond stands in for the ten-minute production cap; no real clone,
  // however small, beats a timer armed before the process is even spawned.
  const t = await setup();
  t.ctx.gitTimeoutMs = 1;
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'fetch failed');
  assert.match(await fs.readFile((await t.state()).last.log, 'utf8'), /timed out after 1ms/);
  // And it is a bounded failure, not a wedge: with the cap back to normal the
  // very next attempt succeeds.
  t.ctx.gitTimeoutMs = undefined;
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'ok');
});

test('a credential left in the clone\'s origin is redacted in every sink, not just the terminal', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  // A clone created before REPO refused credentials — or by hand — can still
  // hold a token in its stored origin. The REPO-changed refusal names that
  // origin, and that detail reaches the terminal, the attempt log, and
  // events.log, the one log flipd never prunes.
  const gitDir = path.join(t.p.repoDir('r'), 'git');
  const gopts = { env: gitEnv({ key: '/nonexistent/key', knownHosts: t.p.knownHosts, home: t.p.lib }) };
  await setRemoteUrl(gitDir, 'https://x-access-token:ghp_TOPSECRETTOKEN@127.0.0.1:1/o/r.git', gopts);
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'fetch failed');
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  const ev = await t.events();
  for (const [where, text] of [['the attempt log', log], ['events.log', ev]]) {
    assert.ok(!text.includes('ghp_TOPSECRETTOKEN'), `the credential must not reach ${where}`);
  }
  assert.match(log, /clone has https:\/\/\*\*\*@127\.0\.0\.1:1\/o\/r\.git/);
  assert.match(ev, /fetch-failed .*clone has https:\/\/\*\*\*@/);
});

test('check redacts a credential left in the clone\'s stored origin before printing its rows', async () => {
  // The same defect as the test above, in the other command that prints what
  // `git remote get-url` returned. check's rows go straight to the operator's
  // terminal, and config's refusal cannot reach a clone that was created before
  // that refusal existed.
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const gitDir = path.join(t.p.repoDir('r'), 'git');
  const gopts = { env: gitEnv({ key: '/nonexistent/key', knownHosts: t.p.knownHosts, home: t.p.lib }) };
  await setRemoteUrl(gitDir, 'https://x-access-token:ghp_TOPSECRETTOKEN@127.0.0.1:1/o/r.git', gopts);
  const r = await runCheck({ paths: t.p, repo: t.repo, journal: () => {} }, {});
  const text = r.rows.map(([k, v]) => `${k} ${v}`).join('\n');
  assert.equal(r.passed, false, 'a mismatched remote is a failed row');
  assert.match(text, /MISMATCH {2}clone has https:\/\/\*\*\*@127\.0\.0\.1:1\/o\/r\.git/);
  assert.ok(!text.includes('ghp_TOPSECRETTOKEN'), `the credential must not reach check's rows: ${text}`);
});

test('a masked value in a fetch-failure detail is masked in events.log too, not only in the attempt log', async () => {
  // events.log and the attempt log are two sinks for the same text, and only
  // one of them used to mask. The detail for a fetch failure is git's own argv,
  // which carries config values; when one of those is also an env-file value,
  // both sinks have to mask it, through the same scrubber.
  const t = await setup({ extra: { BRANCH: 'secretbranchvalue123' } });
  await fs.writeFile(t.p.envFile('r', 'build'), 'TOK=secretbranchvalue123\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'fetch failed');
  const ev = await t.events();
  assert.match(ev, /fetch-failed .* fetch failed /);
  assert.match(ev, /refs\/heads\/\*\*\*/, 'the detail is there, with the masked value replaced');
  assert.ok(!ev.includes('secretbranchvalue123'), 'events.log is masked like the attempt log');
  assert.ok(!(await fs.readFile((await t.state()).last.log, 'utf8')).includes('secretbranchvalue123'));
});

test('an unreadable state.json ends the attempt visibly, writes nothing over it, and leaves the releases alone', async () => {
  const t = await setup({ extra: { ON_FAILURE: 'true' } });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const stateFile = path.join(t.p.repoDir('r'), 'state.json');
  const live = JSON.parse(await fs.readFile(stateFile, 'utf8')).live;
  await fs.writeFile(stateFile, '{ truncated');

  // Unguarded, this threw out of runEntry into queue.onError, which journals
  // `crashed` and nothing else: no attempt log, no events.log line, no
  // state.last, so the repo was silently dead while status went on showing the
  // last successful run.
  const outcome = await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  assert.equal(outcome, 'fetch failed', 'an attempt that ended at its first step with nothing on disk changed');
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{ truncated', 'the damaged file is left for whoever repairs it, never overwritten');
  await fs.stat(path.join(t.p.repoDir('r'), 'releases', live));
  assert.match(await t.events(), /fetch-failed .*state\.json is unreadable/);
  assert.match(await t.events(), /notified .* exit 0/, 'ON_FAILURE runs, as it does for every other non-ok outcome');
  // Found by content, not by taking the last name: setup()'s logs() sorts
  // lexicographically, and within one second "<id>-2.log" sorts *before*
  // "<id>.log" ('-' < '.'), so "the newest" is whichever second the two attempts
  // happened to land in.
  const texts = await Promise.all((await t.logs()).map((n) => fs.readFile(path.join(t.p.repoLog('r'), n), 'utf8')));
  assert.equal(texts.length, 2, 'the failed attempt opened a log of its own');
  const failed = texts.find((x) => /state\.json is unreadable/.test(x));
  assert.ok(failed, 'and that log says what happened');
  assert.match(failed, /outcome: fetch failed  state\.json is unreadable/);
  assert.match(failed, /next: repair or move aside .*state\.json/);
});

test('rollback to a release whose directory is missing fails cleanly without flipping current or setting pending', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const later = (await t.state()).live;
  // Removed out-of-band: still tracked in state, but no longer on disk.
  await fs.rm(path.join(t.p.repoDir('r'), 'releases', good), { recursive: true, force: true });
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target: good }), 'deploy failed');
  const s = await t.state();
  assert.equal(s.live, later, 'live is untouched');
  assert.equal(s.pending, null, 'no dangling pending');
  assert.equal(await t.current(), later, 'current was never flipped to the missing release');
  await assert.rejects(fs.lstat(path.join(t.p.repoDir('r'), 'current.tmp')), 'no stray tmp symlink left behind');
});

test('a checkout with .gitmodules initialises submodules over the same key; the log says so', async () => {
  const t = await setup();
  const sub = await makeSourceRepo();
  await sub.commit({ 'inside.txt': 'from the submodule' });
  // git >= 2.38.1 refuses file:// transport inside submodule recursion unless
  // protocol.file.allow=always. The source repo's own `submodule add` is told
  // on the command line. flipd's `submodule update` reads $HOME/.gitconfig
  // and nothing system-wide (gitEnv sets HOME to p.lib and GIT_CONFIG_SYSTEM
  // to /dev/null), so the test writes the setting there — no seam in the
  // service, and no /etc/gitconfig on the box can change the result.
  await t.src.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.url, 'sub');
  await t.src.commit({}, 'add submodule');
  await fs.writeFile(path.join(t.p.lib, '.gitconfig'), '[protocol "file"]\n\tallow = always\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  const rel = path.join(t.p.repoDir('r'), 'releases', s.live);
  assert.equal(await fs.readFile(path.join(rel, 'sub', 'inside.txt'), 'utf8'), 'from the submodule');
  assert.match(await fs.readFile(s.last.log, 'utf8'), /submodules: \.gitmodules present/);
});

test('a submodule that cannot be fetched is checkout failed, with live and current untouched', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });   // a live release to protect
  const first = (await t.state()).live;
  const sub = await makeSourceRepo();
  await sub.commit({ 'inside.txt': 'x' });
  await t.src.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.url, 'sub');
  await t.src.commit({}, 'add submodule');
  await fs.rm(sub.dir, { recursive: true, force: true });   // .gitmodules now points at nothing
  await fs.writeFile(path.join(t.p.lib, '.gitconfig'), '[protocol "file"]\n\tallow = always\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'checkout failed');
  const s = await t.state();
  assert.equal(s.live, first);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), first);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /outcome: checkout failed/);
  assert.match(await t.events(), /finished .* checkout failed/);
});

test('a submodule URL with userinfo is redacted in the attempt log, both streamed and in the failure detail', async () => {
  const t = await setup();
  // .gitmodules is repo content, not REPO, so it carries no guard against
  // userinfo. Written and staged by hand: `submodule add` refuses a URL it
  // cannot reach, but a gitlink entry (mode 160000) needs no real object —
  // git never resolves it until `submodule update` tries to clone.
  await fs.writeFile(path.join(t.src.dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = https://tokenabc123@127.0.0.1:1/o/r.git\n');
  await t.src.git('add', '.gitmodules');
  await t.src.git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`);
  await t.src.git('commit', '-q', '-m', 'add unreachable, credentialed submodule');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'checkout failed');
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  assert.doesNotMatch(log, /tokenabc123/, 'the credential must not reach the attempt log');
  assert.match(log, /\*\*\*@127\.0\.0\.1:1/, 'the redacted form of the url is still visible');
});

test('STOP exit 0 runs after BUILD and before the flip, then flip and deploy proceed', async () => {
  const t = await setup({ extra: { STOP: 'echo stopped > "$DEPLOY_RELEASE_DIR/stopped.marker"' } });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  assert.ok(s.live);
  assert.equal(await t.current(), s.live);
  const log = await fs.readFile(s.last.log, 'utf8');
  const at = (re) => { const m = re.exec(log); assert.ok(m, `${re} in log`); return m.index; };
  assert.ok(at(/step build done/) < at(/step stop\n/), 'stop starts after build finished');
  assert.ok(at(/step stop done/) < at(/step flip\n/), 'flip starts after stop finished');
  assert.match(log, /stop: echo stopped/);
  assert.match(log, /stop exit 0/);
  assert.match(log, /exit codes: build=0 stop=0 deploy=0/);
});

test('STOP non-zero is stop failed: nothing flipped, no pending, release kept, ON_FAILURE told', async () => {
  const marker = path.join(await tmpdir('flipd-stop'), 'notified.txt');
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = await t.state();
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'echo still busy >&2; exit 3', DEPLOY: 'echo deployed > deployed.marker', ON_FAILURE: `echo "$DEPLOY_OUTCOME" > ${marker}` });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'stop failed');
  const s = await t.state();
  assert.equal(s.live, good.live);
  assert.equal(s.previous, good.previous);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), good.live);
  assert.equal(s.last.outcome, 'stop failed');
  assert.ok(s.last.release && s.last.release !== good.live, 'the built release is recorded');
  await fs.stat(path.join(t.p.repoDir('r'), 'releases', s.last.release));   // kept for inspection
  await assert.rejects(fs.stat(path.join(t.p.repoDir('r'), 'releases', s.last.release, 'deployed.marker')), 'DEPLOY never ran');
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /still busy/);
  assert.match(log, /stop exit 3/);
  assert.match(log, /outcome: stop failed  STOP exited 3/);
  assert.match(log, /next: fix, push, or flipd run r/);
  assert.doesNotMatch(log, /step flip/);
  assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'stop failed');
  assert.match(await t.events(), /finished .* stop failed /);
});

test('STOP past TIMEOUT is stop failed with the timeout recorded, and nothing flipped', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'sleep 30', DEPLOY: 'true', TIMEOUT: '1' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'stop failed');
  const s = await t.state();
  assert.equal(s.live, good);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), good);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /stop exit timeout after 1s/);
});

test('no STOP key: no stop step in the log', async () => {
  const t = await setup();
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const log = await fs.readFile((await t.state()).last.log, 'utf8');
  assert.doesNotMatch(log, /step stop/);
  assert.match(log, /exit codes: build=0 deploy=0/);
});

test('a malformed deploy env file with STOP set is stop failed, not deploy failed, and nothing is flipped', async () => {
  const t = await setup({ extra: { STOP: 'true' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/q.mjs': '9' });
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'garbage\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'stop failed');
  const s = await t.state();
  assert.equal(s.pending, null);
  assert.equal(s.live, good);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /outcome: stop failed  env file: line 1/);
});

test('STOP runs in the release current points at, under its recorded ROOT, and names both releases', async () => {
  // Release 1 has ROOT=mta. Release 2 changes ROOT to `.`, so the two cwds
  // differ in a way the STOP script can report: on the second attempt, STOP
  // must run in release 1's `mta`, not in release 2's root.
  const t = await setup({ extra: { ROOT: 'mta', STOP: 'true' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const first = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  const out = path.join(t.p.repoDir('r'), 'stop-cwd.txt');
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, ROOT: '.', BUILD: 'true', STOP: `printf '%s\\n%s\\n%s\\n%s\\n' "$PWD" "$DEPLOY_CURRENT_RELEASE_ID" "$DEPLOY_CURRENT_RELEASE_DIR" "$DEPLOY_RELEASE_ID" > ${out}`, DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  const [cwd, curId, curDir, targetId] = (await fs.readFile(out, 'utf8')).trim().split('\n');
  const firstDir = path.join(t.p.repoDir('r'), 'releases', first);
  assert.equal(await fs.realpath(cwd), await fs.realpath(path.join(firstDir, 'mta')));
  assert.equal(curId, first);
  assert.equal(curDir, firstDir);
  assert.equal(targetId, s.live);
  assert.notEqual(targetId, first);
});

test('first deploy: STOP runs in the target release with the DEPLOY_CURRENT_* variables empty', async () => {
  const out = path.join(await tmpdir('flipd-stop'), 'first.txt');
  const t = await setup({ extra: { STOP: `printf '%s|%s|%s\\n' "$PWD" "$DEPLOY_CURRENT_RELEASE_ID" "$DEPLOY_CURRENT_RELEASE_DIR" > ${out}` } });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  const s = await t.state();
  const [cwd, curId, curDir] = (await fs.readFile(out, 'utf8')).trim().split('|');
  assert.equal(await fs.realpath(cwd), await fs.realpath(path.join(t.p.repoDir('r'), 'releases', s.live)));
  assert.equal(curId, '');
  assert.equal(curDir, '');
});

test('current pointing at a release state does not know is stop failed, with nothing flipped', async () => {
  const t = await setup({ extra: { STOP: 'true' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  // Forge the situation: a release directory nobody registered, and current on it.
  const ghost = path.join(t.p.repoDir('r'), 'releases', 'ghost');
  await fs.mkdir(ghost, { recursive: true });
  const cur = path.join(t.p.repoDir('r'), 'current');
  await fs.rm(cur);
  await fs.symlink('releases/ghost', cur);
  await t.src.commit({ 'mta/z.mjs': '3' });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'stop failed');
  const s = await t.state();
  assert.equal(s.live, good);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), 'ghost', 'current is left exactly as found');
  assert.match(await fs.readFile(s.last.log, 'utf8'), /outcome: stop failed  current points at ghost/);
});

test('rollback runs STOP before the flip, in the release current points at (the pending one)', async () => {
  const t = await setup({ extra: { STOP: 'true' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'true', DEPLOY: 'exit 1' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'deploy failed');
  const pending = (await t.state()).pending;
  assert.ok(pending);
  const out = path.join(t.p.repoDir('r'), 'rb-stop.txt');
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: `printf '%s|%s\\n' "$DEPLOY_CURRENT_RELEASE_ID" "$DEPLOY_RELEASE_ID" > ${out}`, DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target: good }), 'ok');
  const [curId, targetId] = (await fs.readFile(out, 'utf8')).trim().split('|');
  assert.equal(curId, pending, 'STOP addressed the pending release, whose process is the one running');
  assert.equal(targetId, good);
  const s = await t.state();
  assert.equal(s.live, good);
  assert.equal(s.pending, null);
  const log = await fs.readFile(s.last.log, 'utf8');
  const at = (re) => { const m = re.exec(log); assert.ok(m, `${re} in log`); return m.index; };
  assert.ok(at(/step stop done/) < at(/step flip\n/));
});

test('an env file cannot set DEPLOY_CURRENT_RELEASE_ID either', async () => {
  const out = path.join(await tmpdir('flipd-stop'), 'refused.txt');
  const t = await setup({ extra: { STOP: `echo "$DEPLOY_CURRENT_RELEASE_ID" > ${out}` } });
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'DEPLOY_CURRENT_RELEASE_ID=forged\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'ok');
  assert.equal((await fs.readFile(out, 'utf8')).trim(), '');
  assert.match(await fs.readFile((await t.state()).last.log, 'utf8'), /stop env: refused DEPLOY_CURRENT_RELEASE_ID/);
});

test('STOP failing on a manual run started from pending leaves pending as it was, with the rollback line', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'exit 1' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'deploy failed');
  const pending = (await t.state()).pending;
  assert.ok(pending);
  // The operator's recovery attempt: a manual run, allowed from pending, whose STOP refuses.
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'exit 1', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'stop failed');
  const s = await t.state();
  assert.equal(s.pending, pending, 'pending is unchanged, not cleared and not moved');
  assert.equal(s.live, good);
  assert.equal(await t.current(), pending);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /next: flipd rollback r/);
});

test('STOP failing on a rollback started from pending leaves pending as it was', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = (await t.state()).live;
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', DEPLOY: 'exit 1' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const pending = (await t.state()).pending;
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'exit 1', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target: good }), 'stop failed');
  const s = await t.state();
  assert.equal(s.pending, pending);
  assert.equal(s.live, good);
  assert.equal(await t.current(), pending);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /next: flipd rollback r/);
});

test('shutdown during STOP is interrupted with current and state untouched', async () => {
  const t = await setup({ extra: { STOP: 'true' } });
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const good = await t.state();
  await t.src.commit({ 'mta/z.mjs': '3' });
  await writeRepoConf(t.p, 'r', { REPO: t.src.url, BUILD: 'true', STOP: 'sleep 30', DEPLOY: 'true' });
  t.ctx.repo = await loadRepo(t.p, 'r');
  const ac = new AbortController();
  t.ctx.signal = ac.signal;
  // The clone already exists, so fetch, checkout and a `true` BUILD are quick,
  // but not instantly quick on a loaded machine. 3 s is comfortably after them
  // and comfortably inside STOP's 30 s sleep: the abort must land in STOP, or
  // this test silently starts testing an interrupted checkout instead.
  setTimeout(() => ac.abort(), 3000);
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'interrupted');
  const s = await t.state();
  assert.equal(s.live, good.live);
  assert.equal(s.pending, null);
  assert.equal(await t.current(), good.live);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /stop interrupted by service shutdown/);
});

test('--now on a manual run and on a rollback skips STOP, says so, and flips', async () => {
  const t = await setup({ extra: { STOP: 'exit 1' } });
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r', now: true }), 'ok');
  let s = await t.state();
  const first = s.live;
  let log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /stop skipped: --now/);
  assert.doesNotMatch(log, /step stop/);
  await t.src.commit({ 'mta/z.mjs': '3' });
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r', now: true }), 'ok');
  s = await t.state();
  assert.equal(s.previous, first);
  assert.equal(await runEntry(t.ctx, { kind: 'rollback', name: 'r', target: first, now: true }), 'ok');
  s = await t.state();
  assert.equal(s.live, first);
  log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /stop skipped: --now/);
});

test('a stray now field on a webhook entry does not skip STOP', async () => {
  const t = await setup({ extra: { STOP: 'exit 1' } });
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r', now: true }), 'stop failed');
  assert.doesNotMatch(await fs.readFile((await t.state()).last.log, 'utf8'), /stop skipped/);
});

test('--now with no STOP set changes nothing and logs nothing', async () => {
  const t = await setup();
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r', now: true }), 'ok');
  assert.doesNotMatch(await fs.readFile((await t.state()).last.log, 'utf8'), /stop skipped|step stop/);
});

test('via labels the attempt for a reader everywhere the kind used to, on the normal path and through an unreadable state', async () => {
  const t = await setup();
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r', via: 'ssh' }), 'ok');
  let s = await t.state();
  assert.equal(s.last.trigger, 'ssh');
  assert.match(await fs.readFile(s.last.log, 'utf8'), /trigger=ssh/);
  assert.match(await t.events(), /started \S+ ssh /);
  // An entry with no via is unchanged.
  assert.equal(await runEntry(t.ctx, { kind: 'manual', name: 'r' }), 'ok');
  s = await t.state();
  assert.equal(s.last.trigger, 'manual');
  // The unreadable-state path opens its own attempt log and events line; the
  // label must be the same there — this path is reachable when state.json goes
  // bad between the handler's pre-check and the worker.
  await fs.writeFile(path.join(t.p.repoDir('r'), 'state.json'), '{ truncated');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r', via: 'ssh' }), 'fetch failed');
  const texts = await Promise.all((await t.logs()).map((n) => fs.readFile(path.join(t.p.repoLog('r'), n), 'utf8')));
  const failed = texts.find((x) => /state\.json is unreadable/.test(x));
  assert.ok(failed, 'the failed attempt has a log');
  assert.match(failed, /trigger=ssh/);
  assert.equal((await t.events()).match(/started \S+ ssh /g).length, 2, 'both ssh attempts are labelled in events.log');
});
