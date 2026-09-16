// test/health.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkHealth } from '../lib/health.mjs';

// A real listener on an ephemeral port, answering from `answer` — which the
// test may change between requests, because "comes up on the third try" is the
// behaviour this module exists for. Records every request so a test can prove
// how many were made and where they went.
async function server(answer) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.url);
    const [status, body] = answer(seen.length);
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body ?? '');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/health`, seen, close: () => new Promise((r) => s.close(r)) };
}

// A port nothing listens on: one is opened, its number read, and closed again,
// so the connection is refused rather than merely slow. This is what an app
// that has not finished starting looks like from here.
async function deadUrl() {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}/health`;
}

test('checkHealth: a 200 on the first request passes, and makes exactly one request', async () => {
  const s = await server(() => [200, 'ok']);
  try {
    await checkHealth(s.url, { budgetMs: 5000, intervalMs: 10 });
    assert.deepEqual(s.seen, ['/health'], 'one request, at the path given');
  } finally {
    await s.close();
  }
});

test('checkHealth: retries a 500 and passes when the app comes up', async () => {
  const s = await server((n) => (n < 3 ? [500, 'starting'] : [200, 'ok']));
  try {
    await checkHealth(s.url, { budgetMs: 5000, intervalMs: 10 });
    assert.equal(s.seen.length, 3, 'kept trying until it answered');
  } finally {
    await s.close();
  }
});

test('checkHealth: a connection refused is a retry, not a failure — the app may still be starting', async () => {
  const url = await deadUrl();
  await assert.rejects(() => checkHealth(url, { budgetMs: 200, intervalMs: 20 }), (e) => {
    // The message has to say both halves: how long it waited, and what the
    // last thing to go wrong was. Without the second an operator cannot tell
    // "nothing is listening" from "it answered 502".
    assert.match(e.message, /after/);
    assert.match(e.message, /attempt/);
    return true;
  });
});

test('checkHealth: gives up at the budget and names the last status it saw', async () => {
  const s = await server(() => [503, 'nope']);
  try {
    await assert.rejects(() => checkHealth(s.url, { budgetMs: 200, intervalMs: 20 }), (e) => {
      assert.match(e.message, /503/, 'the last status is the operator\'s whole diagnosis');
      return true;
    });
    assert.ok(s.seen.length > 1, 'it retried rather than giving up on the first 503');
  } finally {
    await s.close();
  }
});

test('checkHealth: a 3xx or 4xx is not healthy — only 2xx is', async () => {
  for (const status of [301, 404, 401]) {
    const s = await server(() => [status, '']);
    try {
      await assert.rejects(() => checkHealth(s.url, { budgetMs: 100, intervalMs: 20 }), new RegExp(String(status)));
    } finally {
      await s.close();
    }
  }
});

test('checkHealth: an aborted signal stops the loop at once and rejects with the abort reason', async () => {
  const s = await server(() => [500, 'starting']);
  const ac = new AbortController();
  try {
    setTimeout(() => ac.abort(new Error('cancelled')), 30);
    const started = Date.now();
    await assert.rejects(() => checkHealth(s.url, { budgetMs: 60000, intervalMs: 20, signal: ac.signal }), /cancel/);
    assert.ok(Date.now() - started < 5000, 'it stopped on the abort, not at the budget');
  } finally {
    await s.close();
  }
});

test('checkHealth: an app that accepts the connection but never answers reports a timeout, not an error code', async () => {
  // The likeliest real failure — listening before it serves, or hung on
  // startup — and the one where a bare DOMException `code` of 23 would tell
  // the operator nothing at all.
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/health`;
  try {
    await assert.rejects(() => checkHealth(url, { budgetMs: 400, intervalMs: 20, requestMs: 100 }), (e) => {
      assert.match(e.message, /timeout/i, `the message must name what happened, got: ${e.message}`);
      assert.doesNotMatch(e.message, /last: 23/, 'a DOMException code is not a diagnosis');
      return true;
    });
  } finally {
    await new Promise((r) => s.close(r));
    s.closeAllConnections?.();
  }
});

test('checkHealth: a request may not outlast the budget it was given', async () => {
  // The budget is what run.mjs caps against TIMEOUT, so a per-request timeout
  // longer than the whole budget would let the phase outlast the repo's limit.
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/health`;
  const started = Date.now();
  try {
    await assert.rejects(() => checkHealth(url, { budgetMs: 200, intervalMs: 20, requestMs: 30000 }));
    assert.ok(Date.now() - started < 3000, `gave up near the budget, not at the request timeout (took ${Date.now() - started}ms)`);
  } finally {
    await new Promise((r) => s.close(r));
    s.closeAllConnections?.();
  }
});
