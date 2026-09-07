import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePrefix, tmpdir, writeMain, writeRepoConf, fakeForge, writeAccountConf } from './helpers.mjs';
import { parseKV, loadEnvFile } from '../lib/config.mjs';
import add from '../lib/cli/add.mjs';
import check from '../lib/cli/check.mjs';
import env from '../lib/cli/env.mjs';
import remove from '../lib/cli/remove.mjs';
import { findRepoFor } from '../lib/serve.mjs';
import { parseRepoUrl } from '../lib/repourl.mjs';
import { createForge } from '../lib/forge.mjs';

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}

test('parseRepoUrl handles ssh and https forms', () => {
  assert.deepEqual(parseRepoUrl('git@github.com:sftinc/aliasroute.git'), { host: 'github.com', owner: 'sftinc', repo: 'aliasroute', name: 'aliasroute' });
  assert.deepEqual(parseRepoUrl('https://github.com/sftinc/Alias.Route'), { host: 'github.com', owner: 'sftinc', repo: 'Alias.Route', name: 'alias.route' });
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
  assert.match(o.out(), /flipd check r/);
  assert.ok(!o.out().includes('testsecret'), 'secret is never printed');
  // The recipe's argv-safety properties are tested at the source in
  // test/recipe.test.mjs. Here: only that add prints it, framed as step 2.
  assert.match(o.out(), /^2\. add the webhook/m);
  assert.match(o.out(), /gh api repos\/o\/r\/hooks --method POST --input -/);
  assert.equal(await add(['git@github.com:o/r.git'], { paths: p, ...io() }), 1);
  assert.equal(await add(['file:///x', '--name', 'Bad Name'], { paths: p, ...io() }), 1);
  assert.equal(await add(['file:///x'], { paths: p, ...io() }), 1, 'no name derivable and none given');
});

test('add given the https form writes the ssh REPO a push can actually match', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const o = io();
  assert.equal(await add(['https://github.com/sftinc/Alias.Route', '--build', 'true', '--deploy', 'true'], { paths: p, ...o }), 0);
  const text = await fs.readFile(p.repoConf('alias.route'), 'utf8');
  // GitHub's push payload carries repository.ssh_url. The https URL is fine
  // to type; the scp form is what fetch needs, so it is what gets stored.
  assert.match(text, /^REPO=git@github\.com:sftinc\/Alias\.Route\.git$/m);
  // The property that actually matters, checked end to end rather than by
  // pattern: the webhook matcher finds this repo for a push to it. The rewrite
  // to the scp form is for fetch (the deploy key works over SSH), not for
  // matching — since identity matching landed, the https form matches too.
  const find = findRepoFor(p, () => {});
  const matched = await find({ sshUrl: 'git@github.com:sftinc/Alias.Route.git', branch: 'main', id: null });
  assert.equal(matched?.name, 'alias.route', 'a push to this repository matches the config add just wrote');
  assert.equal((await find({ sshUrl: 'https://github.com/sftinc/Alias.Route', branch: 'main', id: null }))?.name, 'alias.route', 'same repository, different spelling');
});

