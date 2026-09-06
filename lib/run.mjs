// lib/run.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from './config.mjs';
import { anyMatches } from './glob.mjs';
import { readState, writeState, StateError } from './state.mjs';
import { openAttemptLog, appendEvent, pruneLogs, compareIds, makeScrubber } from './log.mjs';
import { runCommand } from './exec.mjs';
import { gitEnv, cloneBare, remoteUrl, fetchBranch, changedFiles, worktreeAdd, worktreeRemove, worktreePrune, shortSha, isBareRepo, redactUserinfo, GitError } from './git.mjs';

class Stop extends Error {
  constructor(outcome, detail) {
    super(detail);
    this.outcome = outcome;
  }
}

// Nothing in the run path bounded its git calls: git()'s timeoutMs defaults to 0,
// which means no timer at all. BatchMode and GIT_TERMINAL_PROMPT=0 rule out a
// prompt hang, but nothing sets ConnectTimeout, so a TCP session that stalls
// after a successful connect never settles — and a fetch that never settles is a
// runEntry that never returns, a queue slot that never clears, and every other
// repo starving behind it until someone restarts the service.
//
// A fixed ten minutes rather than the repo's TIMEOUT: TIMEOUT is documented as
// the cap on BUILD and separately on DEPLOY, and a repo whose build honestly
// takes twenty minutes must not thereby buy its fetch a twenty-minute stall
// window. Ten minutes is far above any real clone of a repository this tool
// builds, and a shutdown does not wait for it — ctx.signal aborts these calls.
const GIT_TIMEOUT_MS = 600000;

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
  // flipd's own variables win. An env file that tries to replace PATH or HOME,
  // or to set any DEPLOY_* name, gets a warning line, not a different environment.
  // `Object.hasOwn` (not `in`) so an own-property check doesn't walk the prototype
  // chain and falsely refuse legal keys like `toString` or `hasOwnProperty`; the
  // explicit `__proto__` arm keeps that one specific name refused regardless, since
  // `Object.hasOwn` alone would let `env.__proto__ = v` through untouched.
  const refused = [];
  for (const [k, v] of extra) {
    if (Object.hasOwn(env, k) || k === '__proto__' || k.startsWith('DEPLOY_')) refused.push(k);
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
  // ctx.gitTimeoutMs is a test seam, the way ctx.graceMs already is; the service
  // never sets it.
  const gitOpts = { env: gitEnv({ key: repo.key, knownHosts: p.knownHosts, home: p.lib }), timeoutMs: ctx.gitTimeoutMs ?? GIT_TIMEOUT_MS };
  await fs.mkdir(path.join(dir, 'releases'), { recursive: true });

  let state;
  try {
    state = await readState(dir);
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    // Unguarded, this throw escaped to queue.onError, which journals `crashed`
    // and nothing else: no attempt log, no events.log line, no state.last. The
    // repo was silently dead — every later webhook enqueued and crashed the
    // same way while `status` went on showing the last successful run.
    return await failUnreadableState(ctx, entry, { dir, logDir, name, error: e });
  }
  if (entry.kind === 'webhook' && state.pending) {
    await appendEvent(logDir, 'refused', `pending ${state.pending}; run flipd rollback ${name} or flipd run ${name}`);
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
  await log.line(`flipd attempt ${log.id}  name=${name}  trigger=${entry.kind}${entry.target ? `  target release=${entry.target}` : ''}`);
  await log.line(`repo=${repo.repo}  branch=${repo.branch}  root=${repo.root}`);
  // Best-effort: `state.last` (announcing this attempt) is already on disk, so a
  // stray permissions error here must not crash the attempt outright — flip()
  // retries the same removal right before it needs the path clear anyway.
  await fs.rm(path.join(dir, 'current.tmp'), { force: true }).catch((e) => {
    ctx.journal(`[${name}] could not clear stale current.tmp: ${e.message}`);
  });

  const liveSha = state.live ? state.releases[state.live]?.sha ?? null : null;
  let exitCodes = {};

  const runPhase = async (which, command, cwd, ids) => {
    phase = which;
    if (ctx.signal?.aborted) throw new Stop('interrupted', `${which} not started: service shutting down`);
    const envError = which === 'build' ? envFiles.buildError : envFiles.deployError;
    // parseKV names the line number and nothing else (lib/config.mjs), so the
    // message is safe to carry verbatim: no wrapping, no elision that could
    // itself be wrong about what needs eliding.
    if (envError) throw new Stop(which === 'build' ? 'build failed' : 'deploy failed', `env file: ${envError.message}`);
    const { env, keys, refused, file } = commandEnv(ctx, repo, which, ids, envFiles[which]);
    await log.line(`${which} env from ${file}: ${keys.join(' ') || '(none)'}`);
    if (refused.length) await log.line(`${which} env: refused ${refused.join(' ')} (flipd's own variables win)`);
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
      const targetCwd = path.join(dir, 'releases', entry.target, rel.root);
      // Confirm the release is actually there *before* flipping: otherwise a
      // directory removed out-of-band leaves `current` a dangling symlink with
      // `pending` set, only to fail moments later when deploy's cwd doesn't exist.
      try {
        await fs.stat(targetCwd);
      } catch {
        throw new Stop('deploy failed', `target release ${entry.target} directory is missing: ${targetCwd}`);
      }
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
            // Redacted: an existing clone's stored origin can still carry a
            // token even though config now refuses one, and this detail reaches
            // the attempt log and events.log.
            throw new Stop('fetch failed', `REPO changed: clone has ${redactUserinfo(origin)}, config says ${repo.repo}; run flipd check ${name} --set-remote`);
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
        let files = null;
        try {
          files = await changedFiles(gitDir, liveSha, sha, { ...gitOpts, signal: ctx.signal });
        } catch (e) {
          if (e instanceof GitError && e.aborted) throw new Stop('interrupted', 'compare interrupted by service shutdown');
          if (!(e instanceof GitError)) throw e;
          // Cannot compare — most likely the recorded live sha is no longer
          // reachable in the bare clone (a force-push, or a history rewrite).
          // Building is the safe default: a filter that can never be evaluated
          // must not silently and permanently wedge the repo on "skipped".
          await log.line(`cannot compare against live (${e.message.split('\n')[0]}): building instead of filtering`);
        }
        if (files) {
          await log.line(`changed since live: ${files.length} file(s)`);
          if (files.length === 0) {
            await log.line('empty diff: an empty commit means "redeploy this", so the filter is bypassed');
          } else if (!anyMatches(files, repo.watch, repo.ignore)) {
            throw new Stop('skipped', `${shortSha(sha)}: nothing changed under ${repo.watch.join(' ') || '*'}${repo.ignore.length ? ` (ignoring ${repo.ignore.join(' ')})` : ''}`);
          }
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
    // The signal matters here as much as anywhere: prune runs inside the work
    // that close() drains, so without it a `worktree remove` that hangs is not
    // interruptible and the only backstop left is systemd's stop timeout
    // SIGKILLing the process. An aborted removal leaves the directory to
    // fs.rm and a stale worktree admin entry for the next attempt's
    // `worktree prune` to clear.
    else await prune({ dir, gitDir, gitOpts: { ...gitOpts, signal: ctx.signal }, logDir, main, state, protect: prot.targets });
  } catch (e) {
    ctx.journal(`[${name}] prune failed: ${e.message}`);
    await log.line(`prune failed: ${e.message}`);
  }

  // Step 8: close. Wrapped: an I/O failure here (a full disk, a permissions
  // error) must not reject runEntry outright — that would skip step 9's
  // notification, exactly when an operator most needs it — nor stop it from
  // returning the outcome it already computed.
  const finished = now();
  const secs = ((finished - started) / 1000).toFixed(1);
  try {
    last.outcome = outcome;
    last.finished = last.finished ?? finished.toISOString();
    state.last = last;
    await writeState(dir, state);
    await log.line(`outcome: ${outcome}${detail ? `  ${detail}` : ''}`);
    await log.line(`exit codes: ${Object.entries(exitCodes).map(([k, v]) => `${k}=${v}`).join(' ') || '(no commands ran)'}  duration ${secs}s`);
    if (state.pending) {
      await log.line(`next: flipd rollback ${name}   (current is flipped to ${state.pending} but it is not confirmed)`);
    } else if (outcome !== 'ok' && outcome !== 'skipped') {
      await log.line(`next: fix, push, or flipd run ${name}`);
    }
    await log.close();
    const event = outcome === 'skipped' ? 'skipped' : outcome === 'fetch failed' ? 'fetch-failed' : outcome === 'interrupted' ? 'interrupted' : 'finished';
    // Scrubbed through the attempt's own scrubber: `detail` can hold the text of
    // a failed command, and events.log is the log flipd never prunes
    // (logrotate keeps twelve compressed months of it). The attempt log has
    // masked this same text since it was written; using the same scrubber is
    // what keeps the two sinks from diverging.
    await appendEvent(logDir, event, `${log.id} ${outcome} ${secs}s ${log.file}${detail && (event === 'skipped' || event === 'fetch-failed') ? `  ${log.scrub(detail.split('\n')[0])}` : ''}`);
  } catch (e) {
    ctx.journal(`[${name}] attempt ${log.id} failed to close cleanly: ${e.stack ?? e}`);
    await log.close().catch(() => {});   // best-effort; may already be closed
  }

  // Step 9: notify. Cannot change the outcome; its own result is one events line.
  if (outcome !== 'ok' && outcome !== 'skipped') {
    await runOnFailure(ctx, repo, { attemptId: log.id, outcome, sha: last.sha, releaseId: last.release, logFile: log.file, envFile: envFiles.deploy ?? new Map(), mask });
  }
  return outcome;
}

// An unreadable state.json ends the attempt before step 0 can write
// `state.last` — and that write must not happen: state.json holds the release
// map, and an attempt that cannot read `live`, `previous` and `releases` must
// not replace them with empty ones, which the very next prune would read as
// "every release directory here is an orphan". So this path writes no state at
// all, and the damaged file is left exactly as it is for whoever repairs it.
// What it does write is everything an operator can see: the same attempt-log and
// events.log pair every other attempt gets, a journald line, and ON_FAILURE.
//
// The outcome is `fetch failed`, from the fixed vocabulary rather than a new
// name. It is the label for an attempt that ended at its first step with nothing
// on disk changed, and it is the one that behaves correctly downstream: not
// `skipped`, which reads as green and suppresses the notification, and not
// `deploy failed`, which claims a half-adopted service and prints in capitals.
// The detail says what actually happened, beside it, in every sink.
async function failUnreadableState(ctx, entry, { dir, logDir, name, error }) {
  const { main, repo, now } = ctx;
  const started = now();
  const log = await openAttemptLog(logDir, { now, maxBytes: main.logMaxBytes, mask: [] });
  const detail = `state.json is unreadable: ${error.message}`;
  await appendEvent(logDir, 'started', `${log.id} ${entry.kind} ${log.file}`);
  await log.line(`flipd attempt ${log.id}  name=${name}  trigger=${entry.kind}`);
  await log.line(`outcome: fetch failed  ${detail}`);
  await log.line('nothing was fetched, built, flipped or pruned, and state.json was not rewritten: with the release map unreadable, nothing can tell a live release from a stale one');
  await log.line(`next: repair or move aside ${path.join(dir, 'state.json')}, then flipd run ${name}`);
  await log.close();
  const secs = ((now() - started) / 1000).toFixed(1);
  await appendEvent(logDir, 'fetch-failed', `${log.id} fetch failed ${secs}s ${log.file}  ${detail}`);
  ctx.journal(`[${name}] attempt ${log.id}: ${detail}; nothing was run`);
  await runOnFailure(ctx, repo, { attemptId: log.id, outcome: 'fetch failed', sha: null, releaseId: null, logFile: log.file });
  return 'fetch failed';
}

// Never throws. Not killed by the shutdown signal: a restart mid-deploy is
// exactly when a message is wanted, and this is the one command in the
// codebase where landing that message matters more than shutdown speed. The
// caller (serve()'s close()) still waits on this, bounded, for a few
// seconds, and journals it by name if it is still running when that bound
// expires — so it is never untracked or silent — but past that bound the
// process is free to exit with it still running. Left running, it is
// orphaned rather than killed, and under systemd it is the cgroup's kill
// (not this code) that eventually reclaims it, one restart cycle after it
// would otherwise have been cut off mid-message. `ctx.signal?.aborted` still
// shortens the cap to 8 seconds for a job that starts already-doomed (the
// shutdown began before this job even got a chance to run) — there is
// nothing to lose by capping a job that never got to say anything yet.
export async function runOnFailure(ctx, repo, { attemptId, outcome, sha, releaseId, logFile, envFile, mask }) {
  if (!repo.onFailure) return;
  const { paths: p } = ctx;
  const logDir = p.repoLog(repo.name);
  // Declared before the try so the catch arm below masks too: it writes an
  // events.log line of its own, and that line must not be the one sink in this
  // module a secret can still reach. Replaced with the fuller mask (this
  // attempt's, or the env file's) as soon as that is in hand.
  let scrub = makeScrubber(mask ?? []);
  try {
    const extra = envFile ?? (await loadEnvFile(repo.deployEnvFile).catch(() => new Map()));
    const { env } = commandEnv(ctx, repo, 'deploy', { releaseId: releaseId ?? '', sha: sha ?? '', previousSha: '', attemptId }, extra);
    env.DEPLOY_OUTCOME = outcome;
    env.DEPLOY_LOG = logFile ?? '';
    // The same secret mask the attempt log used, not just this phase's env file:
    // ON_FAILURE can surface a build secret too (catting a build artifact, say),
    // and its own scrubber must not diverge from the one that already knows about it.
    scrub = makeScrubber(mask ?? [...extra.values()]);
    let out = '';
    const r = await runCommand({ command: repo.onFailure, cwd: p.repoDir(repo.name), env, timeoutSec: ctx.signal?.aborted ? 8 : 60, onOutput: (c) => { if (out.length < 65536) out += c; }, graceMs: 2000 });
    const code = r.timedOut ? 'timeout' : r.code ?? `signal ${r.signal}`;
    const first = scrub(out).trim().split('\n')[0].slice(0, 200);
    await appendEvent(logDir, 'notified', `${attemptId} exit ${code}${first ? `  ${first}` : ''}`);
  } catch (e) {
    // Masked for the same reason the events.log line below is: this message can
    // quote the command, and the command can carry an env-file value. journald
    // is a log like any other, so it is inside the never-print rule too.
    ctx.journal(`[${repo.name}] ON_FAILURE could not run: ${scrub(e.message)}`);
    await appendEvent(logDir, 'notified', `${attemptId} failed to run: ${scrub(e.message).split('\n')[0].slice(0, 200)}`).catch(() => {});
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
