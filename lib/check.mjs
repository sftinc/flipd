// lib/check.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.mjs';
import { sameRepo } from './repourl.mjs';
import { gitEnv, cloneBare, remoteUrl, setRemoteUrl, lsRemote, shortSha, isBareRepo, redactUserinfo } from './git.mjs';

// The other confs a push to this one's repository also reaches, and the ones
// that look like they should. `others` is every other loaded repo conf.
//
// Two questions, deliberately two rows. `shares` is configured intent — same
// REPO, same BRANCH — and is the monorepo's normal state, not a fault. `stale`
// is history: a conf that recorded this repository's forge id under a REPO that
// no longer names it, which is what a rename updated in one conf and not the
// other leaves behind. Nothing else reports that one: ls-remote follows the
// forge's redirect, so the stale conf's own check passes while it silently
// stops receiving pushes.
async function siblingRows(p, repo, others, state, row) {
  const shares = others.filter((r) => sameRepo(r.repo, repo.repo) && r.branch === repo.branch);
  if (shares.length) {
    row('shares', `${shares.map((r) => r.name).join(', ')}  (same REPO and BRANCH: one push builds each of them, in this order, one after another — and one webhook on the forge covers them all)`);
  }
  if (state.github_id === null) return;
  const stale = [];
  for (const r of others) {
    if (sameRepo(r.repo, repo.repo)) continue;
    try {
      const s = await readState(p.repoDir(r.name));
      if (s.github_id === state.github_id) stale.push(r.name);
    } catch { /* that conf's own check reports its unreadable state */ }
  }
  if (stale.length) {
    row('stale', `${stale.map((n) => `${n} (${p.repoConf(n)})`).join(', ')}  recorded this repository's forge id under a different REPO — a rename applied here and not there; update REPO, or clear github_id in that repo's state.json if it really is another repository`);
  }
}

// Runs on the worker. Returns rows for the CLI to print; never throws for an
// ordinary failure, so a check that finds a problem is a row, not a stack.
export async function runCheck({ paths: p, repo, others = [], signal }, { setRemote = false } = {}) {
  const rows = [];
  let passed = true;
  let behind = false;
  let pending = false;
  const row = (k, v) => rows.push([k, v]);
  row('config', `ok  ${p.repoConf(repo.name)}`);
  try { await fs.stat(repo.key); row('key', `ok  ${repo.key}`); }
  catch { row('key', `MISSING  ${repo.key}  (run: sudo flipd add ${repo.repo} --name ${repo.name})`); passed = false; }

  // Read separately from the git work below: a corrupt state.json is its own
  // diagnosis, not a git failure — folding it into the git try would report
  // a JSON parse error as `git FAIL`, mislabelling it for whoever reads the
  // check's output.
  let state;
  try {
    state = await readState(p.repoDir(repo.name));
  } catch (e) {
    row('state', `FAIL  ${e.message}`);
    passed = false;
    state = { live: null, releases: {}, pending: null, github_id: null };
  }
  await siblingRows(p, repo, others, state, row);

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
    // Compared raw, printed redacted: a clone created before REPO was refused
    // credentials (or by hand) can still have a token in its stored origin, and
    // check's rows go to the operator's terminal.
    const shown = redactUserinfo(origin);
    if (origin === repo.repo) row('remote', `ok  ${shown}`);
    else if (setRemote) { await setRemoteUrl(gitDir, repo.repo, opts); row('remote', `repointed  ${shown}  ->  ${repo.repo}`); }
    else { row('remote', `MISMATCH  clone has ${shown}, config says ${repo.repo}  (run: flipd check ${repo.name} --set-remote)`); passed = false; }
    const head = await lsRemote(repo.repo, repo.branch, opts);
    const liveSha = state.live ? state.releases[state.live]?.sha : null;
    if (!head) { row(repo.branch, `MISSING on ${repo.repo}`); passed = false; }
    else {
      behind = liveSha !== head;
      row(repo.branch, `${shortSha(head)}  (live: ${liveSha ? shortSha(liveSha) : 'none'})${behind ? '  behind' : '  up to date'}`);
    }
    // Reported apart from `behind`: they call for opposite actions (`flipd run`
    // versus a look first), and the CLI gives each its own exit code.
    if (state.pending) { pending = true; row('pending', `${state.pending} is flipped but unconfirmed  (run: flipd rollback ${repo.name} or flipd run ${repo.name})`); }
  } catch (e) {
    row('git', `FAIL  ${e.message}${e.stderr ? `\n${e.stderr.trim().slice(0, 2000)}` : ''}`);
    passed = false;
  }
  return { rows, passed, behind, pending };
}
