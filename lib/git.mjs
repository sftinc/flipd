import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { groupKiller } from './exec.mjs';

const STDERR_TAIL = 64 * 1024;   // service memory, not the log: the log caps its own lines

export class GitError extends Error {
  constructor(message, { stderr = '', code = null, aborted = false } = {}) {
    super(message);
    this.stderr = stderr;
    this.code = code;
    this.aborted = aborted;
  }
}

// GIT_SSH_COMMAND is handed to a shell by git, and key/knownHosts are config-file
// values, not validated repo names — a space in either must not silently split
// into extra ssh arguments, so both are single-quoted (with embedded quotes escaped).
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export function gitEnv({ key, knownHosts, home }) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i ${q(key)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${q(knownHosts)} -o StrictHostKeyChecking=yes -o BatchMode=yes`,
  };
}

export function git(args, { env, onOutput, signal, timeoutMs = 0, graceMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    // detached: git spawns ssh, and an abort must reach both.
    const child = spawn('git', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killer = groupKiller(child, graceMs);
    const onAbort = () => killer.kill();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killer.kill(); }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; onOutput?.(c); });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-STDERR_TAIL); onOutput?.(c); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      killer.cancel();
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted: Boolean(signal?.aborted && sig) });
    });
  });
}

// git redacts the credential in its own stderr; these messages must not put it
// back by quoting argv. Everything between `scheme://` and the `@` goes, both
// halves of a `user:password@` and a lone `token@`, so the message says which
// command failed without republishing what authenticated it. Config refuses such
// a URL outright (lib/config.mjs) — this is the second line of defence for a URL
// that reached git some other way, such as `remote` get-url reporting what an
// existing clone was created with.
export const redactUserinfo = (s) => s.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g, '$1***@');

export async function gitOk(args, opts) {
  const r = await git(args, opts);
  const shown = redactUserinfo(args.join(' '));
  if (r.aborted) throw new GitError(`git ${shown} interrupted by shutdown`, { stderr: r.stderr, code: r.code, aborted: true });
  if (r.timedOut) throw new GitError(`git ${shown} timed out after ${opts.timeoutMs}ms`, { stderr: r.stderr, code: r.code });
  if (r.code !== 0) throw new GitError(`git ${shown} exited ${r.code}`, { stderr: r.stderr, code: r.code });
  return r.stdout.trim();
}

// A clone that crashed mid-way is a directory without HEAD. Treat it as absent.
export async function isBareRepo(dir) {
  try {
    const head = await fs.readFile(path.join(dir, 'HEAD'), 'utf8');
    return head.startsWith('ref: ') || /^[0-9a-f]{40}/.test(head);
  } catch {
    return false;
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;

// Clone into a sibling and rename, so a crash mid-clone leaves `<dir>.partial`
// (removed on the next attempt) and never a directory that passes isBareRepo
// with no remote configured.
export async function cloneBare(url, dir, opts) {
  const partial = `${dir}.partial`;
  await fs.rm(partial, { recursive: true, force: true });
  await gitOk(['clone', '--bare', '--quiet', url, partial], opts);
  await fs.rename(partial, dir);
}
export const remoteUrl = (dir, opts) => gitOk(['-C', dir, 'remote', 'get-url', 'origin'], opts);
export const setRemoteUrl = (dir, url, opts) => gitOk(['-C', dir, 'remote', 'set-url', 'origin', url], opts);

export async function fetchBranch(dir, branch, opts) {
  await gitOk(['-C', dir, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`], opts);
  const sha = await gitOk(['-C', dir, 'rev-parse', `refs/heads/${branch}`], opts);
  if (!SHA_RE.test(sha)) throw new GitError(`rev-parse returned "${sha}", not a sha`);
  return sha;
}

export async function changedFiles(dir, fromSha, toSha, opts) {
  const out = await gitOk(['-C', dir, 'diff', '--name-only', `${fromSha}..${toSha}`], opts);
  return out.split('\n').filter(Boolean);
}

export const worktreeAdd = (dir, target, sha, opts) => gitOk(['-C', dir, 'worktree', 'add', '--detach', '--quiet', target, sha], opts);
export const worktreeRemove = (dir, target, opts) => git(['-C', dir, 'worktree', 'remove', '--force', target], opts);
export const worktreePrune = (dir, opts) => git(['-C', dir, 'worktree', 'prune'], opts);

// Run in the release worktree, not the bare clone. Same opts as the checkout:
// the key in GIT_SSH_COMMAND (a private submodule authenticates separately),
// the run's timeout, the shutdown signal, and the attempt log.
export const submoduleUpdate = (worktree, opts) => gitOk(['-C', worktree, 'submodule', 'update', '--init', '--recursive', '--quiet'], opts);

export async function lsRemote(url, branch, opts) {
  const out = await gitOk(['ls-remote', url, `refs/heads/${branch}`], opts);
  const sha = out.split(/\s+/)[0];
  return SHA_RE.test(sha) ? sha : null;
}

export const shortSha = (sha) => sha.slice(0, 7);