test('add --key writes KEY, generates nothing, and prints the collaborator instruction', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const shared = path.join(p.etc, 'machine.key');
  await fs.writeFile(shared, 'k');
  await fs.writeFile(`${shared}.pub`, 'ssh-ed25519 AAAAmachine flipd-machine');
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
  // 5 is pending, and it wins over behind: the catch-up script's `[ $? -eq 4 ]`
  // must not force-build over an unconfirmed flip.
  assert.equal(await check(['r'], { paths: p, ...io(), sendOverride: send({ ok: true, passed: true, behind: false, pending: true, rows: [['pending', 'b is flipped but unconfirmed']] }) }), 5);
  assert.equal(await check(['r'], { paths: p, ...io(), sendOverride: send({ ok: true, passed: true, behind: true, pending: true, rows: [['pending', 'b is flipped but unconfirmed']] }) }), 5);
  assert.equal(await check(['r'], { paths: p, ...io(), sendOverride: send({ ok: true, passed: false, behind: true, pending: true, rows: [['remote', 'MISMATCH']] }) }), 1, 'a failed row still outranks both');
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

test('check prints the webhook recipe with the current PUBLIC_HOST, so it can be read after --host', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'git@github.com:o/r.git', BRANCH: 'main', ROOT: '.', BUILD: 'true', DEPLOY: 'true' });
  const send = (reply) => async () => reply;
  const ok = { ok: true, passed: true, behind: false, rows: [['main', 'x  up to date']] };

  // Host known: the recipe carries it.
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  const o = io();
  assert.equal(await check(['r'], { paths: p, ...o, sendOverride: send(ok) }), 0);
  assert.match(o.out(), /^main\s+x  up to date$/m, 'the rows still print first');
  assert.match(o.out(), /^webhook/m, 'the recipe is a labelled section after the rows');
  assert.match(o.out(), /Payload URL\s+https:\/\/deploy\.example\.com\/deploy/);
  assert.match(o.out(), /gh api repos\/o\/r\/hooks --method POST --input -/);
  assert.ok(!o.out().includes('testsecret'), 'secret is never printed');

  // Host not known yet: the placeholder, not a crash and not silence.
  await writeMain(p);
  const o2 = io();
  assert.equal(await check(['r'], { paths: p, ...o2, sendOverride: send(ok) }), 0);
  assert.match(o2.out(), /https:\/\/<PUBLIC_HOST>\/deploy/);

  // A failed check still prints it: the rows say what failed, the recipe is
  // still the next thing the operator needs.
  const o3 = io();
  assert.equal(await check(['r'], { paths: p, ...o3, sendOverride: send({ ok: true, passed: false, rows: [['remote', 'MISMATCH']] }) }), 1);
  assert.match(o3.out(), /Payload URL/);

  // No repo conf on disk (the service reported on a name it knows but we
  // cannot read): the rows print, the recipe is skipped, and the exit code is
  // the service's verdict, not a read error.
  const o4 = io();
  assert.equal(await check(['nothere'], { paths: p, ...o4, sendOverride: send(ok) }), 0);
  assert.match(o4.out(), /^main\s+x  up to date$/m);
  assert.doesNotMatch(o4.out(), /Payload URL/);
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
  await assert.rejects(remove(['../flipd'], { paths: p, ...io(), statusOverride: async () => ({ ok: true, running: null, queued: [] }) }), /repo name/);
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

test('env: an unrecognized argument never echoes any part of the token, however it is shaped', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const cases = [
    // The textbook 3am typo: a forgotten second "--set" before "SECOND=...".
    { argv: ['r', 'build', '--set', 'TOK=abc', 'SECOND=supersecret'], leaked: ['SECOND', 'supersecret'] },
    // A space instead of "=" — a prefix-cut-at-"=" fix still leaks this whole.
    { argv: ['r', 'build', '--set', 'TOK', 'abc123secret'], leaked: ['abc123secret'] },
    // Base64 whose only "=" is padding — cutting at the first "=" leaks everything before it.
    { argv: ['r', 'build', '--set', 'TOK=abc', 'c2VjcmV0dmFsdWU='], leaked: ['c2VjcmV0dmFsdWU'] },
  ];
  for (const { argv, leaked } of cases) {
    const bad = io();
    assert.equal(await env(argv, { paths: p, ...bad }), 2);
    assert.match(bad.err(), /unknown argument at position/);
    for (const fragment of leaked) assert.ok(!bad.err().includes(fragment), `"${fragment}" must not appear in: ${bad.err()}`);
  }
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
  const scratch = await tmpdir('rd-editor');
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

test('add --key naming a missing file leaves no directory behind', async () => {
  const p = await makePrefix();
  await writeMain(p);
  const o = io();
  assert.equal(await add(['git@github.com:o/z4.git', '--key', '/nonexistent'], { paths: p, ...o }), 1);
  await assert.rejects(fs.stat(p.repoDir('z4')), 'a rejected invocation must leave no partial state, not even an empty directory');
});

test('env --set on a duplicated key replaces the first line, deletes every later one, and the new value is what loadEnvFile returns', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'app', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const file = p.envFile('app', 'build');
  await fs.mkdir(path.dirname(file), { recursive: true });
  // parseKV is last-wins, so this file already reads as NPM_TOKEN=leaked_old
  // today — a duplicate reachable through $EDITOR (parseKV accepts it without
  // complaint) or a plain `tee -a`.
  await fs.writeFile(file, 'NPM_TOKEN=leaked_old\nNPM_TOKEN=leaked_old\n');
  const o = io();
  assert.equal(await env(['app', 'build', '--set', 'NPM_TOKEN=rotated_new'], { paths: p, ...o }), 0);
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, 'NPM_TOKEN=rotated_new\n', 'the duplicate is collapsed, not left to shadow the new value');
  assert.match(o.out(), /collapsed.*NPM_TOKEN/);
  assert.ok(!o.out().includes('leaked_old') && !o.out().includes('rotated_new'), 'the collapse note names the key only');
  assert.match(o.out(), /app\.build: NPM_TOKEN/);
  // The actual end-to-end property: what a run will load is the rotated
  // value, not the leaked one a naive first-match-only replace would leave
  // live underneath it.
  const kv = await loadEnvFile(file);
  assert.equal(kv.get('NPM_TOKEN'), 'rotated_new');
});

