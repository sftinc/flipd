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

export const SHOW_ARGS = ['show', 'flipd', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'ExecStart'];

// `systemctl show` is a read and needs no root, so it is never sudo'd.
export async function readUnit({ run }) {
  let r;
  try {
    r = await run(['systemctl', ...SHOW_ARGS]);
  } catch (e) {
    return { ok: false, error: `could not run systemctl (${e.code ?? e.message}); this command needs systemd` };
  }
  if (r.code !== 0) {
    return { ok: false, error: `systemctl show flipd exited ${r.code}: ${(r.stderr || r.stdout).trim()}` };
  }
  const unit = parseSystemdShow(r.stdout);
  // The failure mode here is exit 0 with unusable output, not a nonzero exit:
  // an absent unit is reported as LoadState=not-found and still exits 0.
  if (unit.loadState !== 'loaded') {
    return { ok: false, error: `systemd has no usable flipd.service (LoadState=${unit.loadState || 'unknown'}); is flipd installed on this box?` };
  }
  if (!unit.execStart) {
    return { ok: false, error: 'flipd.service has no ExecStart to read; the unit file looks damaged' };
  }
  return { ok: true, unit };
}

// The unit execs <clone>/bin/flipd, so the clone is that path's grandparent.
// Upgrading a clone the service does not run is the silent failure this
// prevents: the pull succeeds, the restart succeeds, and the service still
// runs the old code. It is not cosmetic — bin/flipd dynamic-imports its
// subcommand on every invocation while the daemon holds the modules it loaded
// at start, so the two really can be different versions at once.
export function checkUnitClone(unit, dir) {
  const unitClone = path.resolve(path.dirname(path.dirname(unit.execStart)));
  if (unitClone === path.resolve(dir)) return null;
  return `flipd.service runs ${unit.execStart}, so the clone it upgrades is ${unitClone}, not ${path.resolve(dir)}.\nRun ${unitClone}/bin/flipd upgrade instead.`;
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
