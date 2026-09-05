import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function tmpdir(label = 'remote-deploy', base = os.tmpdir()) {
  const dir = await fs.mkdtemp(path.join(base, `${label}-`));
  createdRoots.push(dir);
  return dir;
}

// A Unix domain socket path is capped at roughly 104 bytes on macOS and 108
// on Linux. os.tmpdir() alone can already spend most of that (macOS gives
// each session a long, random /var/folders/.../T directory), leaving too
// little room for etc/remote-deploy/... under it plus the socket's own
// name. Every test that starts a real socket server needs a workable path,
// so root the prefix somewhere short and fixed instead of wherever the OS's
// tmp convention happens to be. /tmp is standard and short on every POSIX
// target this project runs or is tested on; os.tmpdir() is kept as the
// fallback elsewhere (e.g. Windows) where that assumption does not hold.
const SHORT_TMP_BASE = process.platform === 'win32' ? os.tmpdir() : '/tmp';

export async function makePrefix() {
  const prefix = await tmpdir('remote-deploy-prefix', SHORT_TMP_BASE);
  const p = paths(prefix);
  for (const d of [p.reposDir, p.envDir, p.lib, p.log, path.dirname(p.sock), path.dirname(p.knownHosts)]) {
    await fs.mkdir(d, { recursive: true });
  }
  await fs.writeFile(p.knownHosts, '');
  return p;
}

export async function makeSourceRepo() {
  const dir = await tmpdir('remote-deploy-src');
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

export async function writeMain(p, extra = '') {
  await fs.mkdir(path.dirname(p.mainConf), { recursive: true });
  await fs.writeFile(p.mainConf, `WEBHOOK_SECRET=testsecret\nLISTEN=127.0.0.1:0\n${extra}`);
}

export async function writeRepoConf(p, name, kv) {
  await fs.mkdir(p.reposDir, { recursive: true });
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(path.join(p.reposDir, `${name}.conf`), text);
}
