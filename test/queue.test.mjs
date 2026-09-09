// test/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../lib/queue.mjs';

function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
}

test('webhook dedupes, manual dedupes separately, rollback always appends', async () => {
  const ran = [];
  const g = gate();
  const q = createQueue(async (e) => { ran.push(e); await g.p; });
  q.enqueue({ kind: 'webhook', name: 'a' });          // starts running
  assert.equal(q.enqueue({ kind: 'webhook', name: 'b' }).queued, true);
  assert.equal(q.enqueue({ kind: 'webhook', name: 'b' }).queued, false);
  assert.equal(q.enqueue({ kind: 'manual', name: 'b' }).queued, true);
  assert.equal(q.enqueue({ kind: 'manual', name: 'b' }).queued, false);
  assert.equal(q.enqueue({ kind: 'rollback', name: 'b', target: 'r1' }).queued, true);
  assert.equal(q.enqueue({ kind: 'rollback', name: 'b', target: 'r1' }).queued, true);
  assert.deepEqual(q.protectedTargets('b'), { targets: ['r1', 'r1'], reserved: false });
  assert.equal(q.isRunning('a'), true);
  assert.equal(q.isQueued('b'), true);
  g.open();
  await q.drain();
  assert.deepEqual(ran.map((e) => e.kind + ':' + e.name), ['webhook:a', 'webhook:b', 'manual:b', 'rollback:b', 'rollback:b']);
});

test('a webhook behind a queued rollback is not swallowed by an earlier webhook', async () => {
  const ran = [];
  const g = gate();
  const q = createQueue(async (e) => { ran.push(e); await g.p; });
  q.enqueue({ kind: 'webhook', name: 'x' });   // running
  q.enqueue({ kind: 'webhook', name: 'a' });
  q.enqueue({ kind: 'rollback', name: 'a', target: 'r1' });
  assert.equal(q.enqueue({ kind: 'webhook', name: 'a' }).queued, true, 'after the rollback');
  assert.equal(q.enqueue({ kind: 'webhook', name: 'a' }).queued, false, 'now a dup');
  g.open();
  await q.drain();
  assert.deepEqual(ran.map((e) => e.kind + ':' + e.name), ['webhook:x', 'webhook:a', 'rollback:a', 'webhook:a']);
});

test('a webhook during a run sets run-again-after, once', async () => {
  const ran = [];
  let g = gate();
  const q = createQueue(async (e) => { ran.push(e); await g.p; });
  q.enqueue({ kind: 'webhook', name: 'a' });
  const r1 = q.enqueue({ kind: 'webhook', name: 'a' });
  const r2 = q.enqueue({ kind: 'webhook', name: 'a' });
  assert.equal(r1.queued, false);
  assert.equal(r2.queued, false);
  assert.equal(q.isQueued('a'), false);
  const first = g;
  g = gate();
  first.open();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 2, 'ran again exactly once');
  g.open();
  await q.drain();
  assert.equal(ran.length, 2);
});

test('stop during a run with run-again set: drain resolves, nothing re-queues', async () => {
  const ran = [];
  const g = gate();
  const q = createQueue(async (e) => { ran.push(e.name); await g.p; });
  q.enqueue({ kind: 'webhook', name: 'a' });
  q.enqueue({ kind: 'webhook', name: 'a' });   // sets run-again
  q.enqueue({ kind: 'manual', name: 'b' });
  q.stop();
  assert.equal(q.enqueue({ kind: 'manual', name: 'c' }).queued, false);
  const drained = q.drain();
  g.open();
  await drained;
  assert.deepEqual(ran, ['a']);
});

test('enqueueIfIdle queues only on an idle worker', async () => {
  const g = gate();
  const q = createQueue(async () => { await g.p; });
  assert.equal(q.enqueueIfIdle({ kind: 'check', name: 'a' }).queued, true);
  const r = q.enqueueIfIdle({ kind: 'check', name: 'b' });
  assert.equal(r.queued, false);
  assert.match(r.reason, /^busy: running a, 0 queued$/);
  g.open();
  await q.drain();
  assert.equal(q.enqueueIfIdle({ kind: 'check', name: 'b' }).queued, true);
  await q.drain();
});