test('concurrent env --set calls each complete: none fails on a temporary file another one owns', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const file = p.envFile('r', 'build');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'BASE=1\n');
  // Two `sudo flipd env` calls at once is a thing an operator can do.
  // With one fixed `<file>.tmp` between them, the loser's chmod or rename hits
  // ENOENT — the same shape as writeState's race. Which --set wins is not
  // decided here (this does not make the command transactional); what is
  // decided is that no call blows up and no temporary file is left behind
  // holding env-file values at 0640.
  const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => env(['r', 'build', '--set', `K${i}=v${i}`], { paths: p, ...io() })));
  assert.deepEqual([...new Set(codes)], [0], `every concurrent call succeeded: ${codes}`);
  const kv = await loadEnvFile(file);
  assert.ok(kv.size >= 1, 'the file still parses');
  assert.deepEqual((await fs.readdir(p.envDir)).filter((n) => n.includes('.tmp')), [], 'no temporary file is left behind');
});

test('env: --set and --unset on the same key in one call is refused as ambiguous, not silently order-dependent', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'x', BUILD: 'true', DEPLOY: 'true' });
  const bad = io();
  assert.equal(await env(['r', 'build', '--unset', 'TOK', '--set', 'TOK=1'], { paths: p, ...bad }), 2);
  assert.match(bad.err(), /TOK/);
  await assert.rejects(fs.stat(p.envFile('r', 'build')), 'the ambiguous call is refused before the env file is even created');
});

async function accountSetup(script, accountKv = { KIND: 'forgejo', TOKEN: 'tokVALUE' }) {
  const p = await makePrefix();
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  await writeAccountConf(p, 'forge.example.com', accountKv);
  const f = await fakeForge(script);
  // The conf's API is https://forge.example.com/api/v1, which does not exist;
  // the override keeps the real client and points it at the fake.
  const forgeOverride = (c) => createForge({ ...c, api: f.api });
  return { p, f, forgeOverride };
}
const noSecrets = (o) => assert.ok(!o.out().includes('testsecret') && !o.out().includes('tokVALUE') && !o.err().includes('testsecret') && !o.err().includes('tokVALUE'), 'neither the secret nor the token is ever printed');

