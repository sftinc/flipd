import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePrefix, writeMain, writeRepoConf } from './helpers.mjs';
import { parseKV } from '../lib/config.mjs';
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
  // The single most important property in this task: the private key is
  // never readable by another local user, and neither is the directory
  // holding it (an implementation that generated the key at 0644 must fail
  // here even though every other assertion in this test would still pass).
  assert.equal((await fs.stat(path.join(p.repoDir('r'), 'key'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(p.repoDir('r'))).mode & 0o777, 0o750);
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
  // The property the earlier leak fix exists for: a naive revert (relaying
  // ConfigError.message straight to stderr) would still match /line 1/ above
  // and pass every other assertion in this file, so assert the negative too
  // — the offending line's own text must never appear.
  assert.ok(!bad.err().includes('garbage'), 'the offending line is never echoed to the operator');
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

test('env --set refuses a value containing a newline, naming only the key', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const bad = io();
  assert.equal(await env(['r', 'build', '--set', 'PEM=-----BEGIN KEY-----\nsecretline\n-----END KEY-----'], { paths: p, ...bad }), 1);
  assert.match(bad.err(), /PEM/);
  assert.ok(!bad.err().includes('secretline'), 'no fragment of the rejected value is echoed');
  assert.equal(await fs.readFile(p.envFile('r', 'build'), 'utf8'), '', 'the file is untouched by the rejected value');
});

test('env: an unrecognized argument after --set is never echoed together with its value', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const bad = io();
  // The textbook 3am typo: a forgotten second "--set" before "SECOND=...".
  assert.equal(await env(['r', 'build', '--set', 'TOK=abc', 'SECOND=supersecret'], { paths: p, ...bad }), 2);
  assert.match(bad.err(), /SECOND/);
  assert.ok(!bad.err().includes('supersecret'), 'the value half of the stray token is never echoed');
});

test('env --unset with no key argument is refused, not a silent no-op write', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  assert.equal(await env(['r', 'build', '--unset'], { paths: p, ...io() }), 1);
});

test('env --set preserves comments and blank lines, and trims a padded value while saying so', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const file = p.envFile('r', 'build');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '# a comment\nA=1\n\n# another\nB=2\n');
  const o = io();
  assert.equal(await env(['r', 'build', '--set', 'B=3', '--set', 'PW=  hunter2  '], { paths: p, ...o }), 0);
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, '# a comment\nA=1\n\n# another\nB=3\nPW=hunter2\n');
  assert.match(o.out(), /trimmed.*PW/);
  assert.ok(!o.out().includes('hunter2'), 'the trimmed-value note names the key only');
});

test('env: the $EDITOR path writes on a clean parse and refuses to loop without a tty on a malformed draft', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-editor-'));
  const goodEditor = path.join(scratch, 'good.sh');
  await fs.writeFile(goodEditor, '#!/bin/sh\nprintf "NEW=1\\n" > "$1"\n');
  await fs.chmod(goodEditor, 0o755);
  const badEditor = path.join(scratch, 'bad.sh');
  await fs.writeFile(badEditor, '#!/bin/sh\nprintf "not-kv-at-all\\n" > "$1"\n');
  await fs.chmod(badEditor, 0o755);

  const prevEditor = process.env.EDITOR;
  try {
    process.env.EDITOR = goodEditor;
    const o = io();
    assert.equal(await env(['r', 'build'], { paths: p, ...o }), 0);
    assert.equal(await fs.readFile(p.envFile('r', 'build'), 'utf8'), 'NEW=1\n');
    assert.match(o.out(), /r\.build: NEW/);

    // A malformed draft with no tty to prompt on must fail fast (not the
    // hundreds-of-iterations spin a "press enter" retry loop falls into when
    // stdin is not interactive — cron, ansible, a non-interactive ssh
    // command). node --test's own stdin is exactly that: not a tty.
    process.env.EDITOR = badEditor;
    const bad = io();
    assert.equal(await env(['r', 'build'], { paths: p, ...bad }), 1);
    assert.match(bad.err(), /line 1/);
    assert.ok(!bad.err().includes('not-kv-at-all'));
    // the live file is untouched by the rejected draft
    assert.equal(await fs.readFile(p.envFile('r', 'build'), 'utf8'), 'NEW=1\n');
  } finally {
    if (prevEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = prevEditor;
  }
});

test('remove: an ambiguous status probe (timeout, no code) refuses rather than proceeding; a definite down proceeds', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const timedOut = io();
  assert.equal(await remove(['r'], { paths: p, ...timedOut, statusOverride: async () => { throw new Error('socket timeout'); } }), 1);
  await fs.stat(path.join(p.reposDir, 'r.conf'));
  assert.match(timedOut.err(), /could not reach/);
  const down = io();
  assert.equal(await remove(['r'], { paths: p, ...down, statusOverride: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } }), 0);
  await assert.rejects(fs.stat(path.join(p.reposDir, 'r.conf')));
});

test('check does not throw when a reply carries no rows (an old service ahead of a new CLI)', async () => {
  const p = await makePrefix();
  const o = io();
  assert.equal(await check(['r'], { paths: p, ...o, sendOverride: async () => ({ ok: true, passed: true }) }), 0);
});

test('add rejects a ROOT that escapes the repo directory, before creating anything', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const o = io();
  assert.equal(await add(['git@github.com:o/z.git', '--root', '../shared'], { paths: p, ...o }), 1);
  assert.match(o.err(), /ROOT must be relative/);
  await assert.rejects(fs.stat(p.repoDir('z')), 'no directory was created for the rejected invocation');
  await assert.rejects(fs.stat(p.repoConf('z')));
});

test('add rejects a newline embedded in a written value, before creating anything', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const o = io();
  assert.equal(await add(['git@github.com:o/z2.git', '--build', 'npm ci\nnpm test'], { paths: p, ...o }), 1);
  assert.match(o.err(), /--build/);
  await assert.rejects(fs.stat(p.repoDir('z2')));
});

test('add treats stray extra positionals (an unquoted multi-word --build/--deploy) as a usage error', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const o = io();
  assert.equal(await add(['git@github.com:o/z3.git', '--build', 'npm', 'ci', '--deploy', 'sudo', 'systemctl', 'restart', 'r'], { paths: p, ...o }), 2);
  await assert.rejects(fs.stat(p.repoDir('z3')));
});