test('a rollback reservation protects until commit or cancel', async () => {
  const q = createQueue(async () => {});
  const r1 = q.reserveRollback('a');
  assert.deepEqual(q.protectedTargets('a'), { targets: [], reserved: true });
  const r2 = q.reserveRollback('a');
  r1.cancel();
  assert.equal(q.protectedTargets('a').reserved, true, 'second reservation still open');
  r2.commit('rel-9');
  assert.deepEqual(q.protectedTargets('a'), { targets: ['rel-9'], reserved: false });
  r2.cancel();   // idempotent after commit
  assert.equal(q.protectedTargets('a').reserved, false);
  await q.drain();
});

test('runner errors do not stop the worker', async () => {
  const errors = [];
  const ran = [];
  const q = createQueue(async (e) => { ran.push(e.name); if (e.name === 'bad') throw new Error('boom'); }, { onError: (e, entry) => errors.push(entry.name) });
  q.enqueue({ kind: 'manual', name: 'bad' });
  q.enqueue({ kind: 'manual', name: 'good' });
  await q.drain();
  assert.deepEqual(ran, ['bad', 'good']);
  assert.deepEqual(errors, ['bad']);
});

test('a throwing onError does not wedge the queue and its error surfaces rather than vanishing', async () => {
  // A real process-wide uncaughtException is deliberately not used here: node:test
  // installs its own global handler that flags the whole file as failed the moment
  // one fires, regardless of a competing listener this test might add — so the only
  // way to observe "it surfaces" without corrupting the suite's own pass/fail signal
  // is to intercept the scheduling call itself and inspect what it would have thrown.
  const ran = [];
  const scheduled = [];
  const realQueueMicrotask = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (fn) => scheduled.push(fn);
  try {
    const q = createQueue(
      async (e) => { ran.push(e.name); throw new Error('primary: ' + e.name); },
      { onError: () => { throw new Error('onError blew up'); } },
    );
    q.enqueue({ kind: 'manual', name: 'a' });
    q.enqueue({ kind: 'manual', name: 'b' });
    await q.drain();
    assert.deepEqual(ran, ['a', 'b'], 'the queue kept running after a throwing onError');
    assert.equal(scheduled.length, 2, 'both secondary exceptions were scheduled to surface, one per failing entry');
    for (const fn of scheduled) assert.throws(fn, /onError blew up/);
  } finally {
    globalThis.queueMicrotask = realQueueMicrotask;
  }
});

test('the catch-up rerun after run-again is labelled coalesced: the queue kept only the name, never who asked', async () => {
  const ran = [];
  let g = gate();
  const q = createQueue(async (e) => { ran.push(e); await g.p; });
  q.enqueue({ kind: 'webhook', name: 'a' });                 // running
  q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });     // sets run-again
  const first = g;
  g = gate();
  first.open();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 2, 'ran again exactly once');
  assert.equal(ran[1].kind, 'webhook', 'still the webhook kind: every kind === webhook rule applies');
  assert.equal(ran[1].via, 'coalesced');
  g.open();
  await q.drain();
});

// Resolves after the runner has had a chance to be kicked for the next entry.
const tick = () => new Promise((r) => setTimeout(r, 20));

test('settled: completed with the runner return, crashed with the message; never a rejection', async () => {
  const q = createQueue(async (e) => { if (e.name === 'boom') throw new Error('bad'); return 'ok'; }, { onError: () => {} });
  const a = q.enqueue({ kind: 'webhook', name: 'a' });
  const b = q.enqueue({ kind: 'webhook', name: 'boom' });
  assert.deepEqual(await a.covered, { done: 'completed', outcome: 'ok' });
  assert.deepEqual(await b.covered, { done: 'crashed', error: 'bad' });
  await q.drain();
});

