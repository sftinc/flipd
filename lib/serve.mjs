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

export async function reconcile(p, journal) {
  let names = [];
  try { names = await fs.readdir(p.lib); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of names.filter((n) => NAME_RE.test(n))) {
    const dir = p.repoDir(name);
    let state;
    try { state = await readState(dir); } catch { continue; }
    await fs.rm(path.join(dir, 'current.tmp'), { force: true });

    // Release directories the state does not know about: a crash between
    // `worktree add` and registration. Nothing points at them; remove them.
    let present = [];
    try { present = await fs.readdir(path.join(dir, 'releases')); } catch { /* none */ }
    for (const id of present) {
      if (!state.releases[id]) {
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
      try {
        const repo = await loadRepo(p, name);
        await runOnFailure({ paths: p, journal }, repo, { attemptId: state.last.attempt, outcome: 'interrupted', sha: state.last.sha, releaseId: state.last.release, logFile: state.last.log });
      } catch (e) {
        journal(`[${name}] ON_FAILURE not run at startup: ${e.message}`);
      }
    } else if (state.pending) {
      // Already recorded as a failed deploy (or an earlier interruption). Say so, once, in journald only.
      journal(`[${name}] pending ${state.pending} is still unconfirmed; run remote-deploy rollback ${name} or remote-deploy run ${name}`);
    }
  }
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
      const state = await readState(p.repoDir(r.name));
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
  await reconcile(p, journal);
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
    if (typeof msg.name !== 'string') return { ok: false, error: 'name is required' };
    if (msg.cmd === 'run') {
      const r = queue.enqueue({ kind: 'manual', name: msg.name });
      await appendEvent(p.repoLog(msg.name), 'queued', r.queued ? 'manual' : `manual (${r.reason})`);
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
    reservation.commit(target);
    await appendEvent(p.repoLog(msg.name), 'rollback', `queued, target ${target}`);
    return { ok: true, queued: true, target };
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

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      queue.stop();
      abort.abort();
      await new Promise((r) => hook.close(r));
      await new Promise((r) => sock.close(r));
      await queue.drain();
      await fs.rm(p.sock, { force: true });
    })();
    return closing;
  };
  return { hookPort, close };
}
