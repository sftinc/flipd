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

export async function tmpdir(label = 'remote-deploy') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  createdRoots.push(dir);
  return dir;
}

export async function makePrefix() {
  const prefix = await tmpdir('remote-deploy-prefix');
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