test('add with an account: looks the repo up, uploads the key, creates the webhook, writes REPO as the forge renders it', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/Team/App': [200, { id: 12, ssh_url: 'ssh://git@forge.example.com:2222/Team/App.git' }],
    'GET /repos/Team/App/hooks': [200, []],
    'POST /repos/Team/App/keys': [201, { id: 5 }],
    'POST /repos/Team/App/hooks': [201, { id: 9 }],
  });
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/Team/App', '--root', 'web'], { paths: p, ...o, forgeOverride }), 0);
    const text = await fs.readFile(p.repoConf('app'), 'utf8');
    const kv = parseKV(text.replace(/^#BUILD=/m, 'BUILD=').replace(/^#DEPLOY=/m, 'DEPLOY='), null);
    assert.equal(kv.get('REPO'), 'ssh://git@forge.example.com:2222/Team/App.git', 'the URL the forge will put in every push, port included');
    assert.equal(kv.get('ROOT'), 'web');
    assert.equal(kv.get('HOOK_HOST'), 'deploy.example.com');
    assert.equal((await fs.stat(path.join(p.repoDir('app'), 'key'))).mode & 0o777, 0o600);
    const pub = (await fs.readFile(path.join(p.repoDir('app'), 'key.pub'), 'utf8')).trim();
    const keyReq = f.seen.find((r) => r.method === 'POST' && r.path === '/repos/Team/App/keys');
    assert.deepEqual(keyReq.body, { title: `flipd@${os.hostname()}`, key: pub, read_only: true });
    assert.equal(keyReq.headers.authorization, 'token tokVALUE');
    const hookReq = f.seen.find((r) => r.method === 'POST' && r.path === '/repos/Team/App/hooks');
    assert.deepEqual(hookReq.body, { type: 'forgejo', active: true, events: ['push'], config: { url: 'https://deploy.example.com/deploy', content_type: 'json', secret: 'testsecret' } });
    assert.deepEqual(f.seen.map((r) => `${r.method} ${r.path}`), ['GET /repos/Team/App', 'GET /repos/Team/App/hooks', 'POST /repos/Team/App/keys', 'POST /repos/Team/App/hooks'], 'read-only calls first, writes last');
    assert.match(o.out(), /deploy key added\s+flipd@\S+ \(id 5, read-only\)/);
    assert.match(o.out(), /webhook added\s+https:\/\/deploy\.example\.com\/deploy \(id 9, push only\)/);
    assert.match(o.out(), /flipd check app/);
    assert.ok(!o.out().includes('gh api') && !o.out().includes(pub), 'no recipe and no key dump on the automated path');
    assert.ok(!o.out().includes('ssh-keyscan'), 'the ssh host (forge.example.com) matches the account host: no mismatch warning');
    noSecrets(o);
    assert.equal(await add(['https://forge.example.com/Team/App'], { paths: p, ...io(), forgeOverride }), 1, 'refuses twice, as always');
  } finally {
    await f.close();
  }
});

test('add with an account: a 404 or a rejected token creates nothing; a missing PUBLIC_HOST refuses before any request', async () => {
  const script = {};
  const { p, f, forgeOverride } = await accountSetup(script);
  try {
    const nothing = async () => {
      await assert.rejects(fs.stat(p.repoConf('app')));
      await assert.rejects(fs.stat(p.repoDir('app')));
    };
    const o404 = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o404, forgeOverride }), 1);
    assert.match(o404.err(), /not found on forge\.example\.com, or the token cannot see it/);
    await nothing();
    script['GET /repos/team/app'] = [401, { message: 'token expired' }];
    const o401 = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o401, forgeOverride }), 1);
    assert.match(o401.err(), /token rejected by forge\.example\.com/);
    await nothing();
    noSecrets(o401);
    await writeMain(p);   // no PUBLIC_HOST
    f.seen.length = 0;
    const oHost = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...oHost, forgeOverride }), 1);
    assert.match(oHost.err(), /PUBLIC_HOST is not set/);
    assert.equal(f.seen.length, 0, 'refused before the first request');
    await nothing();
  } finally {
    await f.close();
  }
});

test('add with an account: a failed webhook call deletes the uploaded key and the generated pair, so a retry is clean', async () => {
  const script = {
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/keys': [201, { id: 5 }],
    'POST /repos/team/app/hooks': [500, { message: 'boom' }],
    'DELETE /repos/team/app/keys/5': [204, ''],
  };
  const { p, f, forgeOverride } = await accountSetup(script);
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 1);
    assert.match(o.err(), /500 boom/);
    assert.match(o.err(), /no repo config was written/);
    assert.ok(f.seen.some((r) => r.method === 'DELETE' && r.path === '/repos/team/app/keys/5'), 'the uploaded key is deleted again');
    await assert.rejects(fs.stat(p.repoConf('app')));
    await assert.rejects(fs.stat(p.repoDir('app')), 'the directory this run created is gone with its key pair');
    noSecrets(o);
    // The forge cannot delete the key: the output says what to delete by hand.
    script['DELETE /repos/team/app/keys/5'] = [403, { message: 'nope' }];
    const o2 = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o2, forgeOverride }), 1);
    assert.match(o2.err(), /delete the deploy key "flipd@\S+" \(id 5\)/);
    noSecrets(o2);
    // Fix the cause: the retry succeeds from scratch.
    script['POST /repos/team/app/hooks'] = [201, { id: 9 }];
    const o3 = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o3, forgeOverride }), 0);
    await fs.stat(p.repoConf('app'));
    noSecrets(o3);
  } finally {
    await f.close();
  }
});