test('a throwing runner with nobody awaiting settled leaves no unhandled rejection', async () => {
  // The hook, run and rollback all discard the enqueue result. If settled
  // rejected, every crash with no --wait attached would be a process-ending
  // unhandledRejection, undoing the recovery kick() already does.
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const q = createQueue(async () => { throw new Error('bad'); }, { onError: () => {} });
    q.enqueue({ kind: 'webhook', name: 'a' });
    await q.drain();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('covered: a fresh entry, an already-queued duplicate, and a run-again token all settle on the covering attempt', async () => {
  const hold = gate();
  const q = createQueue(async (e) => { if (e.name === 'x' && !e.via) await hold.p; return `${e.via ?? e.kind}:${e.name}`; });
  q.enqueue({ kind: 'webhook', name: 'x' });                                 // running
  const fresh = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });
  const dup = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });
  assert.equal(fresh.queued, true);
  assert.equal(dup.queued, false);
  assert.equal(dup.reason, 'already queued');
  assert.equal(dup.covered, fresh.covered, 'the duplicate is covered by the entry already there');
  const again1 = q.enqueue({ kind: 'webhook', name: 'x', via: 'ssh' });
  const again2 = q.enqueue({ kind: 'webhook', name: 'x', via: 'ssh' });
  assert.equal(again1.reason, 'running; will run again after');
  assert.equal(again1.covered, again2.covered, 'one rerun covers both triggers');
  hold.open();
  await q.drain();
  assert.deepEqual(await fresh.covered, { done: 'completed', outcome: 'ssh:a' });
  assert.deepEqual(await dup.covered, { done: 'completed', outcome: 'ssh:a' });
  assert.deepEqual(await again1.covered, { done: 'completed', outcome: 'coalesced:x' });
});

test('covered follows the queue, not time: a trigger behind a queued rollback is its own entry, not the earlier one', async () => {
  // Repo b running; entries [webhook a, rollback a]; a new trigger for a is a
  // third entry because dedup looks only past the last rollback. All three
  // start "after acceptance"; only the third covers the trigger.
  const hold = gate();
  const q = createQueue(async (e) => { if (e.name === 'b') await hold.p; return `${e.kind}:${e.name}:${e.via ?? ''}`; });
  q.enqueue({ kind: 'webhook', name: 'b' });
  const first = q.enqueue({ kind: 'webhook', name: 'a' });
  q.enqueue({ kind: 'rollback', name: 'a', target: 'r1' });
  const third = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });
  assert.equal(third.queued, true);
  assert.notEqual(third.covered, first.covered);
  hold.open();
  await q.drain();
  assert.deepEqual(await first.covered, { done: 'completed', outcome: 'webhook:a:' });
  assert.deepEqual(await third.covered, { done: 'completed', outcome: 'webhook:a:ssh' });
});

test('covered: a trigger during a run, with a rollback queued meanwhile, settles on the rerun behind the rollback', async () => {
  const hold = gate();
  const seq = [];
  const q = createQueue(async (e) => { seq.push(`${e.via ?? e.kind}:${e.name}`); if (seq.length === 1) await hold.p; return seq[seq.length - 1]; });
  q.enqueue({ kind: 'webhook', name: 'a' });                                   // running
  const t = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });             // run-again token
  q.enqueue({ kind: 'rollback', name: 'a', target: 'r1' });                    // lands before the rerun does
  hold.open();
  await q.drain();
  assert.deepEqual(seq, ['webhook:a', 'rollback:a', 'coalesced:a']);
  assert.deepEqual(await t.covered, { done: 'completed', outcome: 'coalesced:a' }, 'not the rollback');
});

test('covered: a manual run queued during the build covers the rerun, so the token is not orphaned', async () => {
  const hold = gate();
  const seq = [];
  const q = createQueue(async (e) => { seq.push(`${e.via ?? e.kind}:${e.name}`); if (seq.length === 1) await hold.p; return seq[seq.length - 1]; });
  q.enqueue({ kind: 'webhook', name: 'a' });                                   // running
  const t = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });             // run-again token
  assert.equal(q.enqueue({ kind: 'manual', name: 'a' }).queued, true, 'accepted: manual dedups only against manual');
  hold.open();
  await q.drain();
  assert.deepEqual(seq, ['webhook:a', 'manual:a'], 'the catch-up found the manual as a duplicate and created nothing');
  assert.deepEqual(await t.covered, { done: 'completed', outcome: 'manual:a' });
});

test('stop settles discarded entries and an outstanding run-again token as stopping; the running attempt keeps its real outcome', async () => {
  const hold = gate();
  const q = createQueue(async (e) => { if (e.name === 'a') await hold.p; return 'ok'; });
  const running = q.enqueue({ kind: 'webhook', name: 'a' });
  const token = q.enqueue({ kind: 'webhook', name: 'a', via: 'ssh' });
  const queued = q.enqueue({ kind: 'webhook', name: 'b' });
  q.stop();
  assert.deepEqual(await queued.covered, { done: 'stopping' });
  assert.deepEqual(await token.covered, { done: 'stopping' });
  hold.open();
  await q.drain();
  assert.deepEqual(await running.covered, { done: 'completed', outcome: 'ok' });
});
