import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeSourceRepo, tmpdir } from './helpers.mjs';
import { gitEnv, cloneBare, remoteUrl, setRemoteUrl, fetchBranch, changedFiles, worktreeAdd, worktreeRemove, worktreePrune, lsRemote, shortSha, isBareRepo, redactUserinfo, GitError } from '../lib/git.mjs';

const opts = () => ({ env: gitEnv({ key: '/nonexistent/key', knownHosts: '/nonexistent/kh', home: '/tmp' }) });

test('clone, fetch, diff, worktree, ls-remote against a file:// repo', async () => {
  const src = await makeSourceRepo();
  const a = await src.commit({ 'README.md': 'a', 'mta/x.mjs': '1' });
  const work = await tmpdir('flipd-git');
  const bare = path.join(work, 'git');

  assert.equal(await isBareRepo(bare), false);
  await cloneBare(src.url, bare, opts());
  assert.equal(await isBareRepo(bare), true);
  assert.equal(await remoteUrl(bare, opts()), src.url);
  assert.equal(await fetchBranch(bare, 'main', opts()), a);

  const b = await src.commit({ 'docs/n.md': 'x' });
  assert.equal(await lsRemote(src.url, 'main', opts()), b);
  assert.equal(await fetchBranch(bare, 'main', opts()), b);
  assert.deepEqual(await changedFiles(bare, a, b, opts()), ['docs/n.md']);

  const rel = path.join(work, 'releases', 'r1');
  await fs.mkdir(path.dirname(rel), { recursive: true });
  await worktreeAdd(bare, rel, b, opts());
  assert.equal(await fs.readFile(path.join(rel, 'docs/n.md'), 'utf8'), 'x');
  await worktreeRemove(bare, rel, opts());
  await worktreePrune(bare, opts());
  await assert.rejects(fs.stat(rel));

  await setRemoteUrl(bare, 'file:///elsewhere', opts());
  assert.equal(await remoteUrl(bare, opts()), 'file:///elsewhere');
  assert.equal(shortSha(a), a.slice(0, 7));
});

test('fetch of a missing branch is a GitError with stderr', async () => {
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  const bare = path.join(await tmpdir('flipd-git'), 'git');
  await cloneBare(src.url, bare, opts());
  await assert.rejects(fetchBranch(bare, 'nope', opts()), (e) => e instanceof GitError && e.stderr.length > 0);
  assert.equal(await lsRemote(src.url, 'nope', opts()), null);
});

test('an aborted signal ends a git command', async () => {
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(lsRemote(src.url, 'main', { ...opts(), signal: ac.signal }), (e) => e instanceof GitError && e.aborted);
});

test('a timeout kills a git command and reports it', async () => {
  const src = await makeSourceRepo();
  await src.commit({ a: '1' });
  // GIT_SSH_COMMAND is only used for ssh URLs; use a URL that forces ssh to a black hole.
  // git appends the host and remote command as extra positional args to this command, so a bare
  // `sleep 30` gets flooded with non-numeric args and exits immediately instead of hanging;
  // nest it in its own `sh -c` so the appended args land on the outer shell, unused, and the
  // inner sleep actually blocks.
  const env = { ...opts().env, GIT_SSH_COMMAND: 'sh -c "sleep 30"' };
  await assert.rejects(lsRemote('git@localhost:x/y.git', 'main', { env, timeoutMs: 500, graceMs: 100 }), /timed out/);
});

test('a clone that fails leaves no bare directory behind', async () => {
  const bare = path.join(await tmpdir('flipd-git'), 'git');
  await assert.rejects(cloneBare('file:///nonexistent/repo', bare, opts()));
  assert.equal(await isBareRepo(bare), false);
  await assert.rejects(fs.stat(bare));
});

test('a failing command with a credential in the URL reports it redacted, not verbatim', async () => {
  // Port 1 on loopback: refused immediately, so this is a real git failure with
  // no network and no waiting. git redacts the credential in its own stderr;
  // the point of this test is that gitOk does not put it back by quoting argv
  // into the message that reaches the terminal, the attempt log and events.log.
  await assert.rejects(
    lsRemote('https://x-access-token:ghp_TOPSECRETTOKEN@127.0.0.1:1/o/r.git', 'main', opts()),
    (e) => {
      assert.ok(e instanceof GitError);
      assert.ok(!e.message.includes('ghp_TOPSECRETTOKEN'), `the credential must not be in the message: ${e.message}`);
      assert.ok(!e.stderr.includes('ghp_TOPSECRETTOKEN'), `nor in git's own stderr, which is logged too: ${e.stderr}`);
      assert.match(e.message, /https:\/\/\*\*\*@127\.0\.0\.1:1\/o\/r\.git/, 'the URL is still named, minus its userinfo');
      return true;
    },
  );
});

test('redactUserinfo strips both halves of a credential and leaves ordinary URLs alone', () => {
  assert.equal(redactUserinfo('clone https://u:p@github.com/o/r.git x'), 'clone https://***@github.com/o/r.git x');
  assert.equal(redactUserinfo('ssh://ghp_TOKEN@github.com/o/r.git'), 'ssh://***@github.com/o/r.git');
  assert.equal(redactUserinfo('fetch file:///srv/r.git origin'), 'fetch file:///srv/r.git origin');
  assert.equal(redactUserinfo('clone git@github.com:o/r.git'), 'clone git@github.com:o/r.git');
});

test('gitEnv pins the key and known_hosts and leaks nothing else', () => {
  const env = gitEnv({ key: '/k', knownHosts: '/kh', home: '/h' });
  assert.match(env.GIT_SSH_COMMAND, /-i '\/k' .*IdentitiesOnly=yes.*UserKnownHostsFile='\/kh'.*StrictHostKeyChecking=yes/);
  assert.equal(env.HOME, '/h');
  assert.deepEqual(Object.keys(env).sort(), ['GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
});

test('gitEnv quotes a key path containing a space as a single ssh argument', () => {
  const env = gitEnv({ key: '/has space/key', knownHosts: '/kh', home: '/h' });
  // Single-quoted, so a naive shell split sees exactly one token for -i, not two.
  assert.match(env.GIT_SSH_COMMAND, /-i '\/has space\/key' -o/);
  assert.doesNotMatch(env.GIT_SSH_COMMAND, /-i \/has /);
});
