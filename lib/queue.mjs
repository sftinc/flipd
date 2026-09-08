// lib/queue.mjs

export function createQueue(runner, { onError = () => {} } = {}) {
  const entries = [];
  const runAgain = new Set();
  const waiters = [];
  let running = null;
  let stopped = false;

  function settleWaiters() {
    if (running || entries.length) return;
    while (waiters.length) waiters.shift()();
  }

  function enqueue(entry) {
    const { kind, name } = entry;
    if (stopped) return { queued: false, reason: 'stopping' };
    if (kind === 'webhook') {
      if (running?.name === name) {
        runAgain.add(name);
        return { queued: false, reason: 'running; will run again after' };
      }
      let lastRollback = -1;
      entries.forEach((e, i) => { if (e.name === name && e.kind === 'rollback') lastRollback = i; });
      const dup = entries.slice(lastRollback + 1).some((e) => e.name === name && (e.kind === 'webhook' || e.kind === 'manual'));
      if (dup) return { queued: false, reason: 'already queued' };
    } else if (kind === 'manual') {
      if (entries.some((e) => e.name === name && e.kind === 'manual')) return { queued: false, reason: 'already queued' };
    }
    entries.push(entry);
    kick();
    return { queued: true };
  }

  const reservations = new Map();   // name → count of unresolved rollback reservations

  function reserveRollback(name) {
    reservations.set(name, (reservations.get(name) ?? 0) + 1);
    let done = false;
    const release = () => { if (done) return; done = true; const n = reservations.get(name) - 1; if (n > 0) reservations.set(name, n); else reservations.delete(name); };
    return {
      commit(target, { now = false } = {}) { release(); return enqueue({ kind: 'rollback', name, target, now }); },
      cancel() { release(); },
    };
  }

  function enqueueIfIdle(entry) {
    if (stopped) return { queued: false, reason: 'stopping' };
    if (running || entries.length) {
      return { queued: false, reason: `busy: running ${running?.name ?? '(none)'}, ${entries.length} queued` };
    }
    entries.push(entry);
    kick();
    return { queued: true };
  }

  async function kick() {
    if (running || stopped || entries.length === 0) { settleWaiters(); return; }
    running = entries.shift();
    const current = running;
    try {
      await runner(current);
    } catch (e) {
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
    if (runAgain.delete(current.name) && !stopped) enqueue({ kind: 'webhook', name: current.name });
    kick();
  }

  return {
    enqueue,
    enqueueIfIdle,
    reserveRollback,
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
      return { targets, reserved: (reservations.get(name) ?? 0) > 0 };
    },
    drain: () => new Promise((resolve) => { if (!running && !entries.length) resolve(); else waiters.push(resolve); }),
    stop: () => { stopped = true; entries.length = 0; runAgain.clear(); settleWaiters(); },
  };
}
