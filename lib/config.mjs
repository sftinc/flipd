import fs from 'node:fs/promises';
import path from 'node:path';
import { NAME_RE } from './paths.mjs';

export { NAME_RE };
export class ConfigError extends Error {}

export const MAIN_KEYS = new Set(['LISTEN', 'PUBLIC_HOST', 'WEBHOOK_SECRET', 'KEEP', 'LOG_KEEP', 'LOG_MAX_BYTES']);
export const REPO_KEYS = new Set(['REPO', 'BRANCH', 'ROOT', 'BUILD', 'DEPLOY', 'ON_FAILURE', 'WATCH', 'IGNORE', 'BUILD_ENV_FILE', 'DEPLOY_ENV_FILE', 'KEY', 'TIMEOUT', 'HOOK_HOST']);
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
  if (!kv.get('WEBHOOK_SECRET')) throw new ConfigError('WEBHOOK_SECRET is required');
  const listen = kv.get('LISTEN') || '127.0.0.1:9000';
  const m = /^(.+):(\d+)$/.exec(listen);
  if (!m) throw new ConfigError(`LISTEN must be host:port, got "${listen}"`);
  return {
    listen: { host: m[1], port: Number(m[2]) },
    publicHost: kv.get('PUBLIC_HOST') || null,
    webhookSecret: kv.get('WEBHOOK_SECRET'),
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

export function parseRepo(name, text, p) {
  if (!NAME_RE.test(name)) throw new ConfigError(`bad repo name "${name}": must match ${NAME_RE}`);
  const kv = parseKV(text, REPO_KEYS);
  for (const k of ['REPO', 'BUILD', 'DEPLOY']) {
    if (!kv.get(k)) throw new ConfigError(`${k} is required`);
  }
  // A credential in the URL is a leak no message redaction can close: the URL is
  // also in git's own argv, so `ps` shows it to every local user for the life of
  // the fetch. Refused outright. A bare `ssh://git@host/...` username carries no
  // secret and is allowed; the scp-style `git@github.com:o/r.git` has no
  // userinfo at all as far as this rule is concerned (no `://`) and is the
  // documented form. The refusal never echoes the URL — that would put the
  // credential straight into journald, which is the thing being prevented.
  const cred = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/@]*)@/.exec(kv.get('REPO'));
  if (cred && !(cred[1].toLowerCase() === 'ssh' && !cred[2].includes(':'))) {
    throw new ConfigError('REPO carries credentials in the URL (user:password@ or token@); use a deploy key and a URL with no userinfo');
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
