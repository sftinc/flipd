// test/cli-trigger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePrefix } from './helpers.mjs';
import trigger from '../lib/cli/trigger.mjs';

const BIN = fileURLToPath(new URL('../bin/flipd', import.meta.url));

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}

// Records what the command sent — message and sendCommand options both — and
// answers with a canned reply, so no service is stood up.
function canned(reply, sent) {
  return async (msg, opts) => { sent.push([msg, opts]); return reply; };
}

test('flipd trigger: usage (2) without a name, or with any flag but --wait (--now is run\'s, not this door\'s)', async () => {
  const p = await makePrefix();
  for (const args of [[], ['r', '--now'], ['r', '--wait', '--now'], ['r', 'extra']]) {
    const o = io();
    assert.equal(await trigger(args, { paths: p, ...o }), 2, JSON.stringify(args));
    assert.match(o.err(), /^usage: flipd trigger <name> \[--wait\]$/m);
  }
});

test('flipd trigger: service down is 3', async () => {
  const p = await makePrefix();   // nothing is listening on p.sock
  const o = io();
  assert.equal(await trigger(['r'], { paths: p, ...o }), 3);
  assert.match(o.err(), /service down/);
});

test('flipd trigger: accepted is 0 and prints queued; refused is 1 with the reason on stderr', async () => {
  const p = await makePrefix();
  const sent = [];
  let o = io();
  assert.equal(await trigger(['r'], { paths: p, ...o, sendOverride: canned({ ok: true, accepted: true }, sent) }), 0);
  assert.equal(o.out(), 'queued r\n');
  assert.deepEqual(sent.at(-1), [{ cmd: 'trigger', name: 'r', wait: false }, {}], 'no wait: the default client timeout applies');
  o = io();
  assert.equal(await trigger(['r'], { paths: p, ...o, sendOverride: canned({ ok: true, accepted: true, reason: 'already queued' }, sent) }), 0);
  assert.equal(o.out(), 'queued r (already queued)\n', 'coalesced is still accepted, as the hook answers 202');
  o = io();
  assert.equal(await trigger(['r'], { paths: p, ...o, sendOverride: canned({ ok: false, refused: 'pending b' }, sent) }), 1);
  assert.equal(o.err(), 'pending b\n');
  assert.equal(o.out(), '');
  o = io();
  assert.equal(await trigger(['r'], { paths: p, ...o, sendOverride: canned({ ok: false, error: 'ENOENT: no such file' }, sent) }), 1);
  assert.match(o.err(), /ENOENT/);
});

test('flipd trigger --wait: no client timeout; ok and skipped are 0, every other outcome is 1', async () => {
  const p = await makePrefix();
  const sent = [];
  const cases = [
    [{ ok: true, outcome: 'ok' }, 0, 'r: ok\n'],
    [{ ok: true, outcome: 'skipped' }, 0, 'r: skipped\n'],
    [{ ok: true, outcome: 'build failed' }, 1, 'r: build failed\n'],
    [{ ok: true, outcome: 'deploy failed' }, 1, 'r: deploy failed\n'],
    [{ ok: true, outcome: 'interrupted' }, 1, 'r: interrupted\n'],
    [{ ok: true, outcome: 'config failed' }, 1, 'r: config failed\n'],
  ];
  for (const [reply, code, out] of cases) {
    const o = io();
    assert.equal(await trigger(['r', '--wait'], { paths: p, ...o, sendOverride: canned(reply, sent) }), code, JSON.stringify(reply));
    assert.equal(o.out(), out);
    assert.deepEqual(sent.at(-1), [{ cmd: 'trigger', name: 'r', wait: true }, { timeoutMs: null }], 'the connection\'s lifetime is the timeout');
  }
  for (const reply of [{ ok: false, refused: 'stopping' }, { ok: false, error: 'boom' }]) {
    const o = io();
    assert.equal(await trigger(['r', '--wait'], { paths: p, ...o, sendOverride: canned(reply, sent) }), 1);
    assert.equal(o.out(), '');
    assert.match(o.err(), /stopping|boom/);
  }
});

test('bin/flipd knows trigger', async () => {
  const { code, err } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'trigger']);
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(code, 2);
  assert.match(err, /usage: flipd trigger <name> \[--wait\]/);
});
