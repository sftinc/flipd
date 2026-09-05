// lib/run.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from './config.mjs';
import { anyMatches } from './glob.mjs';
import { readState, writeState } from './state.mjs';
import { openAttemptLog, appendEvent, pruneLogs, compareIds, makeScrubber } from './log.mjs';
import { runCommand } from './exec.mjs';
import { gitEnv, cloneBare, remoteUrl, fetchBranch, changedFiles, worktreeAdd, worktreeRemove, worktreePrune, shortSha, isBareRepo, GitError } from './git.mjs';

class Stop extends Error {
  constructor(outcome, detail) {
    super(detail);
    this.outcome = outcome;
  }
}

export function resolveRollbackTarget(state) {
  const target = state.pending ? state.live : state.previous;
  return target && state.releases[target] ? target : null;
}

// `extra` is the env file's map, read once when the attempt opened.
export function commandEnv(ctx, repo, phase, { releaseId, sha, previousSha, attemptId }, extra = new Map()) {
  const file = phase === 'build' ? repo.buildEnvFile : repo.deployEnvFile;
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: ctx.paths.lib,
    DEPLOY_REPO: repo.repo,
    DEPLOY_BRANCH: repo.branch,
    DEPLOY_SHA: sha,
    DEPLOY_PREVIOUS_SHA: previousSha ?? '',
    DEPLOY_RELEASE_DIR: path.join(ctx.paths.repoDir(repo.name), 'releases', releaseId),
    DEPLOY_RELEASE_ID: releaseId,
    DEPLOY_ATTEMPT_ID: attemptId,
    DEPLOY_NAME: repo.name,
  };
  // remote-deploy's own variables win. An env file that tries to replace PATH or HOME,
  // or to set any DEPLOY_* name, gets a warning line, not a different environment.
  const refused = [];
  for (const [k, v] of extra) {
    if (k in env || k.startsWith('DEPLOY_')) refused.push(k);
    else env[k] = v;
  }
  return { env, keys: [...extra.keys()].filter((k) => !refused.includes(k)), refused, file };
}

