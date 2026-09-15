import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePrefix } from './helpers.mjs';
import pause from '../lib/cli/pause.mjs';
import resume from '../lib/cli/resume.mjs';
import check from '../lib/cli/check.mjs';

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}
const canned = (reply, sent = []) => async (msg) => { sent.push(msg); return reply; };
const down = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };

test('flipd pause and resume: usage, service down, refusal, and what they print', async () => {
  const p = await makePrefix();
  assert.equal(await pause([], { paths: p, ...io() }), 2);
  assert.equal(await pause(['r', '--reason'], { paths: p, ...io() }), 2);
  assert.equal(await pause(['r', '--bogus'], { paths: p, ...io() }), 2);
  assert.equal(await resume(['r', 'extra'], { paths: p, ...io() }), 2);
  assert.equal(await pause(['r'], { paths: p, ...io(), sendOverride: down }), 3);
  const sent = [];
  const o = io();
  assert.equal(await pause(['r', '--reason', 'incident'], { paths: p, ...o, sendOverride: canned({ ok: true, already: false, since: 't' }, sent) }), 0);
  assert.deepEqual(sent, [{ cmd: 'pause', name: 'r', reason: 'incident' }]);
  assert.match(o.out(), /^paused r\n$/);
  const a = io();
  assert.equal(await pause(['r'], { paths: p, ...a, sendOverride: canned({ ok: true, already: true, since: null }) }), 0);
  assert.match(a.out(), /already paused since \(unknown\)/);
  const r1 = io();
  assert.equal(await resume(['r'], { paths: p, ...r1, sendOverride: canned({ ok: true, resumed: false }) }), 0);
  assert.match(r1.out(), /r: not paused/);
  const bad = io();
  assert.equal(await resume(['r'], { paths: p, ...bad, sendOverride: canned({ ok: false, error: 'no such repo' }) }), 1);
  assert.match(bad.err(), /no such repo/);
});

test('flipd check: 6 when paused, 5 outranks it, 6 outranks 4', async () => {
  const p = await makePrefix();
  const run = (reply) => check(['r'], { paths: p, ...io(), sendOverride: async () => ({ ok: true, rows: [], passed: true, ...reply }) });
  assert.equal(await run({ paused: true, behind: true }), 6);
  assert.equal(await run({ paused: true, pending: true }), 5);
  assert.equal(await run({ paused: false, behind: true }), 4);
});
