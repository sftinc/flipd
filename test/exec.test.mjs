// test/exec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../lib/exec.mjs';

const env = { PATH: '/usr/local/bin:/usr/bin:/bin' };

test('exit code and interleaved output', async () => {
  let out = '';
  const r = await runCommand({ command: 'echo one; echo two >&2; exit 3', cwd: '/', env, timeoutSec: 5, onOutput: (c) => (out += c) });
  assert.equal(r.code, 3);
  assert.ok(out.includes('one\n') && out.includes('two\n'));
  assert.equal(r.timedOut, false);
});

test('env is exactly what was given', async () => {
  let out = '';
  const r = await runCommand({ command: 'echo "$HOME|$DEPLOY_X|$SECRET_FROM_PARENT"', cwd: '/', env: { ...env, HOME: '/h', DEPLOY_X: 'x' }, timeoutSec: 5, onOutput: (c) => (out += c) });
  assert.equal(r.code, 0);
  assert.equal(out.trim(), '/h|x|');
});

test('timeout kills the whole process group', async () => {
  const t0 = Date.now();
  const r = await runCommand({ command: 'sleep 30 & sleep 30; echo never', cwd: '/', env, timeoutSec: 1, graceMs: 200, onOutput: () => {} });
  assert.equal(r.timedOut, true);
  assert.equal(r.killedBy, 'timeout');
  assert.ok(Date.now() - t0 < 5000, 'returned promptly');
});

test('an already-aborted signal kills at once', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  const r = await runCommand({ command: 'sleep 30', cwd: '/', env, timeoutSec: 30, graceMs: 200, signal: ac.signal, onOutput: () => {} });
  assert.equal(r.killedBy, 'shutdown');
  assert.ok(Date.now() - t0 < 3000);
});

test('abort signal records shutdown', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runCommand({ command: 'sleep 30', cwd: '/', env, timeoutSec: 30, graceMs: 200, signal: ac.signal, onOutput: () => {} });
  assert.equal(r.killedBy, 'shutdown');
});
