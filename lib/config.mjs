import fs from 'node:fs/promises';
import path from 'node:path';
import { NAME_RE } from './paths.mjs';
import { chownFlipd } from './owner.mjs';

export { NAME_RE };
export class ConfigError extends Error {}

export const MAIN_KEYS = new Set(['LISTEN', 'PUBLIC_HOST', 'WEBHOOK_SECRET', 'KEEP', 'LOG_KEEP', 'LOG_MAX_BYTES']);
export const REPO_KEYS = new Set(['REPO', 'BRANCH', 'ROOT', 'BUILD', 'STOP', 'DEPLOY', 'HEALTHCHECK', 'ON_FAILURE', 'WATCH', 'IGNORE', 'BUILD_ENV_FILE', 'DEPLOY_ENV_FILE', 'KEY', 'TIMEOUT', 'HOOK_HOST']);
export const ACCOUNT_KEYS = new Set(['KIND', 'API', 'TOKEN']);
const FORGE_KINDS = new Set(['github', 'forgejo', 'gitea']);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseKV(text, allowedKeys) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    // No arm of this parser echoes any part of the line — not the line, and not
    // the "key" either. Every caller reads a file that can hold a secret:
    // flipd.conf holds WEBHOOK_SECRET, an env file holds nothing but
    // values. A line that failed to parse is exactly the line no mask can cover,
    // because a file that did not parse contributes nothing to the attempt log's
    // mask, and these messages reach journald, the operator's terminal, the
    // attempt log and events.log.
    //
    // The "key" is not safe to echo either, and that is the trap this code fell
    // into once already: a wrapped paste of a base64 secret splits at its own
    // padding or at a "/" and arrives here as a key. `sk-live/AKIAsecretpart=…`
    // reaches the bad-key arm, and a KEY_RE-legal base64url prefix reaches the
    // unknown-key arm through parseMain. The line number survives in every arm,
    // which is what an operator with the file open actually needs.
    if (eq < 1) throw new ConfigError(`line ${i + 1}: expected KEY=value`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) throw new ConfigError(`line ${i + 1}: bad key`);
    if (allowedKeys && !allowedKeys.has(key)) throw new ConfigError(`line ${i + 1}: unknown key`);
    out.set(key, value);
  }
  return out;
}

function int(kv, key, def) {
  const v = kv.get(key);
  if (v === undefined || v === '') return def;
  if (!/^\d+$/.test(v)) throw new ConfigError(`${key} must be a whole number, got "${v}"`);
  return Number(v);
}

function split(v) {
  return (v ?? '').split(/\s+/).filter(Boolean);
}

export function parseMain(text) {
  const kv = parseKV(text, MAIN_KEYS);
  // PUBLIC_HOST is the HTTP switch. With it the hook listener binds and the
  // secret that authenticates the forge is required; without it nothing
  // listens, so nothing needs a secret. A secret that is present but unused
  // is fine — the installer always writes one, so turning HTTP on later is
  // just setting the host.
  const publicHost = kv.get('PUBLIC_HOST') || null;
  if (publicHost && !kv.get('WEBHOOK_SECRET')) throw new ConfigError('WEBHOOK_SECRET is required when PUBLIC_HOST is set');
  const listen = kv.get('LISTEN') || '127.0.0.1:9000';
  const m = /^(.+):(\d+)$/.exec(listen);
  if (!m) throw new ConfigError(`LISTEN must be host:port, got "${listen}"`);
  return {
    listen: { host: m[1], port: Number(m[2]) },
    publicHost,
    webhookSecret: kv.get('WEBHOOK_SECRET') || null,
    keep: int(kv, 'KEEP', 5),
    logKeep: int(kv, 'LOG_KEEP', 50),
    logMaxBytes: int(kv, 'LOG_MAX_BYTES', 52428800),
  };
}

export async function loadMain(p) {
  return parseMain(await fs.readFile(p.mainConf, 'utf8'));
}

// /etc/flipd/accounts/<host>.conf. TOKEN is a secret and shares WEBHOOK_SECRET's
// rule: no message below echoes any value, KIND included — a wrapped paste can
// put anything on any line.
export function parseAccount(host, text) {
  const kv = parseKV(text, ACCOUNT_KEYS);
  const kind = kv.get('KIND');
  if (!FORGE_KINDS.has(kind)) throw new ConfigError('KIND must be github, forgejo or gitea');
  if (!kv.get('TOKEN')) throw new ConfigError('TOKEN is required');
  const api = (kv.get('API') || (kind === 'github' ? 'https://api.github.com' : `https://${host}/api/v1`)).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(api)) throw new ConfigError('API must be an https:// URL');
  return { host, kind, api, token: kv.get('TOKEN') };
}

// null means "no account for this host" and is the signal `add` uses to take
// the manual path. Anything other than ENOENT propagates: a conf that exists
// and cannot be read or parsed must stop `add`, not silently demote it.
export async function loadAccount(p, host) {
  const file = p.accountConf(host);   // validates the host
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return parseAccount(host, text);
}

// A credential in a git URL is a leak no message redaction can close: the URL
// is also in git's own argv, so `ps` shows it to every local user for the
// life of the fetch. A bare `ssh://git@host/...` username carries no secret
// and is allowed; the scp-style `git@github.com:o/r.git` has no userinfo at
// all as far as this rule is concerned (no `://`) and is the documented
// form. Shared by parseRepo (refusing to load a conf whose REPO carries one)
// and `add`'s pre-flight (refusing to write one in the first place).
export function credentialInUrl(url) {
  const cred = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/@]*)@/.exec(url);
  return Boolean(cred && !(cred[1].toLowerCase() === 'ssh' && !cred[2].includes(':')));
}