export async function runEntry(ctx, entry) {
  const { paths: p, main, repo, now } = ctx;
  const name = repo.name;
  const dir = p.repoDir(name);
  const logDir = p.repoLog(name);
  const gitDir = path.join(dir, 'git');
  const gitOpts = { env: gitEnv({ key: repo.key, knownHosts: p.knownHosts, home: p.lib }) };
  await fs.mkdir(path.join(dir, 'releases'), { recursive: true });

  let state = await readState(dir);
  if (entry.kind === 'webhook' && state.pending) {
    await appendEvent(logDir, 'refused', `pending ${state.pending}; run remote-deploy rollback ${name} or remote-deploy run ${name}`);
    return 'refused';
  }

  // Step 0: open. Both env files are read once, now: their values are masked in
  // everything this attempt writes, and the commands see this snapshot. Each
  // file's parse error is tracked against its own phase, not the other one's —
  // a malformed deploy env file must not turn a build failure into existence
  // before build even had a chance to run.
  const envFiles = { build: null, deploy: null, buildError: null, deployError: null };
  try {
    envFiles.build = await loadEnvFile(repo.buildEnvFile);
  } catch (e) {
    envFiles.buildError = e;
  }
  try {
    envFiles.deploy = await loadEnvFile(repo.deployEnvFile);
  } catch (e) {
    envFiles.deployError = e;
  }
  const mask = [...(envFiles.build?.values() ?? []), ...(envFiles.deploy?.values() ?? [])];
  const log = await openAttemptLog(logDir, { now, maxBytes: main.logMaxBytes, mask });
  if (entry.kind === 'webhook' && state.github_id === null && Number.isInteger(entry.githubId)) {
    state.github_id = entry.githubId;   // the worker is the only writer of state.json
  }
  const started = now();
  const forced = entry.kind === 'manual' || entry.forced === true;
  const last = { attempt: log.id, trigger: entry.kind, sha: null, release: null, outcome: null, started: started.toISOString(), finished: null, log: log.file };
  // Persisted now, so a crash anywhere in this attempt leaves `last.finished`
  // null on disk, which is what startup reads as "interrupted".
  state.last = last;
  await writeState(dir, state);
  let phase = 'fetch';   // which step is active, for classifying an unexpected error
  const stepTimes = {};
  const step = async (label) => { stepTimes[label] = Date.now(); await log.line(`step ${label}`); };
  const done = async (label, extra = '') => { await log.line(`step ${label} done ${Date.now() - stepTimes[label]}ms${extra ? ' ' + extra : ''}`); };
  await appendEvent(logDir, 'started', `${log.id} ${entry.kind} ${log.file}`);
  await log.line(`remote-deploy attempt ${log.id}  name=${name}  trigger=${entry.kind}${entry.target ? `  target release=${entry.target}` : ''}`);
  await log.line(`repo=${repo.repo}  branch=${repo.branch}  root=${repo.root}`);
  await fs.rm(path.join(dir, 'current.tmp'), { force: true });

  const liveSha = state.live ? state.releases[state.live]?.sha ?? null : null;
  let exitCodes = {};

  const runPhase = async (which, command, cwd, ids) => {
    phase = which;
    if (ctx.signal?.aborted) throw new Stop('interrupted', `${which} not started: service shutting down`);
    const envError = which === 'build' ? envFiles.buildError : envFiles.deployError;
    if (envError) throw new Stop(which === 'build' ? 'build failed' : 'deploy failed', `env file: ${envError.message}`);
    const { env, keys, refused, file } = commandEnv(ctx, repo, which, ids, envFiles[which]);
    await log.line(`${which} env from ${file}: ${keys.join(' ') || '(none)'}`);
    if (refused.length) await log.line(`${which} env: refused ${refused.join(' ')} (remote-deploy's own variables win)`);
    await log.line(`${which}: ${command}`);
    const r = await runCommand({ command, cwd, env, timeoutSec: repo.timeout, onOutput: (c) => log.output(c), signal: ctx.signal, graceMs: ctx.graceMs });
    exitCodes[which] = r.timedOut ? `timeout after ${repo.timeout}s` : r.code ?? `signal ${r.signal}`;
    await log.line(`${which} exit ${exitCodes[which]}`);
    if (r.killedBy === 'shutdown') throw new Stop('interrupted', `${which} interrupted by service shutdown`);
    return r.code === 0 && !r.timedOut;
  };

  const flip = async (releaseId) => {
    phase = 'flip';
    // Never create a new unconfirmed `pending` while the service is stopping.
    if (ctx.signal?.aborted) throw new Stop('interrupted', 'flip not started: service shutting down');
    await step('flip');
    state.pending = releaseId;
    await writeState(dir, state);
    const tmp = path.join(dir, 'current.tmp');
    await fs.rm(tmp, { force: true });
    await fs.symlink(path.join('releases', releaseId), tmp);
    await fs.rename(tmp, path.join(dir, 'current'));
    await done('flip', `current -> releases/${releaseId}`);
  };

  const deploy = async (releaseId, rel, previousSha) => {
    await step('deploy');
    const cwd = path.join(dir, 'releases', releaseId, rel.root);
    const ok = await runPhase('deploy', rel.deploy, cwd, { releaseId, sha: rel.sha, previousSha, attemptId: log.id });
    await done('deploy');
    if (!ok) throw new Stop('deploy failed', `DEPLOY exited ${exitCodes.deploy}`);
    // Confirmed. Written in terms of the target, whatever roles have moved
    // meanwhile, and `last` is finalised in the same write, so a crash between
    // here and close cannot relabel a confirmed deploy as interrupted.
    if (state.live !== releaseId) state.previous = state.live;
    state.live = releaseId;
    state.pending = null;
    last.outcome = 'ok';
    last.finished = now().toISOString();
    await writeState(dir, state);
  };

  let outcome = 'ok';
  let detail = '';
  try {
    if (entry.kind === 'rollback') {
      const rel = state.releases[entry.target];
      if (!rel) throw new Stop('deploy failed', `target release ${entry.target} is not in state`);
      last.sha = rel.sha;
      last.release = entry.target;
      await log.line(`rollback to ${entry.target} sha=${rel.sha}`);
      await flip(entry.target);
      await deploy(entry.target, rel, liveSha);
    } else {
      // Step 1: fetch.
      phase = 'fetch';
      await step('fetch');
      let sha;
      const gitRun = { ...gitOpts, signal: ctx.signal, onOutput: (c) => log.output(c) };
      try {
        if (!(await isBareRepo(gitDir))) {
          await fs.rm(gitDir, { recursive: true, force: true });   // nothing, or a directory that never became a clone
          await log.line(`clone --bare ${repo.repo}`);
          await cloneBare(repo.repo, gitDir, gitRun);   // to git.partial, then renamed: never a half-clone at gitDir
        } else {
          const origin = await remoteUrl(gitDir, gitOpts);
          if (origin !== repo.repo) {
            throw new Stop('fetch failed', `REPO changed: clone has ${origin}, config says ${repo.repo}; run remote-deploy check ${name} --set-remote`);
          }
        }
        sha = await fetchBranch(gitDir, repo.branch, gitRun);
      } catch (e) {
        if (e instanceof Stop) throw e;
        if (e instanceof GitError && e.aborted) throw new Stop('interrupted', 'fetch interrupted by service shutdown');
        if (e instanceof GitError) throw new Stop('fetch failed', `${e.message}\n${e.stderr}`);
        throw e;
      }
      last.sha = sha;
      await done('fetch', `head ${sha}`);

      // Step 2: compare.
      if (!forced && liveSha === sha) throw new Stop('skipped', `${shortSha(sha)}: already live`);
      if (!forced && liveSha && (repo.watch.length || repo.ignore.length)) {
        const files = await changedFiles(gitDir, liveSha, sha, gitOpts);
        await log.line(`changed since live: ${files.length} file(s)`);
        if (files.length === 0) {
          await log.line('empty diff: an empty commit means "redeploy this", so the filter is bypassed');
        } else if (!anyMatches(files, repo.watch, repo.ignore)) {
          throw new Stop('skipped', `${shortSha(sha)}: nothing changed under ${repo.watch.join(' ') || '*'}${repo.ignore.length ? ` (ignoring ${repo.ignore.join(' ')})` : ''}`);
        }
      }

      // Step 3: checkout.
      phase = 'checkout';
      if (ctx.signal?.aborted) throw new Stop('interrupted', 'checkout not started: service shutting down');
      const releaseId = `${log.id}-${shortSha(sha)}`;
      const relDir = path.join(dir, 'releases', releaseId);
      await step('checkout');
      try {
        await worktreeAdd(gitDir, relDir, sha, gitRun);
      } catch (e) {
        if (e instanceof GitError && e.aborted) throw new Stop('interrupted', 'checkout interrupted by service shutdown');
        if (e instanceof GitError) throw new Stop('checkout failed', `${e.message}\n${e.stderr}`);
        throw e;
      }
      last.release = releaseId;
      state.releases[releaseId] = { sha, root: repo.root, deploy: repo.deploy, built: now().toISOString() };
      await writeState(dir, state);
      await done('checkout', relDir);

      // Step 4: build.
      await step('build');
      const cwd = path.join(relDir, repo.root);
      const ok = await runPhase('build', repo.build, cwd, { releaseId, sha, previousSha: liveSha, attemptId: log.id });
      await done('build');
      if (!ok) throw new Stop('build failed', `BUILD exited ${exitCodes.build}`);

      // Steps 5 and 6.
      await flip(releaseId);
      await deploy(releaseId, state.releases[releaseId], liveSha);
    }
  } catch (e) {
    if (e instanceof Stop) {
      outcome = e.outcome;
      detail = e.message;
    } else {
      // Not a command failure: a malformed env file, a permissions error, a bug.
      // Classified by the step that was active, so a bad deploy env file after
      // the flip reads as "deploy failed" with the rollback line, not as a fetch.
      outcome = { fetch: 'fetch failed', checkout: 'checkout failed', build: 'build failed', flip: 'deploy failed', deploy: 'deploy failed' }[phase];
      detail = `unexpected during ${phase}: ${e.message}`;
      ctx.journal(`[${name}] attempt ${log.id} failed during ${phase}: ${e.stack ?? e}`);
    }
  }

  // Step 7: prune, after every outcome, unless a rollback is mid-acceptance for
  // this repo: its target is not known yet, so nothing can be safely removed.
  try {
    const prot = ctx.protectedTargets(name);
    if (prot.reserved) await log.line('prune deferred: a rollback is being accepted');
    else await prune({ dir, gitDir, gitOpts, logDir, main, state, protect: prot.targets });
  } catch (e) {
    ctx.journal(`[${name}] prune failed: ${e.message}`);
    await log.line(`prune failed: ${e.message}`);
  }

  // Step 8: close.
  const finished = now();
  last.outcome = outcome;
  last.finished = last.finished ?? finished.toISOString();
  state.last = last;
  await writeState(dir, state);
  const secs = ((finished - started) / 1000).toFixed(1);
  await log.line(`outcome: ${outcome}${detail ? `  ${detail}` : ''}`);
  await log.line(`exit codes: ${Object.entries(exitCodes).map(([k, v]) => `${k}=${v}`).join(' ') || '(no commands ran)'}  duration ${secs}s`);
  if (state.pending) {
    await log.line(`next: remote-deploy rollback ${name}   (current is flipped to ${state.pending} but it is not confirmed)`);
  } else if (outcome !== 'ok' && outcome !== 'skipped') {
    await log.line(`next: fix, push, or remote-deploy run ${name}`);
  }
  await log.close();
  const event = outcome === 'skipped' ? 'skipped' : outcome === 'fetch failed' ? 'fetch-failed' : outcome === 'interrupted' ? 'interrupted' : 'finished';
  await appendEvent(logDir, event, `${log.id} ${outcome} ${secs}s ${log.file}${detail && (event === 'skipped' || event === 'fetch-failed') ? `  ${detail.split('\n')[0]}` : ''}`);

  // Step 9: notify. Cannot change the outcome; its own result is one events line.
  if (outcome !== 'ok' && outcome !== 'skipped') {
    await runOnFailure(ctx, repo, { attemptId: log.id, outcome, sha: last.sha, releaseId: last.release, logFile: log.file, envFile: envFiles.deploy ?? new Map() });
  }
  return outcome;
}

