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

export const PROBE_MS = 8000;
export const PROBE_INTERVAL_MS = 500;

const wellFormed = (r) => Boolean(r?.ok) && Array.isArray(r.queued)
  && (r.running === null || typeof r.running === 'string');

// The question this command must answer before it dares skip the idle wait:
// is the service up, *provably* down, or merely out of reach?
//
// Merely out of reach is a refusal, not a green light. lib/cli/remove.mjs holds
// the same line for the same reason — a busy worker can miss a probe's window,
// and a missing flipd group membership makes a live service look dead
// (docs/agent.md). And ECONNREFUSED/ENOENT is not proof on its own either:
// with PUBLIC_HOST set, serve() binds the HTTP listener before it creates the
// socket, so a webhook can be driving the worker with no socket to ask.
//
// So: re-probe for up to PROBE_MS and take the first definite answer. Against
// flipd.service's Restart=on-failure/RestartSec=3, a crash-looping unit cannot
// present `active` for eight straight seconds, so the loop sees auto-restart or
// failed and calls it down — which is exactly the post-crash state this command
// has to be able to recover.
export async function probeService({ send, run, sleep, now }) {
  const deadline = now() + PROBE_MS;
  let lastError = null;
  for (;;) {
    try {
      const reply = await send({ cmd: 'status' });
      if (wellFormed(reply)) return { state: 'up', reply };
      lastError = new Error('the service sent a status reply this version does not understand');
    } catch (e) {
      lastError = e;
      if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT') {
        return { state: 'unreachable', error: e };
      }
    }
    let unit = null;
    try {
      const r = await run(['systemctl', ...SHOW_ARGS]);
      unit = parseSystemdShow(r.stdout ?? '');
    } catch { /* no systemd to ask; the deadline below decides */ }
    if (unit && (unit.subState === 'auto-restart' || unit.activeState === 'failed' || unit.activeState === 'inactive')) {
      return { state: 'down', unit };
    }
    if (now() >= deadline) return { state: 'unreachable', error: lastError, unit };
    await sleep(PROBE_INTERVAL_MS);
  }
}

export const IDLE_INTERVAL_MS = 2000;

// No timeout: a build may legitimately run for TIMEOUT (1200s by default,
// lib/config.mjs), and the operator can interrupt. Nothing has been changed by
// the time this is first called, so an interrupt there costs nothing.
export async function waitForIdle({ send, run, sleep, now, onWait }) {
  let said = null;
  for (;;) {
    const probe = await probeService({ send, run, sleep, now });
    if (probe.state !== 'up') return probe;
    const { running, queued } = probe.reply;
    if (running === null && queued.length === 0) return probe;
    const what = [running && `${running} running`, queued.length && `${queued.length} queued`].filter(Boolean).join(', ');
    if (what !== said) { onWait(what); said = what; }
    await sleep(IDLE_INTERVAL_MS);
  }
}

export const ALIVE_MS = 15000;

// Called twice, and that is the point. Once before anything has changed, so a
// box with no TTY and no cached credential refuses having changed nothing; and
// once more after the idle wait, which is unbounded and can easily outlast a
// sudo timestamp (TIMEOUT defaults to 1200s). The second call may prompt, which
// is why it happens *before* the final idle check rather than after it — the
// prompt belongs outside the window between the last check and SIGTERM.
export async function takeRoot({ isRoot, sudoV }) {
  if (isRoot) return null;
  let r;
  try {
    r = await sudoV();
  } catch (e) {
    return `could not run sudo (${e.code ?? e.message}); run flipd upgrade as root instead`;
  }
  if (r.code !== 0) {
    return 'flipd upgrade needs root to restart flipd.service, and sudo did not grant it; run it from an account with sudo, or as root';
  }
  return null;
}

