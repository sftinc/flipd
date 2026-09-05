// test/hook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, createHookServer } from '../lib/hook.mjs';

test('GitHub documented example verifies', () => {
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from('Hello, World!');
  assert.equal(verifySignature(secret, body, 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'), true);
  assert.equal(verifySignature(secret, body, 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e18'), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature(secret, body, 'sha1=abc'), false);
  assert.equal(verifySignature(secret, body, 'sha256=short'), false);
});

async function listen(opts) {
  const server = createHookServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = async (body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/deploy`, { method: 'POST', body, headers });
    return { status: res.status, text: await res.text() };
  };
  const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return { server, port, post, sign, close: () => new Promise((r) => server.close(r)) };
}

const repos = [{ name: 'r', repo: 'git@github.com:o/r.git', branch: 'main' }];

test('routes: 404 elsewhere, 401 unsigned, ping, push match, push no match, bad json', async () => {
  const pushes = [];
  const lines = [];
  const h = await listen({ secret: 's', findRepo: async ({ sshUrl, branch }) => repos.find((r) => r.repo === sshUrl && r.branch === branch) ?? null, onPush: async (repo, info) => { pushes.push([repo.name, info]); return { status: 202, body: `queued ${repo.name}` }; }, journal: (l) => lines.push(l) });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/other`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/deploy`)).status, 404);
    assert.equal((await h.post('{}')).status, 401);
    assert.equal((await h.post('{}', { 'x-hub-signature-256': 'sha256=bad' })).status, 401);
    assert.ok(lines.some((l) => /rejected.*127\.0\.0\.1/.test(l)));

    const ping = '{"zen":"x"}';
    assert.deepEqual(await h.post(ping, { 'x-hub-signature-256': h.sign('s', ping), 'x-github-event': 'ping' }), { status: 200, text: 'pong' });

    const push = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), pusher: { name: 'w' }, repository: { ssh_url: 'git@github.com:o/r.git', id: 42 } });
    assert.deepEqual(await h.post(push, { 'x-hub-signature-256': h.sign('s', push), 'x-github-event': 'push' }), { status: 202, text: 'queued r' });
    assert.deepEqual(pushes, [['r', { sha: 'a'.repeat(40), pusher: 'w', sshUrl: 'git@github.com:o/r.git', id: 42 }]]);

    const other = JSON.stringify({ ref: 'refs/heads/dev', repository: { ssh_url: 'git@github.com:o/r.git' } });
    assert.deepEqual(await h.post(other, { 'x-hub-signature-256': h.sign('s', other), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.ok(lines.some((l) => /ignored push .*git@github\.com:o\/r\.git.*dev/.test(l)), 'unmatched pushes are journaled with url and branch');

    const gone = JSON.stringify({ ref: 'refs/heads/main', deleted: true, repository: { ssh_url: 'git@github.com:o/r.git', id: 42 } });
    assert.deepEqual(await h.post(gone, { 'x-hub-signature-256': h.sign('s', gone), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.equal(pushes.length, 1, 'a branch deletion is not a run');

    const bad = 'not json';
    assert.equal((await h.post(bad, { 'x-hub-signature-256': h.sign('s', bad), 'x-github-event': 'push' })).status, 400);
    const missing = '{"ref":"refs/heads/main"}';
    assert.equal((await h.post(missing, { 'x-hub-signature-256': h.sign('s', missing), 'x-github-event': 'push' })).status, 400);

    const ev = '{}';
    assert.deepEqual(await h.post(ev, { 'x-hub-signature-256': h.sign('s', ev), 'x-github-event': 'issues' }), { status: 200, text: 'ignored' });
  } finally {
    await h.close();
  }
});

test('bodies over 26 MiB get 413 before signature checking, declared or chunked; 25 MiB is accepted', async () => {
  const h = await listen({ secret: 's', findRepo: async () => null, onPush: async () => ({ status: 202, body: '' }), journal: () => {} });
  try {
    const r = await h.post(Buffer.alloc(26 * 1024 * 1024 + 1, 0x20));
    assert.equal(r.status, 413);
    // A GitHub-sized payload is not rejected for size (401 here: unsigned).
    assert.equal((await h.post(Buffer.alloc(25 * 1024 * 1024, 0x20))).status, 401);
    // Chunked: no content-length, so the cap is hit while streaming.
    const big = Buffer.alloc(26 * 1024 * 1024 + 1, 0x20);
    const stream = new ReadableStream({ start(c) { c.enqueue(big.subarray(0, 16000000)); c.enqueue(big.subarray(16000000)); c.close(); } });
    const res = await fetch(`http://127.0.0.1:${h.port}/deploy`, { method: 'POST', body: stream, duplex: 'half' });
    assert.equal(res.status, 413);
  } finally {
    await h.close();
  }
});

test('a throwing onPush is a 500, and the server survives it', async () => {
  const lines = [];
  const h = await listen({ secret: 's', findRepo: async ({ sshUrl, branch }) => repos.find((r) => r.repo === sshUrl && r.branch === branch) ?? null, onPush: async () => { throw new Error('kaboom'); }, journal: (l) => lines.push(l) });
  try {
    const push = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: 'git@github.com:o/r.git' } });
    const r = await h.post(push, { 'x-hub-signature-256': h.sign('s', push), 'x-github-event': 'push' });
    assert.equal(r.status, 500);
    assert.ok(lines.some((l) => /kaboom/.test(l)));
    const ping = '{}';
    assert.equal((await h.post(ping, { 'x-hub-signature-256': h.sign('s', ping), 'x-github-event': 'ping' })).status, 200);
  } finally {
    await h.close();
  }
});
