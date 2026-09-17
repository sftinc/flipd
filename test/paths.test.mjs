import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paths, HOST_RE } from '../lib/paths.mjs';

test('paths derive from one prefix', () => {
  const p = paths('/tmp/x');
  assert.equal(p.etc, '/tmp/x/etc/flipd');
  assert.equal(p.mainConf, '/tmp/x/etc/flipd/flipd.conf');
  assert.equal(p.reposDir, '/tmp/x/etc/flipd/repos');
  assert.equal(p.envDir, '/tmp/x/etc/flipd/env');
  assert.equal(p.lib, '/tmp/x/var/lib/flipd');
  assert.equal(p.log, '/tmp/x/var/log/flipd');
  assert.equal(p.sock, '/tmp/x/run/flipd/flipd.sock');
  assert.equal(p.knownHosts, '/tmp/x/var/lib/flipd/.ssh/known_hosts');
  assert.equal(p.repoDir('a'), '/tmp/x/var/lib/flipd/a');
  assert.equal(p.repoLog('a'), '/tmp/x/var/log/flipd/a');
  assert.equal(p.envFile('a', 'build'), '/tmp/x/etc/flipd/env/a.build');
  assert.equal(p.repoConf('a'), '/tmp/x/etc/flipd/repos/a.conf');
});

test('default prefix is /', () => {
  delete process.env.FLIPD_PREFIX;
  assert.equal(paths().etc, '/etc/flipd');
});

test('per-repo paths refuse a name that is not a plain repo name', () => {
  const p = paths('/tmp/x');
  for (const bad of ['../flipd', 'a/b', '', 'Upper', '.hidden', 'x'.repeat(65)]) {
    assert.throws(() => p.repoDir(bad), /repo name/);
    assert.throws(() => p.repoLog(bad), /repo name/);
    assert.throws(() => p.envFile(bad, 'build'), /repo name/);
  }
  assert.throws(() => p.envFile('a', 'other'), /build or deploy/);
});

test('account paths: accountConf refuses anything that is not a lowercase hostname', () => {
  const p = paths('/x');
  assert.equal(p.accountsDir, '/x/etc/flipd/accounts');
  assert.equal(p.accountConf('forge.example.com'), '/x/etc/flipd/accounts/forge.example.com.conf');
  assert.equal(p.accountConf('github.com'), '/x/etc/flipd/accounts/github.com.conf');
  for (const bad of ['../flipd', 'a/b', 'Forge.Example.com', '', 'host.', '.host', '-h', 'a_b', 'a'.repeat(254), undefined]) {
    assert.throws(() => p.accountConf(bad), (e) => e.code === 'EBADHOST', `"${bad}"`);
  }
  assert.ok(HOST_RE.test('a.b-c.d1'));
});

test('caddy paths sit under the prefix, and a site file is always flipd-prefixed', () => {
  const p = paths('/tmp/pfx');
  assert.equal(p.caddyDir, '/tmp/pfx/etc/caddy/conf.d');
  assert.equal(p.caddyMain, '/tmp/pfx/etc/caddy/Caddyfile');
  assert.equal(p.domainLock, '/tmp/pfx/etc/flipd/domain.lock');
  assert.equal(p.caddySite('app'), '/tmp/pfx/etc/caddy/conf.d/flipd-app.caddy');
});

// NAME_RE accepts "flipd" as a repo name, and this repository deploys itself.
// Without the prefix that repo's site file would be install.sh's own
// /etc/caddy/conf.d/flipd.caddy — the one file the feature must never touch.
test('a repo named flipd cannot collide with the installer\'s flipd.caddy', () => {
  const p = paths('/tmp/pfx');
  assert.equal(p.caddySite('flipd'), '/tmp/pfx/etc/caddy/conf.d/flipd-flipd.caddy');
  assert.notEqual(p.caddySite('flipd'), `${p.caddyDir}/flipd.caddy`);
});

test('caddySite validates the name like every other per-repo path', () => {
  assert.throws(() => paths('/tmp/pfx').caddySite('../flipd'), { code: 'EBADNAME' });
});
