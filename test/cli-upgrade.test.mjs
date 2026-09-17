import test from 'node:test';
import assert from 'node:assert/strict';
import upgrade, { parseSystemdShow, checkClone, readUnit, checkUnitClone, SHOW_ARGS, probeService, waitForIdle, takeRoot, restartArgv, proveAlive, pull, partialUpgradeNote, INSTALLER_ARTIFACTS } from '../lib/cli/upgrade.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function capture() {
  const out = [];
  const err = [];
  return {
    out, err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    text: () => out.join(''),
    errText: () => err.join(''),
  };
}

test('parseSystemdShow reads labelled properties and the ExecStart path', () => {
  const out = [
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'MainPID=1234',
    'ExecStart={ path=/opt/flipd/bin/flipd ; argv[]=/opt/flipd/bin/flipd serve ; ignore_errors=no ; start_time=[n/a] ; pid=0 }',
  ].join('\n');
  const u = parseSystemdShow(out);
  assert.equal(u.loadState, 'loaded');
  assert.equal(u.activeState, 'active');
  assert.equal(u.subState, 'running');
  assert.equal(u.mainPid, '1234');
  assert.equal(u.execStart, '/opt/flipd/bin/flipd');
});

test('a unit that does not exist exits 0 and says so in LoadState, not in the exit code', () => {
  const u = parseSystemdShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecStart=');
  assert.equal(u.loadState, 'not-found');
  assert.equal(u.execStart, '');
});

test('a bad flag is a usage error on stderr, exit 2', async () => {
  const c = capture();
  const code = await upgrade(['--nope'], { paths: {}, stdout: c.stdout, stderr: c.stderr });
  assert.equal(code, 2);
  assert.match(c.errText(), /usage: flipd upgrade \[--restart-only\]/);
});

const exec = promisify(execFile);
const realGit = (args) => exec('git', args).then(
  (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
  (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }),
);

// A real clone with a real origin, because that is what the command pulls from.
async function makeClone() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'flipd-upgrade-'));
  const origin = path.join(base, 'origin');
  const clone = path.join(base, 'clone');
  await exec('git', ['init', '--bare', '-b', 'main', origin]);
  const seed = path.join(base, 'seed');
  await exec('git', ['clone', origin, seed]);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'Test']]) {
    await exec('git', ['-C', seed, 'config', k, v]);
  }
  await fs.writeFile(path.join(seed, 'README.md'), 'one\n');
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, 'commit', '-m', 'first']);
  await exec('git', ['-C', seed, 'push', 'origin', 'main']);
  await exec('git', ['clone', origin, clone]);
  const commit = async (files, msg) => {
    for (const [f, body] of Object.entries(files)) {
      await fs.writeFile(path.join(seed, f), body);
    }
    await exec('git', ['-C', seed, 'add', '.']);
    await exec('git', ['-C', seed, 'commit', '-m', msg]);
    await exec('git', ['-C', seed, 'push', 'origin', 'main']);
  };
  const head = async (dir) => (await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
  return { base, origin, seed, clone, commit, head, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test('a clean clone passes checkClone; a dirty one is refused', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  const clean = await checkClone(c.clone, { runGit: realGit, restartOnly: false });
  assert.equal(clean.ok, true);
  assert.equal(clean.isGit, true);

  await fs.writeFile(path.join(c.clone, 'README.md'), 'edited\n');
  const dirty = await checkClone(c.clone, { runGit: realGit, restartOnly: false });
  assert.equal(dirty.ok, false);
  assert.match(dirty.error, /uncommitted/i);
});

test('a directory that is not a git work tree is refused, unless --restart-only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flipd-nogit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const refused = await checkClone(dir, { runGit: realGit, restartOnly: false });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a git/i);

  const allowed = await checkClone(dir, { runGit: realGit, restartOnly: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.isGit, false);
});

test('--restart-only still refuses a dirty clone: a restart ships uncommitted edits', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  await fs.writeFile(path.join(c.clone, 'README.md'), 'edited\n');
  const r = await checkClone(c.clone, { runGit: realGit, restartOnly: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /uncommitted/i);
});

const showOutput = (kv) => Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n');
const loadedUnit = (execPath = '/opt/flipd/bin/flipd') => showOutput({
  LoadState: 'loaded',
  ActiveState: 'active',
  SubState: 'running',
  MainPID: '42',
  ExecStart: `{ path=${execPath} ; argv[]=${execPath} serve ; ignore_errors=no }`,
});

test('readUnit asks for labelled properties, not --value', async () => {
  let seen = null;
  const run = async (argv) => { seen = argv; return { code: 0, stdout: loadedUnit(), stderr: '' }; };
  const r = await readUnit({ run });
  assert.equal(r.ok, true);
  assert.equal(seen[0], 'systemctl');
  assert.ok(!seen.includes('--value'), 'must not use --value: not-found exits 0');
  assert.deepEqual(seen.slice(1), SHOW_ARGS);
});

test('a unit that is not loaded, or has no ExecStart, is refused', async () => {
  const notFound = await readUnit({
    run: async () => ({ code: 0, stdout: showOutput({ LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ExecStart: '' }), stderr: '' }),
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.error, /not-found|no flipd\.service/i);

  const noExec = await readUnit({
    run: async () => ({ code: 0, stdout: showOutput({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '1', ExecStart: '' }), stderr: '' }),
  });
  assert.equal(noExec.ok, false);
  assert.match(noExec.error, /ExecStart/);
});

test('checkUnitClone passes its own clone and names the other one', () => {
  assert.equal(checkUnitClone(parseSystemdShow(loadedUnit('/opt/flipd/bin/flipd')), '/opt/flipd'), null);
  const wrong = checkUnitClone(parseSystemdShow(loadedUnit('/srv/flipd/bin/flipd')), '/opt/flipd');
  assert.match(wrong, /\/srv\/flipd/);
  assert.match(wrong, /\/opt\/flipd/);
});

const fail = (code) => Object.assign(new Error(code), { code });
const idleReply = { ok: true, running: null, queued: [] };
// A fake clock, so an 8s probe window costs no wall-clock time.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('a socket that answers is up', async () => {
  const clock = fakeClock();
  const r = await probeService({ send: async () => idleReply, run: async () => ({ code: 0, stdout: '', stderr: '' }), ...clock });
  assert.equal(r.state, 'up');
});

