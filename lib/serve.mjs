// lib/serve.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadMain, loadRepo, loadRepos } from './config.mjs';
import { readState, writeState } from './state.mjs';
import { appendEvent } from './log.mjs';
import { createQueue } from './queue.mjs';
import { runEntry, runOnFailure, resolveRollbackTarget } from './run.mjs';
import { runCheck } from './check.mjs';
import { createHookServer } from './hook.mjs';
import { createSocketServer } from './socket.mjs';
import { NAME_RE } from './paths.mjs';

// One repo's reconcile step. Returns a pending ON_FAILURE notification job
// (or null), so the caller can run it later rather than here.
async function reconcileOne(p, journal, name) {
  const dir = p.repoDir(name);
  let state;
  try { state = await readState(dir); } catch { return null; }
  await fs.rm(path.join(dir, 'current.tmp'), { force: true });

  // Release directories the state does not know about: a crash between
  // `worktree add` and registration. Nothing points at them; remove them —
  // except whatever `current` still resolves to, which state.releases might
  // not mention if state.json itself is missing, corrupt, or stale relative
  // to the symlink (never delete out from under a live release).
  let currentTarget = null;
  try { currentTarget = path.basename(await fs.readlink(path.join(dir, 'current'))); } catch { /* no current yet */ }
  let present = [];
  try { present = await fs.readdir(path.join(dir, 'releases')); } catch { /* none */ }
  for (const id of present) {
    if (!state.releases[id] && id !== currentTarget) {
      await fs.rm(path.join(dir, 'releases', id), { recursive: true, force: true });
      journal(`[${name}] removed unregistered release directory ${id}`);
    }
  }

  if (state.last && state.last.finished === null) {
    // The service died inside this attempt. That is the interruption.
    state.last.outcome = 'interrupted';
    state.last.finished = new Date().toISOString();
    await writeState(dir, state);
    const hint = state.pending ? `; current is flipped to ${state.pending} and unconfirmed: run remote-deploy rollback ${name} or remote-deploy run ${name}` : '';
    journal(`[${name}] attempt ${state.last.attempt} was interrupted by a service stop${hint}`);
    await appendEvent(p.repoLog(name), 'interrupted', `${state.last.attempt}${state.pending ? ` pending ${state.pending}` : ''} found at startup`);
    // ON_FAILURE itself is not run here: it can take up to a minute per repo,
    // and this whole function runs before anything is listening. The caller
    // runs it after the hook and socket are up, so several interrupted repos
    // cannot add up to blow past systemd's start timeout.
    return { name, attemptId: state.last.attempt, outcome: 'interrupted', sha: state.last.sha, releaseId: state.last.release, logFile: state.last.log };
  } else if (state.pending) {
    // Already recorded as a failed deploy (or an earlier interruption). Say so, once, in journald only.
    journal(`[${name}] pending ${state.pending} is still unconfirmed; run remote-deploy rollback ${name} or remote-deploy run ${name}`);
  }
  return null;
}

