import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePrefix, makeSourceRepo, writeMain, writeRepoConf } from './helpers.mjs';
import { parseKV } from '../lib/config.mjs';
import { writeState, emptyState } from '../lib/state.mjs';
import add, { parseRepoUrl } from '../lib/cli/add.mjs';
import check from '../lib/cli/check.mjs';
import env from '../lib/cli/env.mjs';
import remove from '../lib/cli/remove.mjs';

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}

test('parseRepoUrl handles ssh and https forms', () => {
  assert.deepEqual(parseRepoUrl('git@github.com:sftinc/aliasroute.git'), { owner: 'sftinc', repo: 'aliasroute', name: 'aliasroute' });
  assert.deepEqual(parseRepoUrl('https://github.com/sftinc/Alias.Route'), { owner: 'sftinc', repo: 'Alias.Route', name: 'alias.route' });
  assert.equal(parseRepoUrl('file:///tmp/x'), null);
});

test('add writes the config with placeholders, generates a key, prints the next steps, refuses twice', async () => {
  const p = await makePrefix();
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  const o = io();
  assert.equal(await add(['git@github.com:o/r.git', '--root', 'mta'], { paths: p, ...o }), 0);
  const text = await fs.readFile(path.join(p.reposDir, 'r.conf'), 'utf8');
  const kv = parseKV(text.replace(/^#BUILD=/m, 'BUILD=').replace(/^#DEPLOY=/m, 'DEPLOY='), null);
  assert.equal(kv.get('REPO'), 'git@github.com:o/r.git');
  assert.equal(kv.get('BRANCH'), 'main');
  assert.equal(kv.get('ROOT'), 'mta');
  assert.equal(kv.get('HOOK_HOST'), 'deploy.example.com');
  assert.match(text, /^#BUILD=/m);
  await fs.stat(path.join(p.repoDir('r'), 'key'));
  const pub = await fs.readFile(path.join(p.repoDir('r'), 'key.pub'), 'utf8');
  assert.match(pub, /^ssh-ed25519 /);
  assert.ok(o.out().includes(pub.trim()));
  assert.match(o.out(), /gh repo deploy-key add .*-R o\/r/);
  assert.match(o.out(), /https:\/\/deploy\.example\.com\/deploy/);
  assert.match(o.out(), /remote-deploy check r/);
  assert.ok(!o.out().includes('testsecret'), 'secret is never printed');
  assert.equal(await add(['git@github.com:o/r.git'], { paths: p, ...io() }), 1);
  assert.equal(await add(['file:///x', '--name', 'Bad Name'], { paths: p, ...io() }), 1);
  assert.equal(await add(['file:///x'], { paths: p, ...io() }), 1, 'no name derivable and none given');
});

test('add --key writes KEY, generates nothing, and prints the collaborator instruction', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const shared = path.join(p.etc, 'machine.key');
  await fs.writeFile(shared, 'k');
  await fs.writeFile(`${shared}.pub`, 'ssh-ed25519 AAAAmachine remote-deploy-machine');
  const o = io();
  assert.equal(await add(['git@github.com:o/s.git', '--key', shared], { paths: p, ...o }), 0);
  const text = await fs.readFile(p.repoConf('s'), 'utf8');
  assert.match(text, new RegExp(`^KEY=${shared}$`, 'm'));
  await assert.rejects(fs.stat(path.join(p.repoDir('s'), 'key')));
  assert.match(o.out(), /collaborator/);
  assert.ok(!o.out().includes('deploy-key add'));
  assert.equal(await add(['git@github.com:o/t.git', '--key', '/nonexistent'], { paths: p, ...io() }), 1);
});

test('check: prints the rows the service returns, exits by passed, reports busy and service down', async () => {
  const p = await makePrefix();
  const sent = [];
  const send = (reply) => async (m) => { sent.push(m); return reply; };
  const o = io();
  assert.equal(await check(['r', '--set-remote'], { paths: p, ...o, sendOverride: send({ ok: true, passed: true, behind: true, rows: [['config', 'ok'], ['main', '5ac3c5a  (live: none)  behind']] }) }), 4);
  assert.equal(await check(['r'], { paths: p, ...io(), sendOverride: send({ ok: true, passed: true, behind: false, rows: [['main', 'x  up to date']] }) }), 0);
  assert.deepEqual(sent[0], { cmd: 'check', name: 'r', setRemote: true });
  assert.match(o.out(), /^config\s+ok$/m);
  assert.match(o.out(), /^main\s+5ac3c5a/m);
  assert.equal(await check(['r'], { paths: p, ...io(), sendOverride: send({ ok: true, passed: false, rows: [['remote', 'MISMATCH']] }) }), 1);
  const busy = io();
  assert.equal(await check(['r'], { paths: p, ...busy, sendOverride: send({ ok: false, error: 'busy: running x, 1 queued' }) }), 1);
  assert.match(busy.err(), /busy: running x/);
  const down = io();
  assert.equal(await check(['r'], { paths: p, ...down, sendOverride: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } }), 3);
  assert.match(down.err(), /service down/);
  assert.equal(await check(['../x'], { paths: p, ...io(), sendOverride: send({ ok: true }) }), 1, 'bad name never reaches the socket');
});

test('env: --set and --unset edit one line, print key names only, validate, honour BUILD_ENV_FILE', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  await writeRepoConf(p, 'q', { REPO: 'x', BUILD: 'true', DEPLOY: 'true', BUILD_ENV_FILE: path.join(p.envDir, 'custom.env') });
  assert.equal(await env(['q', 'build', '--set', 'A=1'], { paths: p, ...io() }), 0);
  assert.equal(await fs.readFile(path.join(p.envDir, 'custom.env'), 'utf8'), 'A=1\n');
  const o = io();
  assert.equal(await env(['r', 'build', '--set', 'TOK=abc', '--set', 'OTHER=1'], { paths: p, ...o }), 0);
  assert.equal(await fs.readFile(p.envFile('r', 'build'), 'utf8'), 'TOK=abc\nOTHER=1\n');
  assert.match(o.out(), /r\.build: TOK OTHER/);
  assert.ok(!o.out().includes('abc'));
  assert.equal((await fs.stat(p.envFile('r', 'build'))).mode & 0o777, 0o640);
  assert.equal(await env(['r', 'build', '--set', 'TOK=def', '--unset', 'OTHER'], { paths: p, ...io() }), 0);
  assert.equal(await fs.readFile(p.envFile('r', 'build'), 'utf8'), 'TOK=def\n');
  assert.equal(await env(['r', 'build', '--set', 'bad key=1'], { paths: p, ...io() }), 1);
  assert.equal(await env(['r', 'neither'], { paths: p, ...io() }), 2);
  await fs.writeFile(p.envFile('r', 'deploy'), 'garbage\n');
  const bad = io();
  assert.equal(await env(['r', 'deploy', '--set', 'A=1'], { paths: p, ...bad }), 1);
  assert.match(bad.err(), /line 1/);
});

test('remove: refuses while queued or running, otherwise deletes the config and prints rm lines', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const o = io();
  assert.equal(await remove(['r'], { paths: p, ...o, statusOverride: async () => ({ ok: true, running: 'r', queued: [] }) }), 1);
  await fs.stat(path.join(p.reposDir, 'r.conf'));
  const ok = io();
  assert.equal(await remove(['r'], { paths: p, ...ok, statusOverride: async () => ({ ok: true, running: null, queued: [] }) }), 0);
  await assert.rejects(fs.stat(path.join(p.reposDir, 'r.conf')));
  assert.match(ok.out(), new RegExp(`rm -rf ${p.repoDir('r')}`));
  assert.match(ok.out(), new RegExp(`rm -rf ${p.repoLog('r')}`));
  assert.equal(await remove(['zzz'], { paths: p, ...io(), statusOverride: async () => ({ ok: true, running: null, queued: [] }) }), 1);
  await fs.writeFile(p.mainConf, 'WEBHOOK_SECRET=s\n');
  await assert.rejects(remove(['../remote-deploy'], { paths: p, ...io(), statusOverride: async () => ({ ok: true, running: null, queued: [] }) }), /repo name/);
  await fs.stat(p.mainConf);
});