test('add with an account: an existing webhook with the same URL is left alone, and --key uploads no deploy key', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, [{ id: 3, config: { url: 'https://deploy.example.com/deploy' } }, { id: 4, config: { url: 'https://elsewhere/deploy' } }]],
  });
  try {
    const shared = path.join(p.etc, 'machine.key');
    await fs.writeFile(shared, 'k');
    await fs.writeFile(`${shared}.pub`, 'ssh-ed25519 AAAAmachine flipd-machine');
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app', '--key', shared], { paths: p, ...o, forgeOverride }), 0);
    assert.ok(!f.seen.some((r) => r.method === 'POST'), 'no key upload, no hook creation');
    assert.match(await fs.readFile(p.repoConf('app'), 'utf8'), new RegExp(`^KEY=${shared}$`, 'm'));
    await assert.rejects(fs.stat(path.join(p.repoDir('app'), 'key')));
    assert.match(o.out(), /webhook present\s+https:\/\/deploy\.example\.com\/deploy \(id 3\)/);
    assert.match(o.out(), /refused 401/);
    assert.match(o.out(), /collaborator/);
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: --key and an empty hooks list uploads no deploy key but still creates exactly one webhook', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/hooks': [201, { id: 9 }],
  });
  try {
    const shared = path.join(p.etc, 'machine.key');
    await fs.writeFile(shared, 'k');
    await fs.writeFile(`${shared}.pub`, 'ssh-ed25519 AAAAmachine flipd-machine');
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app', '--key', shared], { paths: p, ...o, forgeOverride }), 0);
    assert.ok(!f.seen.some((r) => r.method === 'POST' && r.path === '/repos/team/app/keys'), 'no key upload');
    assert.equal(f.seen.filter((r) => r.method === 'POST' && r.path === '/repos/team/app/hooks').length, 1, 'exactly one webhook created');
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: a failed conf write after the forge writes succeeded deletes the uploaded key but leaves the webhook, and says so', async () => {
  if (process.getuid?.() === 0) return;   // root ignores mode bits; nothing to assert
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/keys': [201, { id: 5 }],
    'POST /repos/team/app/hooks': [201, { id: 9 }],
    'DELETE /repos/team/app/keys/5': [204, ''],
  });
  try {
    await fs.chmod(p.reposDir, 0o500);
    try {
      const o = io();
      assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 1);
      assert.match(o.err(), /no repo config was written/);
      assert.ok(f.seen.some((r) => r.method === 'DELETE' && r.path === '/repos/team/app/keys/5'), 'the uploaded key is deleted again');
      // The webhook this run created has no delete call at all (lib/forge.mjs
      // has none): a leftover webhook is harmless (no secret to leak) and
      // self-healing (the next add's listHooks finds it by URL and reuses
      // it), unlike the key, which a re-upload would reject as a duplicate.
      // So the message must not read as a clean slate — it names what survives.
      assert.match(o.err(), /webhook https:\/\/deploy\.example\.com\/deploy \(id 9\) was already created.*left in place/);
      assert.match(o.err(), /add again will find and reuse it/);
      noSecrets(o);
    } finally {
      await fs.chmod(p.reposDir, 0o755);
    }
    await assert.rejects(fs.stat(p.repoConf('app')));
    await assert.rejects(fs.stat(p.repoDir('app')), 'the directory this run created is gone with its key pair');
  } finally {
    await f.close();
  }
});

