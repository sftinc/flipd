import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl, repoIdentity } from '../lib/repourl.mjs';

test('parseRepoUrl: scp, ssh:// with port, https — and what is not an owner/repo URL', () => {
  assert.deepEqual(parseRepoUrl('git@github.com:sftinc/Alias.Route.git'), { host: 'github.com', owner: 'sftinc', repo: 'Alias.Route', name: 'alias.route' });
  assert.deepEqual(parseRepoUrl('ssh://git@Forge.Example.com:2222/team/app.git'), { host: 'forge.example.com', owner: 'team', repo: 'app', name: 'app' });
  assert.deepEqual(parseRepoUrl('https://forge.example.com/team/app/'), { host: 'forge.example.com', owner: 'team', repo: 'app', name: 'app' });
  assert.deepEqual(parseRepoUrl('https://github.com/o/r'), { host: 'github.com', owner: 'o', repo: 'r', name: 'r' });
  assert.deepEqual(parseRepoUrl('git@github.com:o/r'), { host: 'github.com', owner: 'o', repo: 'r', name: 'r' }, 'no .git suffix is fine');
  assert.equal(parseRepoUrl('file:///tmp/x'), null);
  assert.equal(parseRepoUrl('https://gitlab.com/group/sub/repo.git'), null, 'three path segments is not owner/repo');
  assert.equal(parseRepoUrl('ssh://git@[::1]/o/r.git'), null, 'an IPv6 literal is not a hostname this parser handles');
  assert.equal(parseRepoUrl('/srv/git/r.git'), null);
  assert.equal(parseRepoUrl('o/r'), null);
  assert.equal(parseRepoUrl(undefined), null);
  assert.equal(parseRepoUrl(42), null);
});

test('repoIdentity: host/owner/repo lowercased; user, port, .git and trailing slash dropped; null when unparsed', () => {
  assert.equal(repoIdentity('git@github.com:O/R.git'), 'github.com/o/r');
  assert.equal(repoIdentity('ssh://git@github.com:22/o/r'), 'github.com/o/r');
  assert.equal(repoIdentity('https://GitHub.com/o/r/'), 'github.com/o/r');
  assert.equal(repoIdentity('ssh://git@forge.example.com:2222/Team/App.git'), repoIdentity('GIT@forge.example.com:team/app'), 'the two forms a forge can render are one identity');
  assert.equal(repoIdentity('file:///x'), null);
  assert.equal(repoIdentity(null), null);
});
