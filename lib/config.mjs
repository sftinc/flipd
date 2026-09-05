import fs from 'node:fs/promises';
import path from 'node:path';
import { NAME_RE } from './paths.mjs';

export { NAME_RE };
export class ConfigError extends Error {}

export const MAIN_KEYS = new Set(['LISTEN', 'PUBLIC_HOST', 'WEBHOOK_SECRET', 'KEEP', 'LOG_KEEP', 'LOG_MAX_BYTES']);
export const REPO_KEYS = new Set(['REPO', 'BRANCH', 'ROOT', 'BUILD', 'DEPLOY', 'ON_FAILURE', 'WATCH', 'IGNORE', 'BUILD_ENV_FILE', 'DEPLOY_ENV_FILE', 'KEY', 'TIMEOUT', 'HOOK_HOST']);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseKV(text, allowedKeys) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new ConfigError(`line ${i + 1}: expected KEY=value, got "${line}"`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) throw new ConfigError(`line ${i + 1}: bad key "${key}"`);
    if (allowedKeys && !allowedKeys.has(key)) throw new ConfigError(`line ${i + 1}: unknown key "${key}"`);
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

export function parseRepo(name, text, p) {
  if (!NAME_RE.test(name)) throw new ConfigError(`bad repo name "${name}": must match ${NAME_RE}`);
  const kv = parseKV(text, REPO_KEYS);
  for (const k of ['REPO', 'BUILD', 'DEPLOY']) {
    if (!kv.get(k)) throw new ConfigError(`${k} is required`);
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
