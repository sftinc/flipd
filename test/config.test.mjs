// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../lib/paths.mjs';
import { ConfigError, MAIN_KEYS, parseKV, parseMain, parseRepo, loadRepos, loadEnvFile, parseAccount, loadAccount } from '../lib/config.mjs';
import { makePrefix, writeAccountConf } from './helpers.mjs';

test('parseKV: trims, ignores blanks and comments, keeps everything after the first =', () => {
  const m = parseKV('  A = 1 \n\n# note\nB=x=y && $Z\n', null);
  assert.deepEqual([...m], [['A', '1'], ['B', 'x=y && $Z']]);
});

test('parseKV: unknown key and malformed line name the line', () => {
  assert.throws(() => parseKV('A=1\nBUILD_CMD=x', new Set(['A'])), (e) => e instanceof ConfigError && /^line 2: unknown key$/.test(e.message));
  assert.throws(() => parseKV('nonsense', null), /line 1/);
});

test('parseKV: every arm reports the line number and nothing else — not the line, not the "key"', () => {
  // The line that failed to parse is the one line no mask can cover: a file that
  // did not parse contributes nothing to the attempt log's mask, and
  // flipd.conf's malformed line is the WEBHOOK_SECRET itself. These
  // messages reach journald (through serve's startup), the operator's terminal,
  // the attempt log and events.log.
  //
  // All three arms, because a wrapped paste lands in different ones depending on
  // what the secret happens to contain. The `key` half of a split is not safer
  // than the line: for an env file every line is a value, and base64 is the
  // common encoding for one.
  const cases = [
    // no "=" at all: the whole line is the secret
    { text: 'sk_live_TOPSECRETVALUE', keys: null, expect: 'line 1: expected KEY=value', secret: 'sk_live_TOPSECRETVALUE' },
    { text: '  "private_key": "sk_live_TOPSECRETVALUE",', keys: null, expect: 'line 1: expected KEY=value', secret: 'sk_live_TOPSECRETVALUE' },
    // split at a character KEY_RE rejects: base64's "/" and "+", or a padding "="
    { text: 'sk-live/AKIAEXAMPLEsecretpart=tail', keys: null, expect: 'line 1: bad key', secret: 'AKIAEXAMPLEsecretpart' },
    { text: 'aGVsbG8gd29ybGQ+c2VjcmV0=', keys: null, expect: 'line 1: bad key', secret: 'aGVsbG8gd29ybGQ' },
    // a KEY_RE-legal base64url prefix, checked against a known-keys set: this is
    // the arm parseMain uses, so it is reachable for WEBHOOK_SECRET
    { text: 'aGVsbG8gd29ybGRzZWNyZXQ=', keys: MAIN_KEYS, expect: 'line 1: unknown key', secret: 'aGVsbG8gd29ybGRzZWNyZXQ' },
  ];
  for (const { text, keys, expect, secret } of cases) {
    assert.throws(() => parseKV(text, keys), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.message, expect, `unexpected message for ${JSON.stringify(text)}`);
      assert.ok(!e.message.includes(secret), `no part of the line may be echoed: ${e.message}`);
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
  assert.equal(r.buildEnvFile, '/x/etc/flipd/env/alias.build');
  assert.equal(r.key, '/x/var/lib/flipd/alias/key');
  assert.equal(r.timeout, 1200);
  assert.equal(r.onFailure, null);
  assert.equal(parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nON_FAILURE=curl x', p).onFailure, 'curl x');
  assert.equal(r.stop, null, 'STOP is optional and null when absent');
  assert.equal(parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nSTOP=sudo /usr/local/bin/drain', p).stop, 'sudo /usr/local/bin/drain');
  assert.throws(() => parseRepo('Bad Name', 'REPO=a\nBUILD=b\nDEPLOY=c', p), /name/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b', p), /DEPLOY/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nROOT=../x', p), /ROOT/);
  assert.throws(() => parseRepo('a', 'REPO=a\nBUILD=b\nDEPLOY=c\nROOT=/abs', p), /ROOT/);
});

test('loadRepos: bad file is reported, good ones load', async () => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'flipd-'));
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

test('parseAccount: kinds, API defaults, https only, TOKEN required — and no message echoes a value', () => {
  assert.deepEqual(parseAccount('forge.example.com', 'KIND=forgejo\nTOKEN=abc\n'),
    { host: 'forge.example.com', kind: 'forgejo', api: 'https://forge.example.com/api/v1', token: 'abc' });
  assert.equal(parseAccount('github.com', 'KIND=github\nTOKEN=abc\n').api, 'https://api.github.com');
  assert.equal(parseAccount('h.example', 'KIND=gitea\nAPI=https://h.example/api/v1/\nTOKEN=abc\n').api, 'https://h.example/api/v1', 'trailing slash trimmed');
  const t = 'ghp_SECRETVALUE';
  const bad = [
    `KIND=gitlab\nTOKEN=${t}\n`,                     // unknown kind
    'KIND=github\n',                                 // no token
    `KIND=github\nAPI=http://h/api\nTOKEN=${t}\n`,   // token in clear
    `KIND=github\nTOKEN=${t}\nEXTRA=1\n`,            // unknown key
    `${t}\n`,                                        // a pasted token where a line should be
    `TOKEN=${t}\n`,                                  // no kind
  ];
  for (const text of bad) {
    assert.throws(() => parseAccount('h.example', text), (e) => e instanceof ConfigError && !e.message.includes(t) && !e.message.includes('gitlab'), text);
  }
});

test('loadAccount: null when the file is absent, the parsed forge when present, a throw when present but bad', async () => {
  const p = await makePrefix();
  assert.equal(await loadAccount(p, 'forge.example.com'), null);
  await writeAccountConf(p, 'forge.example.com', { KIND: 'forgejo', TOKEN: 'abc' });
  assert.equal((await loadAccount(p, 'forge.example.com')).kind, 'forgejo');
  await writeAccountConf(p, 'bad.example', { KIND: 'nope', TOKEN: 'abc' });
  await assert.rejects(loadAccount(p, 'bad.example'), ConfigError);
  await assert.rejects(loadAccount(p, '../etc'), (e) => e.code === 'EBADHOST');
});