// -n so the restart itself can never stop for a password. Root was already
// taken moments earlier by takeRoot; this is the call that must not block.
export const restartArgv = (isRoot) => (isRoot
  ? ['systemctl', 'restart', 'flipd']
  : ['sudo', '-n', 'systemctl', 'restart', 'flipd']);

// Type=simple means a successful `systemctl restart` proves only that ExecStart
// could be launched — a bad conf or a missing permission still exits within
// milliseconds. The behavioural check is the socket answering.
export async function proveAlive({ send, run, sleep, now }) {
  const deadline = now() + ALIVE_MS;
  for (;;) {
    try {
      if (wellFormed(await send({ cmd: 'status' }))) return { ok: true };
    } catch { /* not up yet */ }
    if (now() >= deadline) break;
    await sleep(PROBE_INTERVAL_MS);
  }
  let unit = null;
  try {
    unit = parseSystemdShow((await run(['systemctl', ...SHOW_ARGS])).stdout ?? '');
  } catch { /* nothing more to learn */ }
  // Three different repairs, so three different sentences.
  const what = !unit ? 'it could not be reached and systemd could not be asked why'
    : unit.subState === 'auto-restart' || unit.activeState === 'activating' ? 'it is restarting in a loop — it starts and exits'
      : unit.activeState === 'active' ? 'the process is alive but is not answering its socket'
        : `it exited and stayed down (ActiveState=${unit.activeState || 'unknown'})`;
  return { ok: false, what };
}

// Files in this repository that only reach the box through install.sh. A pull
// that moves one of them has upgraded the code and not the installed artifact.
export const INSTALLER_ARTIFACTS = ['flipd.service', 'flipd.logrotate', 'install.sh'];

const LOG_LIMIT = 20;

// --ff-only, not a plain pull: a service clone that cannot fast-forward has a
// local commit or a rewritten upstream, and the right answer is to stop and say
// so rather than to open a merge in /opt.
export async function pull(dir, { runGit }) {
  const rev = async () => (await runGit(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
  const before = await rev();
  const r = await runGit(['-C', dir, 'pull', '--ff-only']);
  if (r.code !== 0) {
    // origin here is whatever the operator cloned from, which is not held to
    // REPO's refusal of userinfo, so git's own message can carry a credential.
    return { ok: false, error: redactUserinfo(`git pull --ff-only failed in ${dir}:\n${(r.stderr || r.stdout).trim()}`) };
  }
  const after = await rev();
  if (before === after) return { ok: true, changed: false, before, after, log: '', artifacts: [] };
  const log = (await runGit(['-C', dir, 'log', '--oneline', '-n', String(LOG_LIMIT), `${before}..${after}`])).stdout.trimEnd();
  const names = (await runGit(['-C', dir, 'diff', '--name-only', `${before}..${after}`])).stdout.split('\n');
  return { ok: true, changed: true, before, after, log: redactUserinfo(log), artifacts: INSTALLER_ARTIFACTS.filter((a) => names.includes(a)) };
}

// Absolute, never `./install.sh`: the operator may be standing anywhere. And
// it says what the installer will do, because install.sh ends in an
// unconditional `systemctl restart flipd` with no idle check of its own —
// without that warning this command hands back the very procedure it exists to
// replace.
export const partialUpgradeNote = (dir, artifacts) => `
This upgrade is PARTIAL: ${artifacts.join(', ')} changed, and ${artifacts.length > 1 ? 'those are files' : 'that is a file'} install.sh copies into place, so the pulled version is not the installed one yet.
To finish it, re-run the installer yourself:

    sudo ${path.join(path.resolve(dir), 'install.sh')}

Note that install.sh restarts flipd unconditionally at the end, with no idle check of its own — so run it while flipd status shows nothing running.`;

export default async function (args, { stderr }) {
  let restartOnly = false;
  for (const a of args) {
    if (a === '--restart-only') restartOnly = true;
    else { stderr.write('usage: flipd upgrade [--restart-only]\n'); return 2; }
  }
  void restartOnly;
  return 0;
}
