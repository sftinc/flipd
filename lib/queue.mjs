// lib/queue.mjs

export function createQueue(runner, { onError = () => {} } = {}) {
  const entries = [];
  const runAgain = new Map();   // name → deferred: a rerun is owed after the current run, and this is who is waiting on it
  const waiters = [];
  let running = null;
  let stopped = false;

  // Every entry gets a `settled` promise that ALWAYS resolves — never rejects
  // — to { done: 'completed', outcome } with whatever the runner returned,
  // { done: 'crashed', error } with the message (a string: the reply is
  // JSON.stringify'd on its way to a CLI, and an Error serialises to {}), or
  // { done: 'stopping' } when stop() discarded it. Rejection is ruled out
  // because almost nobody observes these: the hook, run and rollback all
  // discard the enqueue result, and an unobserved rejection is a
  // process-ending unhandledRejection, undoing the recovery kick() does.
  function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  function settleWaiters() {
    if (running || entries.length) return;
    while (waiters.length) waiters.shift()();
  }

  // Returns `covered` beside `queued`/`reason`: the promise of the queue unit
  // that covers this request — the entry itself, the duplicate it collapsed
  // into, or (during a run) the rerun that is now owed. Only the queue can
  // name that unit; time-based rules cannot (a rollback can land between the
  // running build and its rerun, and the dedup scan deliberately looks only
  // past the last rollback).
  function enqueue(entry) {
    const { kind, name } = entry;
    if (stopped) return { queued: false, reason: 'stopping' };
    if (kind === 'webhook') {
      if (running?.name === name) {
        if (!runAgain.has(name)) runAgain.set(name, deferred());
        return { queued: false, reason: 'running; will run again after', covered: runAgain.get(name).promise };
      }
      let lastRollback = -1;
      entries.forEach((e, i) => { if (e.name === name && e.kind === 'rollback') lastRollback = i; });
      const dup = entries.slice(lastRollback + 1).find((e) => e.name === name && (e.kind === 'webhook' || e.kind === 'manual'));
      if (dup) return { queued: false, reason: 'already queued', covered: dup.settled.promise };
    } else if (kind === 'manual') {
      // No `covered` here, unlike the webhook branch above: `covered` is the
      // webhook path's receipt, because `flipd trigger` — its only consumer —
      // enqueues webhooks, never manual runs. A manual dedup has no waiter to
      // answer, so `some()` is enough; it doesn't need `find()`'s name-the-duplicate.
      if (entries.some((e) => e.name === name && e.kind === 'manual')) return { queued: false, reason: 'already queued' };
    }
    entry.settled = deferred();
    entries.push(entry);
    kick();
    return { queued: true, covered: entry.settled.promise };
  }

  // name → { epoch, count }. `count` is the open rollback reservations, which
  // defer prune; `epoch` is bumped by cancel(). A reservation belongs to the
  // epoch it was taken in: after a cancel its commit is refused and its release
  // leaves the new count alone. The object is never deleted, so a reservation's
  // reference stays the live one. In memory only.
  const reservations = new Map();

  function reservationsFor(name) {
    if (!reservations.has(name)) reservations.set(name, { epoch: 0, count: 0 });
    return reservations.get(name);
  }

  function reserveRollback(name) {
    const r = reservationsFor(name);
    r.count++;
    const epoch = r.epoch;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      if (r.epoch === epoch) r.count--;
    };
    return {
      commit(target, { now = false } = {}) {
        release();
        // Cancelled while serve.mjs was reading state.json between reserve and
        // commit: enqueuing now would flip `current` after the operator was told
        // the repo was cleared.
        if (r.epoch !== epoch) return { queued: false, reason: 'cancelled' };
        return enqueue({ kind: 'rollback', name, target, now });
      },
      cancel() { release(); },
    };
  }

  function cancel(name) {
    const cancelled = { done: 'completed', outcome: 'cancelled' };
    let dropped = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].name !== name) continue;
      entries[i].settled.resolve(cancelled);
      entries.splice(i, 1);
      dropped++;
    }
    const owed = runAgain.get(name);
    if (owed) {
      runAgain.delete(name);
      owed.resolve(cancelled);
      dropped++;
    }
    const r = reservations.get(name);
    if (r) {
      dropped += r.count;
      r.count = 0;
      r.epoch++;
    }
    settleWaiters();
    return { running: running?.name === name ? running : null, dropped };
  }

  function enqueueIfIdle(entry) {
    if (stopped) return { queued: false, reason: 'stopping' };
    if (running || entries.length) {
      return { queued: false, reason: `busy: running ${running?.name ?? '(none)'}, ${entries.length} queued` };
    }
    entry.settled = deferred();
    entries.push(entry);
    kick();
    return { queued: true, covered: entry.settled.promise };
  }

  async function kick() {
    if (running || stopped || entries.length === 0) { settleWaiters(); return; }
    running = entries.shift();
    const current = running;
    let result;
    try {
      result = { done: 'completed', outcome: await runner(current) };
    } catch (e) {
      // e?.message ?? String(e), not e.message: a rejection with no .message
      // (a bare throw of null/undefined, or a third-party throw of a string)
      // would throw a TypeError right here, escaping this un-awaited kick()
      // and leaving the single worker stopped forever — every future settled
      // (hence every --wait) would hang for the life of the process.
      result = { done: 'crashed', error: e?.message ?? String(e) };
      try {
        onError(e, current);
      } catch (e2) {
        // A throwing onError must not wedge the queue (the `finally` below still
        // runs), but it also must not vanish — surface it asynchronously as an
        // unhandled exception so a running service actually shows it, without
        // making the queue's continuation depend on it.
        queueMicrotask(() => { throw e2; });
      }
    } finally {
      running = null;
    }
    current.settled.resolve(result);
    const owed = runAgain.get(current.name);
    if (owed) {
      runAgain.delete(current.name);
      // The Map kept only the name, never the entry, so the rerun cannot say
      // who asked for it; `coalesced` says what the queue knows — a trigger
      // arrived mid-build and this is the catch-up. Whoever waited on the
      // token follows whatever covers the rerun: the entry this creates, or
      // — when a manual run queued meanwhile already counts as covering a
      // webhook — that duplicate. Attaching the token only to a synthesized
      // entry would orphan it in the second case.
      const r = stopped ? null : enqueue({ kind: 'webhook', name: current.name, via: 'coalesced' });
      if (r?.covered) r.covered.then(owed.resolve);
      else owed.resolve({ done: 'stopping' });
    }
    kick();
  }

  return {
    enqueue,
    enqueueIfIdle,
    reserveRollback,
    cancel,
    running: () => running,
    queued: () => [...entries],
    isRunning: (name) => running?.name === name,
    isQueued: (name) => entries.some((e) => e.name === name),
    protectedTargets: (name) => {
      const targets = [];
      // A rollback already handed to the runner is dequeued from `entries` the
      // instant kick() picks it up (synchronously, before runner's first await) —
      // its target must still count as protected while it is running, not just
      // while it is queued, or a prune could race the very rollback it should block.
      if (running && running.name === name && running.kind === 'rollback') targets.push(running.target);
      for (const e of entries) if (e.name === name && e.kind === 'rollback') targets.push(e.target);
      return { targets, reserved: (reservations.get(name)?.count ?? 0) > 0 };
    },
    drain: () => new Promise((resolve) => { if (!running && !entries.length) resolve(); else waiters.push(resolve); }),
    stop: () => {
      stopped = true;
      for (const e of entries) e.settled.resolve({ done: 'stopping' });
      entries.length = 0;
      for (const d of runAgain.values()) d.resolve({ done: 'stopping' });
      runAgain.clear();
      settleWaiters();
    },
  };
}
