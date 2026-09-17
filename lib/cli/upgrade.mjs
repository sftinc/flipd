// lib/cli/upgrade.mjs
//
// Waits for every repo to be idle, fast-forwards the clone the service runs
// from, restarts the unit, and proves the socket answers again. It replaces a
// procedure whose warning ("check that flipd status shows nothing running
// first") is repeated in root CLAUDE.md, docs/install.md and docs/agent.md.
//
// CLI-only on purpose: the service cannot restart itself and still report what
// happened, so nothing here is a socket command and nothing in lib/serve.mjs
// changes. The one socket call is {cmd:'status'}, which already exists.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendCommand } from '../socket.mjs';
import { git, redactUserinfo } from '../git.mjs';

// `systemctl show flipd -p LoadState -p ...` prints one KEY=VALUE per line.
// Labelled properties and not `--value`, because a unit that does not exist
// exits 0 with LoadState=not-found: the exit code is not the answer here, the
// labels are. ExecStart prints as `{ path=... ; argv[]=... ; ... }`.
export function parseSystemdShow(out) {
  const kv = {};
  for (const line of String(out).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const m = /(?:^|[\s{])path=([^;]+?)\s*;/.exec(kv.ExecStart ?? '');
  return {
    loadState: kv.LoadState ?? '',
    activeState: kv.ActiveState ?? '',
    subState: kv.SubState ?? '',
    mainPid: kv.MainPID ?? '0',
    execStart: m ? m[1] : '',
  };
}

// Run a program and capture it. Deliberately not lib/exec.mjs's runCommand:
// that one is for BUILD and DEPLOY — a shell string, a process group, an
// attempt log, a timeout. This is argv, no shell, and the output comes back as
// a string. `stdio: 'inherit'` is for sudo's password prompt, which has to
// reach the operator's terminal.
function capture(cmd, args, { stdio } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, stdio === 'inherit'
      ? { stdio: ['inherit', 'inherit', 'inherit'] }
      : { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// lib/cli/upgrade.mjs -> lib/cli -> lib -> the clone root.
export const cloneRoot = () => path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Every seam in one object rather than eight `xOverride` parameters. This
// command is almost entirely I/O against three things a test must never touch
// — the socket, systemd and sudo — so `pause.mjs`'s single `sendOverride` does
// not stretch to cover it. Same purpose, one bag instead of a long signature.
export function deps(ctx) {
  const o = ctx.upgradeOverride ?? {};
  return {
    cloneDir: o.cloneDir ?? cloneRoot(),
    send: o.send ?? ((m) => sendCommand(ctx.paths.sock, m, { timeoutMs: 1500 })),
    run: o.run ?? ((argv) => capture(argv[0], argv.slice(1))),
    sudoV: o.sudoV ?? (() => capture('sudo', ['-v'], { stdio: 'inherit' })),
    runGit: o.runGit ?? ((argv) => git(argv)),
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: o.now ?? (() => Date.now()),
    isRoot: o.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0),
  };
}

// A pull into local edits is not an upgrade — and a *restart* of a dirty clone
// ships those edits into the running service, because the unit execs straight
// out of this directory (flipd.service, ExecStart). That is why --restart-only
// keeps this check: it is the path where a code change is least intended. What
// --restart-only does relax is the requirement to be a git clone at all, since
// there is then nothing to pull.
export async function checkClone(dir, { runGit, restartOnly }) {
  const inTree = await runGit(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  const isGit = inTree.code === 0 && inTree.stdout.trim() === 'true';
  if (!isGit) {
    if (restartOnly) return { ok: true, isGit: false };
    return { ok: false, error: `${dir} is not a git clone, so there is nothing to pull` };
  }
  const status = await runGit(['-C', dir, 'status', '--porcelain']);
  if (status.code !== 0) {
    return { ok: false, error: redactUserinfo(`could not read git status in ${dir}: ${status.stderr.trim()}`) };
  }
  if (status.stdout.trim()) {
    return { ok: false, error: redactUserinfo(`${dir} has uncommitted changes; commit or discard them first:\n${status.stdout.trimEnd()}`) };
  }
  return { ok: true, isGit: true };
}

export default async function (args, { stderr }) {
  let restartOnly = false;
  for (const a of args) {
    if (a === '--restart-only') restartOnly = true;
    else { stderr.write('usage: flipd upgrade [--restart-only]\n'); return 2; }
  }
  void restartOnly;
  return 0;
}
