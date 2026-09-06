import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeForge } from './helpers.mjs';
import { createForge, ForgeError } from '../lib/forge.mjs';

const HOOK = { url: 'https://x.example/deploy', secret: 's3cret' };

test('createForge: GitHub and the Gitea family send the right auth header, headers and bodies', async () => {
  const f = await fakeForge({
    'GET /repos/o/r': [200, { id: 7, ssh_url: 'git@h:o/r.git', clone_url: 'https://h/o/r.git' }],
    'GET /repos/o/r/hooks': [200, [{ id: 1, config: { url: 'https://x.example/deploy', content_type: 'json' } }, { id: 2, config: {} }]],
    'POST /repos/o/r/keys': [201, { id: 12, read_only: true }],
    'POST /repos/o/r/hooks': [201, { id: 34 }],
    'DELETE /repos/o/r/keys/12': [204, ''],
  });
  try {
    const gh = createForge({ kind: 'github', api: f.api, token: 'tok' });
    assert.deepEqual(await gh.getRepo('o', 'r'), { sshUrl: 'git@h:o/r.git', id: 7 });
    assert.deepEqual(await gh.listHooks('o', 'r'), [{ id: 1, url: 'https://x.example/deploy' }, { id: 2, url: '' }]);
    assert.deepEqual(await gh.addDeployKey('o', 'r', { title: 't', key: 'ssh-ed25519 AAAA' }), { id: 12 });
    assert.deepEqual(await gh.addHook('o', 'r', HOOK), { id: 34 });
    await gh.deleteDeployKey('o', 'r', 12);
    const [get, , keys, hooks, del] = f.seen;
    assert.equal(get.headers.authorization, 'Bearer tok');
    assert.equal(get.headers['user-agent'], 'flipd');
    assert.equal(get.headers.accept, 'application/vnd.github+json');
    assert.equal(get.headers['x-github-api-version'], '2022-11-28');
    assert.deepEqual(keys.body, { title: 't', key: 'ssh-ed25519 AAAA', read_only: true });
    assert.equal(keys.headers['content-type'], 'application/json');
    assert.deepEqual(hooks.body, { name: 'web', active: true, events: ['push'], config: { url: HOOK.url, content_type: 'json', secret: HOOK.secret } });
    assert.equal(del.method, 'DELETE');
    assert.equal(del.path, '/repos/o/r/keys/12');

    f.seen.length = 0;
    const fj = createForge({ kind: 'forgejo', api: f.api, token: 'tok' });
    await fj.addHook('o', 'r', HOOK);
    assert.equal(f.seen[0].headers.authorization, 'token tok');
    assert.equal(f.seen[0].headers.accept, 'application/json');
    assert.deepEqual(f.seen[0].body, { type: 'forgejo', active: true, events: ['push'], config: { url: HOOK.url, content_type: 'json', secret: HOOK.secret } });
    const gt = createForge({ kind: 'gitea', api: f.api, token: 'tok' });
    await gt.addHook('o', 'r', HOOK);
    assert.equal(f.seen[1].body.type, 'gitea', 'Gitea accepts only its own type string');
    assert.deepEqual(await gt.addDeployKey('o', 'r', { title: 't', key: 'k' }), { id: 12 });
    assert.deepEqual(f.seen[2].body, { title: 't', key: 'k', read_only: true }, 'same key body on every forge');
  } finally {
    await f.close();
  }
  assert.throws(() => createForge({ kind: 'gitlab', api: 'https://x', token: 't' }), /kind/);
});

test('createForge: owner and repo are path-encoded, so a crafted name cannot reach another route', async () => {
  const f = await fakeForge({});
  try {
    const c = createForge({ kind: 'github', api: f.api, token: 'tok' });
    await assert.rejects(c.getRepo('o', '../../user'));
    assert.equal(f.seen[0].path, '/repos/o/..%2F..%2Fuser');
  } finally {
    await f.close();
  }
});

test('createForge: errors carry the status and the API message — cleaned, capped, and never the token', async () => {
  const T = 'SECRETTOKEN';
  const f = await fakeForge({
    'GET /repos/o/missing': [404, { message: 'Not Found', documentation_url: 'https://docs' }],
    'GET /repos/o/nl': [422, { message: 'bad\nforged line' }],
    'GET /repos/o/html': [502, '<html>' + 'x'.repeat(500)],
    'GET /repos/o/empty': [500, ''],
  });
  try {
    const c = createForge({ kind: 'github', api: f.api, token: T });
    await assert.rejects(c.getRepo('o', 'missing'), (e) => e instanceof ForgeError && e.status === 404 && /Not Found/.test(e.message));
    await assert.rejects(c.getRepo('o', 'nl'), (e) => e.status === 422 && !e.message.includes('\n') && e.message.includes('bad?forged'));
    await assert.rejects(c.getRepo('o', 'html'), (e) => e.status === 502 && e.message.length < 260);
    await assert.rejects(c.getRepo('o', 'empty'), (e) => e.status === 500 && /GET \/repos\/o\/empty: 500/.test(e.message));
    await assert.rejects(c.getRepo('o', 'missing'), (e) => !String(e).includes(T) && !e.message.includes(T) && !(e.stack ?? '').includes(T));
  } finally {
    await f.close();
  }
  // Nothing listening: a ForgeError too, not a bare fetch failure, and still no token.
  const dead = createForge({ kind: 'github', api: 'http://127.0.0.1:1', token: T });
  await assert.rejects(dead.getRepo('o', 'r'), (e) => e instanceof ForgeError && e.status === null && !String(e).includes(T));
});

test('createForge: a hanging API times out as a ForgeError', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(() => { /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = createForge({ kind: 'forgejo', api: `http://127.0.0.1:${server.address().port}`, token: 't' }, { timeoutMs: 200 });
    await assert.rejects(c.getRepo('o', 'r'), (e) => e instanceof ForgeError && /timed out|Timeout/i.test(e.message));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('createForge: addDeployKey and addHook throw when the response carries no id, rather than an id of undefined', async () => {
  const f = await fakeForge({
    'POST /repos/o/r/keys': [201, ''],
    'POST /repos/o/r/hooks': [201, ''],
  });
  try {
    const c = createForge({ kind: 'github', api: f.api, token: 'tok' });
    // An id of undefined would otherwise pass a caller's `id !== null` check
    // and end up as "DELETE .../keys/undefined" or "(id undefined)" in output
    // — a ForgeError here removes that null-versus-undefined distinction
    // entirely rather than requiring every caller to make it.
    await assert.rejects(c.addDeployKey('o', 'r', { title: 't', key: 'k' }), (e) => e instanceof ForgeError && e.status === null && /no id/.test(e.message));
    await assert.rejects(c.addHook('o', 'r', HOOK), (e) => e instanceof ForgeError && e.status === null && /no id/.test(e.message));
  } finally {
    await f.close();
  }
});

test('createForge: a cross-origin redirect is refused, not followed with the Authorization header intact', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(302, { Location: 'https://attacker.example/steal' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = createForge({ kind: 'github', api: `http://127.0.0.1:${server.address().port}`, token: 'SECRETTOKEN' });
    await assert.rejects(c.getRepo('o', 'r'), (e) => e instanceof ForgeError && !String(e).includes('SECRETTOKEN'));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
