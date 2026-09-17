import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { paths } from '../lib/paths.mjs';

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

// Every root this module hands out gets swept away when the test process exits,
// so a run against real git and real worktrees never litters the system tmpdir.
const createdRoots = [];
process.once('exit', () => {
  for (const d of createdRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export async function tmpdir(label = 'flipd', base = os.tmpdir()) {
  const dir = await fs.mkdtemp(path.join(base, `${label}-`));
  createdRoots.push(dir);
  return dir;
}

// A Unix domain socket path is capped at roughly 104 bytes on macOS and 108
// on Linux. os.tmpdir() alone can already spend most of that (macOS gives
// each session a long, random /var/folders/.../T directory), leaving too
// little room for etc/flipd/... under it plus the socket's own
// name. Every test that starts a real socket server needs a workable path,
// so root the prefix somewhere short instead of wherever the OS's tmp
// convention happens to be. An explicit TMPDIR that is already short enough
// is honoured — someone who set one on purpose knows what they are doing —
// and only overridden with /tmp (standard and short on every POSIX target
// this project runs or is tested on) when it is not. os.tmpdir() is kept as
// the fallback on Windows, which this project does not target but which
// costs nothing to guard.
function shortTmpBase() {
  if (process.platform === 'win32') return os.tmpdir();
  const explicit = process.env.TMPDIR;
  if (explicit && Buffer.byteLength(explicit) < 40) return explicit;
  return '/tmp';
}

export async function makePrefix() {
  const prefix = await tmpdir('flipd-prefix', shortTmpBase());
  const p = paths(prefix);
  for (const d of [p.reposDir, p.envDir, p.lib, p.log, path.dirname(p.sock), path.dirname(p.knownHosts)]) {
    await fs.mkdir(d, { recursive: true });
  }
  await fs.writeFile(p.knownHosts, '');
  return p;
}

export async function makeSourceRepo() {
  const dir = await tmpdir('flipd-src');
  const g = (...args) => run('git', ['-C', dir, ...args], { env: GIT_ENV });
  await run('git', ['init', '-q', '-b', 'main', dir], { env: GIT_ENV });
  async function commit(files, message = 'c') {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
    await g('add', '-A');
    await g('commit', '-q', '--allow-empty', '-m', message);
    return (await g('rev-parse', 'HEAD')).stdout.trim();
  }
  return { dir, url: `file://${dir}`, commit, git: g };
}

// PUBLIC_HOST by default, because a conf without it starts no hook listener
// (PUBLIC_HOST is the HTTP switch) and most tests here want one to POST at.
// Pass { publicHost: null } for a box with no HTTP door.
export async function writeMain(p, extra = '', { publicHost = 'deploy.example.com' } = {}) {
  await fs.mkdir(path.dirname(p.mainConf), { recursive: true });
  // A handful of call sites already pass their own PUBLIC_HOST=... in extra;
  // skip the default line then so the fixture never carries the key twice.
  const host = publicHost && !/^PUBLIC_HOST=/m.test(extra) ? `PUBLIC_HOST=${publicHost}\n` : '';
  await fs.writeFile(p.mainConf, `WEBHOOK_SECRET=testsecret\nLISTEN=127.0.0.1:0\n${host}${extra}`);
}

export async function writeRepoConf(p, name, kv) {
  await fs.mkdir(p.reposDir, { recursive: true });
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(path.join(p.reposDir, `${name}.conf`), text);
}

export async function writeAccountConf(p, host, kv) {
  await fs.mkdir(p.accountsDir, { recursive: true });
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(path.join(p.accountsDir, `${host}.conf`), text);
}

// A forge's API, scripted. Records every request so a test can assert what
// was sent (auth header, body) and answers from `script`, which the test may
// edit between calls to make a later step succeed or fail.
export async function fakeForge(script) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    seen.push({ method: req.method, path: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
    const [status, payload] = script[`${req.method} ${req.url}`] ?? [404, { message: 'Not Found' }];
    const out = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
    res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { api: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
