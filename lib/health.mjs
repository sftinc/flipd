// The health probe: does the thing DEPLOY just started actually answer?
//
// Every recipe in docs/deploy-recipes.md used to end in a hand-written curl
// loop, and the loop is the part that gets forgotten — a DEPLOY that restarts
// a unit exits 0 whether or not the app came up, and that zero is what marks a
// release confirmed. This module is that loop, once, so the safe path is the
// default rather than something each operator remembers to write.
//
// The shape is fixed on purpose (one key, no knobs): first request immediately,
// then one a second until the budget runs out. A connection refused and a 500
// are the same thing here — an app that has not finished starting — so both
// retry, and only 2xx ends it.

export const BUDGET_MS = 30000;
const INTERVAL_MS = 1000;
const REQUEST_MS = 3000;

// Rejects with the abort reason when `signal` fires, so a `flipd cancel`
// during the loop reads as cancelled rather than as a failed check.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// What went wrong, in the few words an operator needs to tell "nothing is
// listening" from "it is up and answering 502". fetch reports a refused
// connection as a TypeError with the real errno on `cause`, and a request that
// ran out of time as a DOMException — whose `code` is the legacy number 23 and
// says nothing to anyone, so it is named rather than reported.
function describe(e, requestMs) {
  if (e?.cause?.code) return e.cause.code;
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return `timeout: connected but no response within ${requestMs}ms`;
  return e?.message ?? String(e);
}

// Resolves once the URL answers 2xx. Rejects at the budget with what it last
// saw, or with the abort reason if `signal` fires first.
export async function checkHealth(url, { budgetMs = BUDGET_MS, intervalMs = INTERVAL_MS, requestMs = REQUEST_MS, signal } = {}) {
  // A single request may not outlast the whole budget. The budget is what
  // run.mjs caps against the repo's TIMEOUT, and without this a black-holed
  // host — one that drops the SYN rather than refusing it — would hold the
  // phase open for the request timeout no matter how short the budget was.
  requestMs = Math.min(requestMs, budgetMs);
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  let last = 'no attempt completed';
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    attempts++;
    try {
      // `manual` so a redirect is reported as the status it is rather than
      // followed somewhere else: a health endpoint that has started answering
      // 302 is a fact about the app, not a route to chase.
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(requestMs), ...(signal ? [signal] : [])]) });
      // Nothing here reads the body, and an undrained one holds the socket.
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { attempts, status: res.status };
      last = `HTTP ${res.status}`;
    } catch (e) {
      // The caller's abort comes back through fetch as this same rejection;
      // it is a cancellation, not a thing to retry.
      if (signal?.aborted) throw signal.reason;
      last = describe(e, requestMs);
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left), signal);
  }
  throw new Error(`no 2xx after ${Math.round(budgetMs / 1000)}s (${attempts} attempt${attempts === 1 ? '' : 's'}); last: ${last}`);
}