export async function reconcile(p, journal) {
  let names = [];
  try { names = await fs.readdir(p.lib); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const pendingNotifications = [];
  for (const name of names.filter((n) => NAME_RE.test(n))) {
    try {
      const job = await reconcileOne(p, journal, name);
      if (job) pendingNotifications.push(job);
    } catch (e) {
      // One repo's local failure (a permissions error, a wedged directory, a
      // write that fails) must not abort reconcile for every other repo —
      // this is the startup path for a service whose entire job is to be
      // running, so one bad directory must not keep the daemon from starting
      // at all.
      journal(`[${name}] reconcile failed, continuing with other repos: ${e.stack ?? e}`);
    }
  }
  return pendingNotifications;
}

export function findRepoFor(p, journal) {
  return async ({ sshUrl, branch, id }) => {
    const { repos, errors } = await loadRepos(p);
    for (const { name, error } of errors) journal(`config ${name}.conf rejected: ${error.message}`);
    const direct = repos.find((r) => r.repo === sshUrl && r.branch === branch);
    if (direct) return direct;
    if (id === null) return null;
    // Renamed on GitHub: the ssh_url changed, the id did not. Git follows the
    // redirect, so the run works; say so, so REPO gets updated.
    for (const r of repos.filter((r) => r.branch === branch)) {
      let state;
      try {
        state = await readState(p.repoDir(r.name));
      } catch (e) {
        // A corrupt state.json for one repo must not break rename-matching
        // for every other repo on this same push, and must not answer 500 to
        // a delivery that might still match a later one.
        journal(`[${r.name}] could not read state while matching a renamed push: ${e.message}`);
        continue;
      }
      if (state.github_id === id) {
        journal(`[${r.name}] renamed: now ${sshUrl}, update REPO in ${p.repoConf(r.name)}`);
        await appendEvent(p.repoLog(r.name), 'renamed', `now ${sshUrl}; update REPO`);
        return r;
      }
    }
    return null;
  };
}

export async function serve({ paths: p, journal = (l) => process.stderr.write(`${l}\n`) }) {
  const main = await loadMain(p);
  const pendingNotifications = await reconcile(p, journal);
  const abort = new AbortController();

  const queue = createQueue(async (entry) => {
    let repo;
    try {
      repo = await loadRepo(p, entry.name);
    } catch (e) {
      journal(`[${entry.name}] skipped ${entry.kind}: ${e.message}`);
      entry.resolve?.({ ok: false, error: e.message });
      return;
    }
    if (entry.kind === 'check') {
      const result = await runCheck({ paths: p, repo, journal, signal: abort.signal }, { setRemote: entry.setRemote });
      journal(`[${entry.name}] check ${result.passed ? 'passed' : 'FAILED'}`);
      entry.resolve({ ok: true, ...result });
      return;
    }
    const outcome = await runEntry({ paths: p, main, repo, now: () => new Date(), protectedTargets: queue.protectedTargets, signal: abort.signal, journal }, entry);
    journal(`[${entry.name}] ${entry.kind} ${outcome}`);
  }, { onError: (e, entry) => { journal(`[${entry.name}] ${entry.kind} crashed: ${e.stack ?? e}`); entry.resolve?.({ ok: false, error: e.message }); } });

  const hook = createHookServer({
    secret: main.webhookSecret,
    findRepo: findRepoFor(p, journal),
    journal,
    onPush: async (repo, info) => {
      await appendEvent(p.repoLog(repo.name), 'webhook', `${info.sha} ${info.pusher}`.trim());
      const state = await readState(p.repoDir(repo.name));   // read only: the worker writes state
      if (state.pending) {
        await appendEvent(p.repoLog(repo.name), 'refused', `pending ${state.pending}; run remote-deploy rollback ${repo.name} or remote-deploy run ${repo.name}`);
        return { status: 200, body: `refused ${repo.name}: pending ${state.pending}` };
      }
      const r = queue.enqueue({ kind: 'webhook', name: repo.name, githubId: info.id });
      await appendEvent(p.repoLog(repo.name), 'queued', r.queued ? 'webhook' : `webhook (${r.reason})`);
      return { status: 202, body: `queued ${repo.name}` };
    },
  });
  await new Promise((resolve, reject) => { hook.once('error', reject); hook.listen(main.listen.port, main.listen.host, () => { hook.off('error', reject); resolve(); }); });
  const hookPort = hook.address().port;
  journal(`listening on ${main.listen.host}:${hookPort} /deploy`);

  const handleSocket = async (msg) => {
    journal(`socket: ${JSON.stringify(msg)}`);
    if (msg.cmd === 'status') {
      return { ok: true, running: queue.running()?.name ?? null, queued: queue.queued().map((e) => e.name) };
    }
    if (!['run', 'rollback', 'check'].includes(msg.cmd)) return { ok: false, error: `unknown command ${msg.cmd}` };
    await loadRepo(p, msg.name);   // throws a clear error when the name is bad or the repo is unknown
    if (msg.cmd === 'check') {
      return new Promise((resolve) => {
        const r = queue.enqueueIfIdle({ kind: 'check', name: msg.name, setRemote: Boolean(msg.setRemote), resolve });
        if (!r.queued) resolve({ ok: false, error: r.reason });
      });
    }
    if (msg.cmd === 'run') {
      const r = queue.enqueue({ kind: 'manual', name: msg.name });
      try {
        await appendEvent(p.repoLog(msg.name), 'queued', r.queued ? 'manual' : `manual (${r.reason})`);
      } catch (e) {
        // The command's result must reflect whether the work was queued, not
        // whether a best-effort events.log line landed — telling the caller
        // { ok: false } here when the run *is* queued invites a retry that
        // duplicates the deploy.
        journal(`[${msg.name}] could not record the queued event: ${e.message}`);
      }
      return { ok: true, queued: r.queued, ...(r.reason ? { reason: r.reason } : {}) };
    }
    // Reserve first, synchronously, so prune for this repo is deferred while the
    // state is read and the target resolved; a confirmation landing in between
    // can move `previous` but cannot remove it.
    const reservation = queue.reserveRollback(msg.name);
    let target;
    try {
      const state = await readState(p.repoDir(msg.name));
      target = resolveRollbackTarget(state);
    } catch (e) {
      reservation.cancel();
      throw e;
    }
    if (!target) { reservation.cancel(); return { ok: false, error: 'nothing to roll back to' }; }
    // commit() itself enqueues, and enqueue can refuse (e.g. the queue has
    // already been told to stop) — report what actually happened, the way
    // the `run` arm above does, rather than a bare `queued: true`.
    const result = reservation.commit(target);
    try {
      await appendEvent(p.repoLog(msg.name), 'rollback', result.queued ? `queued, target ${target}` : `not queued (${result.reason}), target ${target}`);
    } catch (e) {
      journal(`[${msg.name}] could not record the rollback event: ${e.message}`);
    }
    return { ok: true, queued: result.queued, target, ...(result.reason ? { reason: result.reason } : {}) };
  };
  // The hook server is already listening by this point. If the socket fails to
  // bind (a stale mount, a permissions problem, a path too long for this OS),
  // serve() must not return *and* leave that listener orphaned with nothing
  // holding a reference to close it — that is a leak that outlives the process
  // that tried to start it, not just a failed start.
  let sock;
  try {
    sock = await createSocketServer(p.sock, handleSocket, { journal });
  } catch (e) {
    await new Promise((r) => hook.close(r));
    throw e;
  }
  journal(`socket at ${p.sock}`);

  // Tracked so shutdown can bound how long it waits on the socket: a client
  // that connects and never sends its newline, or stalls after issuing a
  // command, keeps its connection open forever, and net.Server#close only
  // calls back once every connection has ended.
  const sockConns = new Set();
  sock.on('connection', (conn) => {
    sockConns.add(conn);
    conn.once('close', () => sockConns.delete(conn));
  });

  // Deferred from reconcile(): run now that the servers are actually up, and
  // concurrently rather than serially, so several interrupted repos add
  // latency to nothing systemd is timing. Tracked by name so close() can
  // wait for these too, bounded — otherwise a job still in flight when the
  // service is asked to stop is neither cancelled nor counted by anything
  // (queue.drain() only knows about entries that went through the queue),
  // and the process can exit with its child still running, silently.
  const pendingJobs = new Map();   // name -> promise, removed once settled
  for (const job of pendingNotifications) {
    const notified = loadRepo(p, job.name)
      // The shutdown signal is forwarded, the same as every command the
      // queue runs: an abort mid-notification sends it a plain SIGTERM
      // (escalating to SIGKILL if ignored) rather than leaving it immune to
      // shutdown, which is what let it outlive close() before this fix.
      .then((repo) => runOnFailure({ paths: p, journal, signal: abort.signal }, repo, job))
      .catch((e) => journal(`[${job.name}] ON_FAILURE not run at startup: ${e.message}`))
      .finally(() => pendingJobs.delete(job.name));
    pendingJobs.set(job.name, notified);
  }

  // Waits for `promise`, but resolves regardless once `ms` elapses; `onTimeout`
  // runs first, so the caller can force termination or record what didn't
  // finish. Shared by the socket close and the pending-notifications wait
  // below: both are "something outside the queue that shutdown must not
  // wait on unboundedly."
  function boundedWait(promise, ms, onTimeout) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      promise.then(finish, finish);
      const timer = setTimeout(() => { onTimeout?.(); finish(); }, ms);
      timer.unref?.();
    });
  }

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // Anything still queued (not yet started) is dropped now. Say so: the
      // webhook that put it there already got its 202, and without this the
      // only trace is `queued webhook` in events.log followed by silence.
      const dropped = queue.queued();
      queue.stop();
      for (const e of dropped) {
        journal(`[${e.name}] ${e.kind} dropped at shutdown before it could run; push again or run manually once the service is back`);
      }
      abort.abort();
      // Drain the in-flight deploy and wait for any still-running startup
      // notification *before* touching either server, and concurrently with
      // each other: both were just signalled by abort() above, neither
      // depends on the other, and closing the socket first would wait on it
      // anyway (net.Server#close waits for every open connection to end) —
      // a stuck or hostile client, or a notification hook that ignores its
      // signal, must not be able to starve this indefinitely and let
      // systemd's stop timeout SIGKILL the process out from under the very
      // work these waits exist to protect or account for. The hook server
      // is not exposed to the socket's specific hazard (checked
      // empirically), but ordering it the same way costs nothing.
      await Promise.all([
        queue.drain(),
        boundedWait(Promise.all([...pendingJobs.values()]), 3000, () => {
          for (const name of pendingJobs.keys()) {
            journal(`[${name}] ON_FAILURE still running 3s after shutdown began; abandoning it`);
          }
        }),
      ]);
      await new Promise((r) => hook.close(r));
      await boundedWait(new Promise((r) => sock.close(r)), 2000, () => {
        // Bounded: after the drain, nothing legitimate holds a connection
        // open for more than an instant. Force any that remain — a wedged
        // or hostile client — closed, so shutdown itself stays bounded too.
        for (const conn of sockConns) conn.destroy();
      });
      await fs.rm(p.sock, { force: true });
    })();
    return closing;
  };
  return { hookPort, close };
}
