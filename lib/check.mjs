// lib/check.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.mjs';
import { gitEnv, cloneBare, remoteUrl, setRemoteUrl, lsRemote, shortSha, isBareRepo } from './git.mjs';

// Runs on the worker. Returns rows for the CLI to print; never throws for an
// ordinary failure, so a check that finds a problem is a row, not a stack.
export async function runCheck({ paths: p, repo, signal }, { setRemote = false } = {}) {
  const rows = [];
  let passed = true;
  let behind = false;
  const row = (k, v) => rows.push([k, v]);
  row('config', `ok  ${p.repoConf(repo.name)}`);
  try { await fs.stat(repo.key); row('key', `ok  ${repo.key}`); }
  catch { row('key', `MISSING  ${repo.key}  (run: sudo remote-deploy add ${repo.repo} --name ${repo.name})`); passed = false; }

  const gitDir = path.join(p.repoDir(repo.name), 'git');
  // Every git call here is bounded: a hung ls-remote must not wedge shutdown.
  const opts = { env: gitEnv({ key: repo.key, knownHosts: p.knownHosts, home: p.lib }), signal, timeoutMs: 120000 };
  try {
    if (!(await isBareRepo(gitDir))) {
      await fs.rm(gitDir, { recursive: true, force: true });
      await fs.mkdir(p.repoDir(repo.name), { recursive: true });
      await cloneBare(repo.repo, gitDir, opts);   // clones to git.partial, then renames
      row('clone', `created ${gitDir}`);
    } else {
      row('clone', `ok  ${gitDir}`);
    }
    const origin = await remoteUrl(gitDir, opts);
    if (origin === repo.repo) row('remote', `ok  ${origin}`);
    else if (setRemote) { await setRemoteUrl(gitDir, repo.repo, opts); row('remote', `repointed  ${origin}  ->  ${repo.repo}`); }
    else { row('remote', `MISMATCH  clone has ${origin}, config says ${repo.repo}  (run: remote-deploy check ${repo.name} --set-remote)`); passed = false; }
    const head = await lsRemote(repo.repo, repo.branch, opts);
    const state = await readState(p.repoDir(repo.name));
    const liveSha = state.live ? state.releases[state.live]?.sha : null;
    if (!head) { row(repo.branch, `MISSING on ${repo.repo}`); passed = false; }
    else {
      behind = liveSha !== head;
      row(repo.branch, `${shortSha(head)}  (live: ${liveSha ? shortSha(liveSha) : 'none'})${behind ? '  behind' : '  up to date'}`);
    }
    if (state.pending) { behind = true; row('pending', `${state.pending} is flipped but unconfirmed  (run: remote-deploy rollback ${repo.name} or remote-deploy run ${repo.name})`); }
  } catch (e) {
    row('git', `FAIL  ${e.message}${e.stderr ? `\n${e.stderr.trim().slice(0, 2000)}` : ''}`);
    passed = false;
  }
  return { rows, passed, behind };
}