// Never throws. Does not take the shutdown signal: a restart mid-deploy is
// exactly when a message is wanted, so during shutdown it runs with an eight
// second cap that fits inside systemd's stop timeout.
export async function runOnFailure(ctx, repo, { attemptId, outcome, sha, releaseId, logFile, envFile }) {
  if (!repo.onFailure) return;
  const { paths: p } = ctx;
  const logDir = p.repoLog(repo.name);
  try {
    const extra = envFile ?? (await loadEnvFile(repo.deployEnvFile).catch(() => new Map()));
    const { env } = commandEnv(ctx, repo, 'deploy', { releaseId: releaseId ?? '', sha: sha ?? '', previousSha: '', attemptId }, extra);
    env.DEPLOY_OUTCOME = outcome;
    env.DEPLOY_LOG = logFile ?? '';
    const scrub = makeScrubber([...extra.values()]);
    let out = '';
    const r = await runCommand({ command: repo.onFailure, cwd: p.repoDir(repo.name), env, timeoutSec: ctx.signal?.aborted ? 8 : 60, onOutput: (c) => { if (out.length < 65536) out += c; }, graceMs: 2000 });
    const code = r.timedOut ? 'timeout' : r.code ?? `signal ${r.signal}`;
    const first = scrub(out).trim().split('\n')[0].slice(0, 200);
    await appendEvent(logDir, 'notified', `${attemptId} exit ${code}${first ? `  ${first}` : ''}`);
  } catch (e) {
    ctx.journal?.(`[${repo.name}] ON_FAILURE could not run: ${e.message}`);
    await appendEvent(logDir, 'notified', `${attemptId} failed to run: ${e.message.split('\n')[0].slice(0, 200)}`).catch(() => {});
  }
}

async function prune({ dir, gitDir, gitOpts, logDir, main, state, protect }) {
  const keepSet = new Set([state.live, state.previous, state.pending, ...protect].filter(Boolean));
  const relDir = path.join(dir, 'releases');
  let names = [];
  try { names = await fs.readdir(relDir); } catch { /* none yet */ }
  // Newest first: by recorded build time when known, else by id.
  const key = (n) => state.releases[n]?.built ?? '';
  names.sort((a, b) => (key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : compareIds(b, a)));
  const candidates = names.filter((n) => !keepSet.has(n));
  for (const n of candidates.slice(main.keep)) {
    const target = path.join(relDir, n);
    await worktreeRemove(gitDir, target, gitOpts);
    await fs.rm(target, { recursive: true, force: true });
    delete state.releases[n];
  }
  try { await fs.stat(gitDir); await worktreePrune(gitDir, gitOpts); } catch { /* no clone yet */ }
  const present = new Set(await fs.readdir(relDir).catch(() => []));
  for (const id of Object.keys(state.releases)) if (!present.has(id)) delete state.releases[id];
  await pruneLogs(logDir, main.logKeep);
}
