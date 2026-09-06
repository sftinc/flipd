// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../lib/paths.mjs';
import { ConfigError, parseKV, parseMain, parseRepo, loadRepos, loadEnvFile } from '../lib/config.mjs';

test('parseKV: trims, ignores blanks and comments, keeps everything after the first =', () => {
  const m = parseKV('  A = 1 \n\n# note\nB=x=y && $Z\n', null);
  assert.deepEqual([...m], [['A', '1'], ['B', 'x=y && $Z']]);
});

test('parseKV: unknown key and malformed line name the line', () => {
  assert.throws(() => parseKV('A=1\nBUILD_CMD=x', new Set(['A'])), (e) => e instanceof ConfigError && /line 2.*BUILD_CMD/.test(e.message));
  assert.throws(() => parseKV('nonsense', null), /line 1/);
});

test('parseKV: a malformed line is reported by number only, never by quoting the line', () => {
  // The line that failed to parse is the one line no mask can cover: a file
  // that did not parse contributes nothing to the attempt log's mask, and
  // remote-deploy.conf's malformed line is the WEBHOOK_SECRET itself. This
  // message reaches journald (through serve's startup), the operator's
  // terminal, and the attempt log, so it must carry the number and nothing else.
  for (const line of ['sk_live_TOPSECRET', '  "private_key": "sk_live_TOPSECRET",', 'hunter2']) {
    assert.throws(() => parseKV(line, null), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.message, 'line 1: expected KEY=value');
      assert.ok(!e.message.includes(line.trim()), `the offending line must not be echoed: ${e.message}`);
      return true;
    });
  }
});

test('parseRepo: a REPO carrying credentials is refused, and the refusal never echoes the URL', () => {
  const p = paths('/x');
  const conf = (repo) => `REPO=${repo}\nBUILD=b\nDEPLOY=c\n`;
  for (const bad of [
    'https://x-access-token:ghp_TOPSECRETTOKEN@github.com/o/r.git',
    'https://ghp_TOPSECRETTOKEN@github.com/o/r.git',
    'ssh://git:ghp_TOPSECRETTOKEN@github.com/o/r.git',
  ]) {
    assert.throws(() => parseRepo('a', conf(bad), p), (e) => {
      assert.ok(e instanceof ConfigError, `${bad} must be refused`);
      assert.match(e.message, /credentials/);
      // The whole point: the URL is in git's argv where `ps` can see it, so the
      // refusal must not be the thing that also puts it in journald.
      assert.ok(!e.message.includes('ghp_TOPSECRETTOKEN'), `the refusal must not echo the credential: ${e.message}`);
      assert.ok(!e.message.includes(bad));
      return true;
    });
  }
  // The forms that carry no secret still load: the documented scp-style URL, a
  // plain ssh:// username, and the file:// URLs the tests themselves use.
  for (const good of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'file:///srv/repo.git', 'https://github.com/o/r.git']) {
    assert.equal(parseRepo('a', conf(good), p).repo, good);
  }
});

test('parseMain: defaults and validation', () => {
  const m = parseMain('WEBHOOK_SECRET=s\n');
  assert.deepEqual(m, { listen: { host: '127.0.0.1', port: 9000 }, publicHost: null, webhookSecret: 's', keep: 5, logKeep: 50, logMaxBytes: 52428800 });
  assert.throws(() => parseMain('LISTEN=127.0.0.1:9000'), /WEBHOOK_SECRET/);
  assert.throws(() => parseMain('WEBHOOK_SECRET=s\nKEEP=five'), /KEEP/);
  assert.equal(parseMain('WEBHOOK_SECRET=s\nLISTEN=0.0.0.0:80\nPUBLIC_HOST=d.example.com').listen.port, 80);
});

test('parseRepo: defaults, required keys, name and ROOT rules', () => {
  const p = paths('/x');
  const r = parseRepo('alias', 'REPO=git@github.com:o/r.git\nBUILD=make\nDEPLOY=./d\nWATCH=mta/** packages/**\n', p);
  assert.equal(r.branch, 'main');
  assert.equal(r.root, '.');
  assert.deepEqual(r.watch, ['mta/**', 'packages/**']);
  assert.deepEqual(r.ignore, []);
  assert.equal(r.buildEnvFile, '/x/etc/remote-deploy/env/alias.build');
  assert.equal(r.key, '/x/var/lib/remote-deploy/alias/key');
  assert.equal(r.timeout, 1200);
  assert.equal(r.onFailure, null);
  assert.equal(parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nON_FAILURE=curl x', p).onFailure, 'curl x');
  assert.throws(() => parseRepo('Bad Name', 'REPO=a\nBUILD=b\nDEPLOY=c', p), /name/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b', p), /DEPLOY/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nROOT=../x', p), /ROOT/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nROOT=/abs', p), /ROOT/);
});

test('loadRepos: bad file is reported, good ones load', async () => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-deploy-'));
  const p = paths(prefix);
  await fs.mkdir(p.reposDir, { recursive: true });
  await fs.writeFile(path.join(p.reposDir, 'good.conf'), 'REPO=a\nBUILD=b\nDEPLOY=c\n');
  await fs.writeFile(path.join(p.reposDir, 'bad.conf'), 'REPO=a\nTYPO=1\n');
  await fs.writeFile(path.join(p.reposDir, 'notes.txt'), 'ignored');
  const { repos, errors } = await loadRepos(p);
  assert.deepEqual(repos.map((r) => r.name), ['good']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'bad');
});

test('loadEnvFile: missing file is an empty map', async () => {
  assert.deepEqual([...(await loadEnvFile('/nonexistent/x.build'))], []);
});
