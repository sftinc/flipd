import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../lib/paths.mjs';

test('paths derive from one prefix', () => {
  const p = paths('/tmp/x');
  assert.equal(p.etc, '/tmp/x/etc/remote-deploy');
  assert.equal(p.mainConf, '/tmp/x/etc/remote-deploy/remote-deploy.conf');
  assert.equal(p.reposDir, '/tmp/x/etc/remote-deploy/repos');
  assert.equal(p.envDir, '/tmp/x/etc/remote-deploy/env');
  assert.equal(p.lib, '/tmp/x/var/lib/remote-deploy');
  assert.equal(p.log, '/tmp/x/var/log/remote-deploy');
  assert.equal(p.sock, '/tmp/x/run/remote-deploy/remote-deploy.sock');
  assert.equal(p.knownHosts, '/tmp/x/var/lib/remote-deploy/.ssh/known_hosts');
  assert.equal(p.repoDir('a'), '/tmp/x/var/lib/remote-deploy/a');
  assert.equal(p.repoLog('a'), '/tmp/x/var/log/remote-deploy/a');
  assert.equal(p.envFile('a', 'build'), '/tmp/x/etc/remote-deploy/env/a.build');
  assert.equal(p.repoConf('a'), '/tmp/x/etc/remote-deploy/repos/a.conf');
});

test('default prefix is /', () => {
  delete process.env.REMOTE_DEPLOY_PREFIX;
  assert.equal(paths().etc, '/etc/remote-deploy');
});

test('per-repo paths refuse a name that is not a plain repo name', () => {
  const p = paths('/tmp/x');
  for (const bad of ['../remote-deploy', 'a/b', '', 'Upper', '.hidden', 'x'.repeat(65)]) {
    assert.throws(() => p.repoDir(bad), /repo name/);
    assert.throws(() => p.repoLog(bad), /repo name/);
    assert.throws(() => p.envFile(bad, 'build'), /repo name/);
  }
  assert.throws(() => p.envFile('a', 'other'), /build or deploy/);
});
