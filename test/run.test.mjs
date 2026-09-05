// test/run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePrefix, makeSourceRepo, writeRepoConf } from './helpers.mjs';
import { loadRepo } from '../lib/config.mjs';
import { readState } from '../lib/state.mjs';
import { runEntry, resolveRollbackTarget } from '../lib/run.mjs';

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
  assert.match(await fs.readFile(s.last.log, 'utf8'), /remote-deploy rollback r/);

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
  assert.ok(dirs.length <= 5, `a, live, previous, and at most KEEP=1 other: ${dirs}`);
  assert.ok(b === s.previous || dirs.includes(b) || dirs.length <= 4);
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
  const t = await setup({ build: 'echo "$PATH|$DEPLOY_NAME|$MINE" > build.out' });
  await fs.writeFile(t.p.envFile('r', 'build'), 'PATH=/evil\nDEPLOY_NAME=x\nMINE=ok\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const s = await t.state();
  const out = (await fs.readFile(path.join(t.p.repoDir('r'), 'releases', s.live, 'build.out'), 'utf8')).trim();
  assert.equal(out, '/usr/local/bin:/usr/bin:/bin|r|ok');
  assert.match(await fs.readFile(s.last.log, 'utf8'), /refused PATH DEPLOY_NAME/);
});

test('a malformed deploy env file after the flip is a deploy failure with the rollback line', async () => {
  const t = await setup();
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  await t.src.commit({ 'mta/q.mjs': '9' });
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'garbage\n');
  assert.equal(await runEntry(t.ctx, { kind: 'webhook', name: 'r' }), 'deploy failed');
  const s = await t.state();
  assert.ok(s.pending);
  assert.match(await fs.readFile(s.last.log, 'utf8'), /next: remote-deploy rollback r/);
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
  await fs.writeFile(t.p.envFile('r', 'build'), 'TOK_B=secretb\n');
  await fs.writeFile(t.p.envFile('r', 'deploy'), 'TOK_D=secretd\n');
  await runEntry(t.ctx, { kind: 'webhook', name: 'r' });
  const s = await t.state();
  const rel = path.join(t.p.repoDir('r'), 'releases', s.live);
  assert.equal((await fs.readFile(path.join(rel, 'build.out'), 'utf8')).trim(), 'B=secretb D=');
  assert.equal((await fs.readFile(path.join(rel, 'deploy.out'), 'utf8')).trim(), 'B= D=secretd');
  const log = await fs.readFile(s.last.log, 'utf8');
  assert.match(log, /build env.*TOK_B/);
  assert.ok(!log.includes('secretb') && !log.includes('secretd'));
});