test('a timeout is not proof of down: it is unreachable, and it names the group', async () => {
  const clock = fakeClock();
  const r = await probeService({
    send: async () => { throw new Error('socket timeout'); },
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'unreachable');
});

test('EACCES is not proof of down either', async () => {
  const clock = fakeClock();
  const r = await probeService({
    send: async () => { throw fail('EACCES'); },
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'unreachable');
});

test('no socket plus ActiveState=failed is proved down', async () => {
  const clock = fakeClock();
  const r = await probeService({
    send: async () => { throw fail('ENOENT'); },
    run: async () => ({ code: 0, stdout: showOutput({ LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', ExecStart: '{ path=/opt/flipd/bin/flipd ; }' }), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'down');
});

test('a crash loop shows SubState=auto-restart and is proved down', async () => {
  const clock = fakeClock();
  const r = await probeService({
    send: async () => { throw fail('ECONNREFUSED'); },
    run: async () => ({ code: 0, stdout: showOutput({ LoadState: 'loaded', ActiveState: 'activating', SubState: 'auto-restart', MainPID: '0', ExecStart: '{ path=/opt/flipd/bin/flipd ; }' }), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'down');
});

test('no socket but steadily active for the whole window is unreachable, never down', async () => {
  const clock = fakeClock();
  let probes = 0;
  const r = await probeService({
    send: async () => { probes++; throw fail('ECONNREFUSED'); },
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'unreachable');
  assert.ok(probes > 1, 'must re-probe rather than judge on one sample');
});

test('a reply with the wrong shape is not read as idle', async () => {
  const clock = fakeClock();
  const r = await probeService({
    send: async () => ({ ok: true }),               // no running, no queued
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    ...clock,
  });
  assert.equal(r.state, 'unreachable');
});

test('waits while a build is running and returns once idle, saying so once', async () => {
  const clock = fakeClock();
  const replies = [
    { ok: true, running: 'site', queued: [] },
    { ok: true, running: 'site', queued: [] },
    { ok: true, running: 'site', queued: ['api'] },
    { ok: true, running: null, queued: [] },
  ];
  let i = 0;
  const said = [];
  const r = await waitForIdle({
    send: async () => replies[Math.min(i++, replies.length - 1)],
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    onWait: (t) => said.push(t),
    ...clock,
  });
  assert.equal(r.state, 'up');
  assert.equal(r.reply.running, null);
  // Two distinct waits, four polls: a twenty-minute build must not print
  // six hundred identical lines.
  assert.deepEqual(said, ['site running', 'site running, 1 queued']);
});

test('a proved-down service short-circuits the wait', async () => {
  const clock = fakeClock();
  const r = await waitForIdle({
    send: async () => { throw fail('ENOENT'); },
    run: async () => ({ code: 0, stdout: showOutput({ LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ExecStart: '{ path=/opt/flipd/bin/flipd ; }' }), stderr: '' }),
    onWait: () => {},
    ...clock,
  });
  assert.equal(r.state, 'down');
});

test('root is taken through sudo -v, and a refusal is a message not a throw', async () => {
  assert.equal(await takeRoot({ isRoot: true, sudoV: async () => { throw new Error('must not run'); } }), null);
  assert.equal(await takeRoot({ isRoot: false, sudoV: async () => ({ code: 0 }) }), null);
  const denied = await takeRoot({ isRoot: false, sudoV: async () => ({ code: 1 }) });
  assert.match(denied, /root/);
});

test('the restart can never prompt: sudo is invoked with -n', () => {
  assert.deepEqual(restartArgv(true), ['systemctl', 'restart', 'flipd']);
  assert.deepEqual(restartArgv(false), ['sudo', '-n', 'systemctl', 'restart', 'flipd']);
});

test('proveAlive waits for the socket, not for the unit to look active', async () => {
  const clock = fakeClock();
  let calls = 0;
  const r = await proveAlive({
    send: async () => { if (++calls < 3) throw fail('ENOENT'); return idleReply; },
    run: async () => ({ code: 0, stdout: loadedUnit(), stderr: '' }),
    ...clock,
  });
  assert.equal(r.ok, true);
});

test('a service that never answers reports which of the three shapes it saw', async () => {
  const shapes = [
    [{ LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', ExecStart: '{ path=/o/b/f ; }' }, /exited and stayed down/i],
    [{ LoadState: 'loaded', ActiveState: 'activating', SubState: 'auto-restart', MainPID: '0', ExecStart: '{ path=/o/b/f ; }' }, /loop/i],
    [{ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '9', ExecStart: '{ path=/o/b/f ; }' }, /not answering/i],
  ];
  for (const [kv, re] of shapes) {
    const clock = fakeClock();
    const r = await proveAlive({
      send: async () => { throw fail('ENOENT'); },
      run: async () => ({ code: 0, stdout: showOutput(kv), stderr: '' }),
      ...clock,
    });
    assert.equal(r.ok, false);
    assert.match(r.what, re);
  }
});

test('a pull that brings nothing reports changed:false and moves no HEAD', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  const before = await c.head(c.clone);
  const r = await pull(c.clone, { runGit: realGit });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(await c.head(c.clone), before);
});

test('a pull fast-forwards, reports the commits, and spots no installer artifacts', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  await c.commit({ 'README.md': 'two\n' }, 'second commit');
  const r = await pull(c.clone, { runGit: realGit });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.log, /second commit/);
  assert.deepEqual(r.artifacts, []);
  assert.equal(await c.head(c.clone), await c.head(c.seed));
});

test('a pull that moves flipd.service or install.sh names them', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  await c.commit({ 'flipd.service': '[Service]\n', 'install.sh': '#!/bin/sh\n' }, 'unit and installer');
  const r = await pull(c.clone, { runGit: realGit });
  assert.equal(r.ok, true);
  assert.deepEqual(r.artifacts.sort(), ['flipd.service', 'install.sh']);
});

test('a pull that cannot fast-forward refuses and leaves HEAD alone', async (t) => {
  const c = await makeClone();
  t.after(() => c.cleanup());
  await c.commit({ 'README.md': 'upstream\n' }, 'upstream commit');
  await exec('git', ['-C', c.clone, 'config', 'user.email', 't@example.com']);
  await exec('git', ['-C', c.clone, 'config', 'user.name', 'Test']);
  await fs.writeFile(path.join(c.clone, 'local.txt'), 'local\n');
  await exec('git', ['-C', c.clone, 'add', '.']);
  await exec('git', ['-C', c.clone, 'commit', '-m', 'local commit']);
  const head = await c.head(c.clone);
  const r = await pull(c.clone, { runGit: realGit });
  assert.equal(r.ok, false);
  assert.match(r.error, /fast-forward|ff-only|diverge/i);
  assert.equal(await c.head(c.clone), head);
});

test('a git failure carrying a credential is printed redacted', async () => {
  const runGit = async (argv) => (argv.includes('rev-parse')
    ? { code: 0, stdout: 'abc123\n', stderr: '' }
    : { code: 1, stdout: '', stderr: 'fatal: could not read from https://tok3n@git.example.com/x.git\n' });
  const r = await pull('/anywhere', { runGit });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('tok3n'), `credential leaked: ${r.error}`);
  assert.match(r.error, /\*\*\*@git\.example\.com/);
});

test('the partial-upgrade note gives an absolute installer path and warns about its restart', () => {
  const note = partialUpgradeNote('/opt/flipd', ['flipd.service']);
  assert.match(note, /sudo \/opt\/flipd\/install\.sh/);
  assert.ok(!/sudo \.\/install\.sh/.test(note), 'a relative path depends on where the operator is standing');
  assert.match(note, /restart/i);
  assert.match(note, /partial/i);
});