test('add with an account: a bug in the forge client (not a ForgeError, no .code) still surfaces after undo runs, unlike an operational failure', async () => {
  const { p, f, forgeOverride: baseOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/keys': [201, { id: 5 }],
    'DELETE /repos/team/app/keys/5': [204, ''],
  });
  try {
    // A TypeError thrown by addHook — a defect, not a rejected call — has no
    // .code and is not a ForgeError, so it is the one case that must not be
    // reported as an ordinary "nothing was written; fix the cause" failure.
    const forgeOverride = (c) => ({ ...baseOverride(c), addHook: async () => { throw new TypeError('boom'); } });
    const o = io();
    await assert.rejects(add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), TypeError);
    assert.ok(f.seen.some((r) => r.method === 'DELETE' && r.path === '/repos/team/app/keys/5'), 'the uploaded key is deleted again even though the error surfaces');
    await assert.rejects(fs.stat(p.repoConf('app')));
    await assert.rejects(fs.stat(p.repoDir('app')));
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: ensureKey failing after its mkdir (ssh-keygen missing) still removes the directory it created', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
  });
  // ensureKey's own mkdir succeeds (there is nothing yet to stop it), then
  // ssh-keygen itself fails to spawn — the property fix round 1 exists for:
  // dirExisted has to be known before ensureKey runs, because this failure
  // happens inside ensureKey, after its mkdir, before it returns anything.
  const scratch = await tmpdir('rd-no-ssh-keygen');   // empty: no ssh-keygen on PATH
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = scratch;
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 1);
    assert.match(o.err(), /ENOENT|no such file/i);
    assert.match(o.err(), /no repo config was written/);
    await assert.rejects(fs.stat(p.repoDir('app')), 'the directory ensureKey created is gone even though the failure is inside ensureKey itself');
    await assert.rejects(fs.stat(p.repoConf('app')));
    noSecrets(o);
  } finally {
    process.env.PATH = prevPath;
    await f.close();
  }
});

