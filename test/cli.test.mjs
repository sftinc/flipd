// test/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePrefix, makeSourceRepo, writeMain, writeRepoConf } from './helpers.mjs';
import { readState, writeState } from '../lib/state.mjs';
import { serve } from '../lib/serve.mjs';
import runCmd from '../lib/cli/run.mjs';
import rollbackCmd from '../lib/cli/rollback.mjs';

const BIN = fileURLToPath(new URL('../bin/remote-deploy', import.meta.url));

async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

function captureIO() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('remote-deploy run: exit 3 (service down) when the socket is unreachable', async () => {
  const p = await makePrefix();   // nothing is listening on p.sock
  const io = captureIO();
  const code = await runCmd(['whatever'], { paths: p, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 3);
  assert.match(io.err(), /service down/);
});

test('remote-deploy rollback: exit 3 (service down) when the socket is unreachable', async () => {
  const p = await makePrefix();
  const io = captureIO();
  const code = await rollbackCmd(['whatever'], { paths: p, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 3);
  assert.match(io.err(), /service down/);
});

test('remote-deploy run: exit 2 (usage) with no name', async () => {
  const p = await makePrefix();
  const io = captureIO();
  const code = await runCmd([], { paths: p, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 2);
  assert.match(io.err(), /usage/);
});

test('remote-deploy run and rollback: exit 1 when the reply is not ok, exit 0 when it is', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  await writeRepoConf(p, 'r', { REPO: src.url, BUILD: 'true', DEPLOY: 'true' });
  const svc = await serve({ paths: p, journal: () => {} });
  try {
    // exit 1: run against a repo that has no config at all.
    const ioMissing = captureIO();
    assert.equal(await runCmd(['nope'], { paths: p, stdout: ioMissing.stdout, stderr: ioMissing.stderr }), 1);
    assert.match(ioMissing.err(), /ENOENT|nope/);

    // exit 1: rollback with nothing to roll back to yet (fresh repo, no live/previous).
    const ioNothing = captureIO();
    assert.equal(await rollbackCmd(['r'], { paths: p, stdout: ioNothing.stdout, stderr: ioNothing.stderr }), 1);
    assert.match(ioNothing.err(), /nothing to roll back to/);

    // exit 0: run succeeds and prints what it queued.
    const ioRun = captureIO();
    assert.equal(await runCmd(['r'], { paths: p, stdout: ioRun.stdout, stderr: ioRun.stderr }), 0);
    assert.match(ioRun.out(), /queued r/);

    await waitFor(async () => (await readState(p.repoDir('r'))).live !== null);

    // exit 0: rollback now has something to roll back to... but a single
    // successful run has no `previous` yet (live only). Force one by writing
    // state directly, then roll back through the real CLI/socket path.
    const state = await readState(p.repoDir('r'));
    await writeState(p.repoDir('r'), { ...state, previous: state.live });
    const ioRollback = captureIO();
    assert.equal(await rollbackCmd(['r'], { paths: p, stdout: ioRollback.stdout, stderr: ioRollback.stderr }), 0);
    assert.match(ioRollback.out(), /queued rollback of r to/);
  } finally {
    await svc.close();
  }
});

test('remote-deploy serve: starts, listens, and shuts down cleanly on SIGTERM', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const child = spawn(process.execPath, [BIN, 'serve'], {
    env: { ...process.env, REMOTE_DEPLOY_PREFIX: p.prefix },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => /socket at/.test(output));
    // A small margin past the log line: the SIGTERM/SIGINT handlers are
    // registered synchronously right after, but leave no observable marker
    // of their own to poll on.
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0);
    assert.match(output, /SIGTERM: stopping/);
    await assert.rejects(fs.stat(p.sock), 'the socket file is removed on clean shutdown');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('remote-deploy serve: a bad config exits with an error, not a hang', async () => {
  const p = await makePrefix();
  // No main.conf at all: loadMain() throws ENOENT before anything listens.
  const child = spawn(process.execPath, [BIN, 'serve'], {
    env: { ...process.env, REMOTE_DEPLOY_PREFIX: p.prefix },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const { code } = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(code, 1);
  assert.match(output, /not found|ENOENT/);
});
