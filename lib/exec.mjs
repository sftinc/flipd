// lib/exec.mjs
import { spawn } from 'node:child_process';

// SIGTERM to the whole process group, SIGKILL after graceMs. Returns a function
// that cancels the pending SIGKILL, for the close handler to call.
export function groupKiller(child, graceMs) {
  let timer = null;
  const groupKill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  return {
    kill() {
      if (timer) return;
      groupKill('SIGTERM');
      timer = setTimeout(() => groupKill('SIGKILL'), graceMs);
      timer.unref();
    },
    cancel() { if (timer) clearTimeout(timer); },
  };
}

export function runCommand({ command, cwd, env, timeoutSec, onOutput, signal, graceMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    let killedBy = null;
    const killer = groupKiller(child, graceMs);
    const kill = (reason) => {
      if (killedBy) return;
      killedBy = reason;
      killer.kill();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    const timer = setTimeout(() => { timedOut = true; kill('timeout'); }, timeoutSec * 1000);
    const onAbort = () => kill('shutdown');
    // A listener added after abort() never fires, so an already-aborted signal
    // must be acted on now, or a command started during shutdown runs to completion.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      killer.cancel();
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, timedOut, killedBy });
    });
  });
}