test('add with an account: an SSH host that differs from the API host is named as a warning, with the ssh-keyscan command to record it', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@git.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/keys': [201, { id: 5 }],
    'POST /repos/team/app/hooks': [201, { id: 9 }],
  });
  try {
    const o = io();
    // git.example.com, not forge.example.com (the account host, and the URL's
    // own host): a forge's SSH_DOMAIN setting can do exactly this.
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 0);
    assert.match(o.out(), /ssh host\s+git\.example\.com is not forge\.example\.com/);
    assert.match(o.out(), new RegExp(`ssh-keyscan git\\.example\\.com >> ${p.knownHosts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // No scan is run on the operator's behalf — a fingerprint has to be
    // compared by a person, which is the whole point of the step.
    assert.ok(!f.seen.some((r) => r.path.includes('keyscan')), 'add never calls out for a key itself');
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: the ssh-keyscan command for a differing SSH host carries its non-default port, so the recorded key is the one ssh will look up', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'ssh://git@git.example.com:2222/team/app.git' }],
    'GET /repos/team/app/hooks': [200, []],
    'POST /repos/team/app/keys': [201, { id: 5 }],
    'POST /repos/team/app/hooks': [201, { id: 9 }],
  });
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 0);
    // ssh connecting on 2222 looks the key up under `[git.example.com]:2222`,
    // which is what `ssh-keyscan -p 2222` writes; a scan of port 22 writes a
    // line ssh would never match, and the first build would still fail on
    // host key verification after the operator followed the instruction.
    assert.match(o.out(), /ssh host\s+git\.example\.com:2222 is not forge\.example\.com/);
    assert.match(o.out(), new RegExp(`ssh-keyscan -p 2222 git\\.example\\.com >> ${p.knownHosts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: a malformed flipd.conf is reported by name and message, not the install.sh placeholder', async () => {
  const p = await makePrefix();
  await fs.writeFile(p.mainConf, 'LISTEN=127.0.0.1:0\n');   // no WEBHOOK_SECRET: parseMain refuses to load it
  await writeAccountConf(p, 'forge.example.com', { KIND: 'forgejo', TOKEN: 'tokVALUE' });
  const f = await fakeForge({});
  const forgeOverride = (c) => createForge({ ...c, api: f.api });
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 1);
    assert.match(o.err(), new RegExp(p.mainConf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(o.err(), /WEBHOOK_SECRET is required/);
    assert.ok(!o.err().includes('install.sh'), 'a parse error in flipd.conf is not the missing-installer message');
    assert.equal(f.seen.length, 0, 'refused before any forge request');
    await assert.rejects(fs.stat(p.repoConf('app')));
    await assert.rejects(fs.stat(p.repoDir('app')));
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account: no flipd.conf at all still reports PUBLIC_HOST is not set, the installer-not-run-yet case', async () => {
  const p = await makePrefix();
  await writeAccountConf(p, 'forge.example.com', { KIND: 'forgejo', TOKEN: 'tokVALUE' });
  const f = await fakeForge({});
  const forgeOverride = (c) => createForge({ ...c, api: f.api });
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 1);
    assert.match(o.err(), /PUBLIC_HOST is not set/);
    assert.match(o.err(), /install\.sh/);
    assert.equal(f.seen.length, 0, 'refused before any forge request');
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add refuses a URL carrying credentials in its userinfo, before creating anything, and never echoes it', async () => {
  const p = await makePrefix();
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  const o = io();
  assert.equal(await add(['https://user:s3cr3t-token@forge.example.com/o/r'], { paths: p, ...o }), 1);
  assert.match(o.err(), /credentials in the URL/);
  assert.ok(!o.err().includes('s3cr3t-token') && !o.err().includes('forge.example.com/o/r'), 'the URL itself is never echoed back');
  await assert.rejects(fs.stat(p.repoConf('r')));
  await assert.rejects(fs.stat(p.repoDir('r')));
});

test('add with an account: an existing hook is matched despite a trailing slash and a differently-cased host, so no duplicate is created', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/team/app': [200, { id: 12, ssh_url: 'git@forge.example.com:team/app.git' }],
    'GET /repos/team/app/hooks': [200, [{ id: 3, config: { url: 'https://Deploy.Example.com/deploy/' } }]],
    'POST /repos/team/app/keys': [201, { id: 5 }],
  });
  try {
    const o = io();
    assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o, forgeOverride }), 0);
    assert.ok(!f.seen.some((r) => r.method === 'POST' && r.path === '/repos/team/app/hooks'), 'no duplicate hook is created for the differently-spelled match');
    assert.match(o.out(), /webhook present\s+https:\/\/deploy\.example\.com\/deploy \(id 3\)/);
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add with an account of KIND github: the GitHub request shapes reach the fake through the real client', async () => {
  const { p, f, forgeOverride } = await accountSetup({
    'GET /repos/o/r': [200, { id: 1, ssh_url: 'git@github.com:o/r.git' }],
    'GET /repos/o/r/hooks': [200, []],
    'POST /repos/o/r/keys': [201, { id: 5 }],
    'POST /repos/o/r/hooks': [201, { id: 9 }],
  }, { KIND: 'github', TOKEN: 'ghTOKENvalue' });
  try {
    // The account is keyed by forge.example.com regardless of KIND (KIND only
    // selects the request shapes createForge builds); the URL still names the
    // host the account conf was written under.
    const o = io();
    assert.equal(await add(['https://forge.example.com/o/r'], { paths: p, ...o, forgeOverride }), 0);
    const keyReq = f.seen.find((r) => r.method === 'POST' && r.path === '/repos/o/r/keys');
    assert.equal(keyReq.headers.authorization, 'Bearer ghTOKENvalue', 'GitHub auth, not the Gitea-family "token" scheme');
    assert.equal(keyReq.headers.accept, 'application/vnd.github+json');
    assert.equal(keyReq.headers['x-github-api-version'], '2022-11-28');
    const hookReq = f.seen.find((r) => r.method === 'POST' && r.path === '/repos/o/r/hooks');
    assert.deepEqual(hookReq.body, { name: 'web', active: true, events: ['push'], config: { url: 'https://deploy.example.com/deploy', content_type: 'json', secret: 'testsecret' } });
    assert.match(await fs.readFile(p.repoConf('r'), 'utf8'), /^REPO=git@github\.com:o\/r\.git$/m);
    noSecrets(o);
  } finally {
    await f.close();
  }
});

test('add: an account conf that exists but cannot be parsed stops add loudly instead of falling back to the manual path', async () => {
  const p = await makePrefix();
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  await writeAccountConf(p, 'forge.example.com', { KIND: 'nope', TOKEN: 'tokVALUE' });
  const o = io();
  assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...o }), 1);
  assert.match(o.err(), new RegExp(p.accountConf('forge.example.com').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(o.err(), /KIND must be/);
  await assert.rejects(fs.stat(p.repoConf('app')));
  await assert.rejects(fs.stat(p.repoDir('app')));
  noSecrets(o);
  // No account conf at all: the manual path, exactly as before.
  await fs.rm(p.accountConf('forge.example.com'));
  const m = io();
  assert.equal(await add(['https://forge.example.com/team/app'], { paths: p, ...m }), 0);
  assert.match(await fs.readFile(p.repoConf('app'), 'utf8'), /^REPO=https:\/\/forge\.example\.com\/team\/app$/m, 'a non-GitHub URL is written verbatim on the manual path');
  assert.match(m.out(), /^2\. add the webhook/m);
});