export function parseRepo(name, text, p) {
  if (!NAME_RE.test(name)) throw new ConfigError(`bad repo name "${name}": must match ${NAME_RE}`);
  const kv = parseKV(text, REPO_KEYS);
  for (const k of ['REPO', 'BUILD', 'DEPLOY']) {
    if (!kv.get(k)) throw new ConfigError(`${k} is required`);
  }
  // Refused outright. The message never echoes the URL — that would put the
  // credential straight into journald, which is the thing being prevented.
  if (credentialInUrl(kv.get('REPO'))) {
    throw new ConfigError('REPO carries credentials in the URL (user:password@ or token@); use a deploy key and a URL with no userinfo');
  }
  // No message here ever echoes the value. Userinfo is the obvious secret and
  // `credentialInUrl` is the same rule REPO uses, but a health endpoint behind
  // `?token=...` is ordinary enough that the key name and the rule are all any
  // of these arms may say.
  const healthcheck = kv.get('HEALTHCHECK') || null;
  if (healthcheck) {
    if (credentialInUrl(healthcheck)) {
      throw new ConfigError('HEALTHCHECK carries credentials in the URL (user:password@ or token@); use a URL with no userinfo');
    }
    const notAUrl = new ConfigError('HEALTHCHECK must be a full http:// or https:// URL; flipd knows no port to resolve a bare path against');
    let url;
    try {
      url = new URL(healthcheck);
    } catch {
      throw notAUrl;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw notAUrl;
  }
  const root = kv.get('ROOT') || '.';
  if (path.isAbsolute(root) || root.split('/').includes('..')) {
    throw new ConfigError(`ROOT must be relative with no "..", got "${root}"`);
  }
  return {
    name,
    repo: kv.get('REPO'),
    branch: kv.get('BRANCH') || 'main',
    root,
    build: kv.get('BUILD'),
    deploy: kv.get('DEPLOY'),
    watch: split(kv.get('WATCH')),
    ignore: split(kv.get('IGNORE')),
    buildEnvFile: kv.get('BUILD_ENV_FILE') || p.envFile(name, 'build'),
    deployEnvFile: kv.get('DEPLOY_ENV_FILE') || p.envFile(name, 'deploy'),
    key: kv.get('KEY') || path.join(p.repoDir(name), 'key'),
    timeout: int(kv, 'TIMEOUT', 1200),
    hookHost: kv.get('HOOK_HOST') || null,
    onFailure: kv.get('ON_FAILURE') || null,
    stop: kv.get('STOP') || null,
    healthcheck,
  };
}

export async function loadRepo(p, name) {
  const text = await fs.readFile(p.repoConf(name), 'utf8');
  return parseRepo(name, text, p);
}

export async function loadRepos(p) {
  let files = [];
  try {
    files = await fs.readdir(p.reposDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const repos = [];
  const errors = [];
  for (const f of files.filter((f) => f.endsWith('.conf')).sort()) {
    const name = f.slice(0, -'.conf'.length);
    try {
      if (!NAME_RE.test(name)) throw new ConfigError(`file name "${f}" is not a repo name (${NAME_RE})`);
      repos.push(await loadRepo(p, name));
    } catch (error) {
      errors.push({ name, error });
    }
  }
  return { repos, errors };
}

export async function loadEnvFile(file) {
  try {
    return parseKV(await fs.readFile(file, 'utf8'), null);
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw e;
  }
}

let seq = 0;

// Unique per process and per call: a fixed `<file>.tmp` is a file two concurrent
// writers share, and the loser's rename either fails with ENOENT or moves the
// other's half-written bytes over the real file. Two `sudo flipd` calls at once
// is a thing an operator can do. The failure path removes the tmp file: it is
// created 0640 root:flipd and can hold the very values it exists to protect.
//
// Never point this at /etc/caddy/Caddyfile. The rename replaces the inode and
// takes mode and owner from what it created, so Caddy — running as its own user
// — could no longer read its own config. install.sh writes that file back with
// `cat >` for this reason.
export async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode: 0o640 });
    await chownFlipd(tmp, { mode: 0o640, root: true });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// The key a line would parse as, or null for a line parseKV itself would skip
// (blank, a comment) or reject (no "="). Mirrors parseKV's own trim-then-split
// rule exactly, so "which line does a change replace" agrees with "which line
// does the service read as K".
function lineKey(raw) {
  const t = raw.trim();
  if (!t || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq < 1) return null;
  return t.slice(0, eq).trim();
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

// Rewrite a KEY=value file line-oriented, not by rebuilding it from a Map: these
// files hold comments and blank lines, and a round trip through a Map would
// silently discard every one of them. A key maps to its new value, or to null to
// drop it. Callers validate their own keys and values first; a value carrying a
// newline would produce extra un-keyed lines and is the caller's to refuse.
export function editKV(text, changes) {
  let lines = splitLines(text);
  const trimmed = [];
  const collapsed = [];
  for (const [k, raw] of changes) {
    if (raw === null) {
      lines = lines.filter((l) => lineKey(l) !== k);
      continue;
    }
    const v = raw.trim();
    if (v !== raw) trimmed.push(k);
    const idx = lines.findIndex((l) => lineKey(l) === k);
    if (idx < 0) { lines.push(`${k}=${v}`); continue; }
    lines[idx] = `${k}=${v}`;
    // parseKV is last-wins on a duplicate key, so replacing only the first
    // occurrence would leave a later duplicate shadowing the value just set.
    const before = lines.length;
    lines = lines.filter((l, i) => i === idx || lineKey(l) !== k);
    if (lines.length !== before) collapsed.push(k);
  }
  return { text: lines.length ? `${lines.join('\n')}\n` : '', trimmed, collapsed };
}
