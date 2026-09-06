// test/hook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, createHookServer, cleanForLog } from '../lib/hook.mjs';

test('cleanForLog: replaces control and non-ASCII bytes, truncates, tolerates missing values', () => {
  // A newline in a logged field forges a second log line; a tab or ESC can
  // hide text in a terminal. Every such byte becomes a visible '?'.
  assert.equal(cleanForLog('push\nfake: line'), 'push?fake: line');
  assert.equal(cleanForLog('a\tb\x1bc'), 'a?b?c');
  assert.equal(cleanForLog('café'), 'caf??', 'multi-byte UTF-8 is replaced byte-for-byte, not passed through');
  assert.equal(cleanForLog('x'.repeat(200)), 'x'.repeat(80), 'default cap is 80');
  assert.equal(cleanForLog('x'.repeat(200), 40), 'x'.repeat(40), 'cap is a parameter');
  assert.equal(cleanForLog(undefined), '');
  assert.equal(cleanForLog(null), '');
  assert.equal(cleanForLog(42), '42', 'non-strings are stringified, not thrown on');
});

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
    assert.ok(lines.some((l) => /^webhook ping from 127\.0\.0\.1: ok$/.test(l)), 'an accepted ping is journaled with its source');

    const push = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), pusher: { name: 'w' }, repository: { ssh_url: 'git@github.com:o/r.git', id: 42 } });
    assert.deepEqual(await h.post(push, { 'x-hub-signature-256': h.sign('s', push), 'x-github-event': 'push' }), { status: 202, text: 'queued r' });
    assert.deepEqual(pushes, [['r', { sha: 'a'.repeat(40), pusher: 'w', sshUrl: 'git@github.com:o/r.git', id: 42, delivery: '' }]]);

    const other = JSON.stringify({ ref: 'refs/heads/dev', repository: { ssh_url: 'git@github.com:o/r.git' } });
    assert.deepEqual(await h.post(other, { 'x-hub-signature-256': h.sign('s', other), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.ok(lines.some((l) => /ignored push .*git@github\.com:o\/r\.git.*dev/.test(l)), 'unmatched pushes are journaled with url and branch');

    const gone = JSON.stringify({ ref: 'refs/heads/main', deleted: true, repository: { ssh_url: 'git@github.com:o/r.git', id: 42 } });
    assert.deepEqual(await h.post(gone, { 'x-hub-signature-256': h.sign('s', gone), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.equal(pushes.length, 1, 'a branch deletion is not a run');
    assert.ok(lines.some((l) => /^ignored push from 127\.0\.0\.1: git@github\.com:o\/r\.git main was deleted$/.test(l)), 'a branch deletion is journaled as ignored, with repo and branch');

    const bad = 'not json';
    assert.equal((await h.post(bad, { 'x-hub-signature-256': h.sign('s', bad), 'x-github-event': 'push' })).status, 400);
    assert.ok(lines.some((l) => /^webhook rejected from 127\.0\.0\.1: body is not json$/.test(l)), 'a 400 for unparseable json is journaled');
    const missing = '{"ref":"refs/heads/main"}';
    assert.equal((await h.post(missing, { 'x-hub-signature-256': h.sign('s', missing), 'x-github-event': 'push' })).status, 400);
    assert.ok(lines.some((l) => /^webhook rejected from 127\.0\.0\.1: missing repository\.ssh_url or ref$/.test(l)), 'a 400 for a malformed payload is journaled');

    const ev = '{}';
    assert.deepEqual(await h.post(ev, { 'x-hub-signature-256': h.sign('s', ev), 'x-github-event': 'issues' }), { status: 200, text: 'ignored' });
    assert.ok(lines.some((l) => /^ignored issues event from 127\.0\.0\.1$/.test(l)), 'a non-push event is journaled with its event name');

    // A tag push: signed, well-formed, and not a branch. Silent before this change.
    const tag = JSON.stringify({ ref: 'refs/tags/v1', repository: { ssh_url: 'git@github.com:o/r.git' } });
    assert.deepEqual(await h.post(tag, { 'x-hub-signature-256': h.sign('s', tag), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.ok(lines.some((l) => /^ignored push from 127\.0\.0\.1: git@github\.com:o\/r\.git refs\/tags\/v1 is not a branch$/.test(l)), 'a tag push is journaled as ignored, with the ref');

    // An event name is a free-form header. It is bounded before it reaches the journal.
    const long = '{}';
    await h.post(long, { 'x-hub-signature-256': h.sign('s', long), 'x-github-event': 'e'.repeat(300) });
    const longLine = lines.find((l) => l.startsWith('ignored eeee'));
    assert.ok(longLine, 'the long event name was journaled');
    assert.ok(longLine.length < 120, `the event name is bounded, got ${longLine.length} chars`);
    assert.ok(!lines.some((l) => l.includes('sha256=')), 'the signature header never appears in any journal line');

    // The body must never reach the journal. A marker that could only come
    // from the body proves it: the "not json" body above cannot, because the
    // message legitimately contains that phrase.
    const marker = 'ZZMARKERZZ-not-valid-json{';
    assert.equal((await h.post(marker, { 'x-hub-signature-256': h.sign('s', marker), 'x-github-event': 'push' })).status, 400);
    assert.ok(!lines.some((l) => l.includes('ZZMARKERZZ')), 'the body is never quoted in the journal');
  } finally {
    await h.close();
  }
});

test('the delivery id reaches onPush raw, and is empty when the header is absent', async () => {
  const seen = [];
  const h = await listen({ secret: 's', findRepo: async () => repos[0], onPush: async (repo, info) => { seen.push(info.delivery); return { status: 202, body: 'queued r' }; }, journal: () => {} });
  try {
    const push = JSON.stringify({ ref: 'refs/heads/main', repository: { ssh_url: 'git@github.com:o/r.git' } });
    const headers = (extra) => ({ 'x-hub-signature-256': h.sign('s', push), 'x-github-event': 'push', ...extra });
    await h.post(push, headers({ 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' }));
    await h.post(push, headers({}));
    // A newline cannot be sent: fetch refuses it and llhttp refuses to parse it.
    // cleanForLog is unit-tested for that above; the sink (serve.mjs) cleans.
    assert.deepEqual(seen, ['72d3162e-cc78-11e3-81ab-4c9367dc0958', '']);
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
