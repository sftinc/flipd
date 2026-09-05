import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseKV, ConfigError, loadRepo } from '../config.mjs';
import { chownRemoteDeploy } from '../owner.mjs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function writeAtomic(file, text) {
  await fs.writeFile(`${file}.tmp`, text, { mode: 0o640 });
  await chownRemoteDeploy(`${file}.tmp`, { mode: 0o640, root: true });
  await fs.rename(`${file}.tmp`, file);
}

// parseKV's ConfigError message embeds the offending line's raw text (e.g.
// `line 3: expected KEY=value, got "sk_live_..."`) — exactly right for
// build.conf/repo.conf, exactly wrong here: this file's lines are secret
// values. Never relay e.message to the operator; report only the line
// number parseKV already put first.
function syntaxErrorLine(e) {
  const m = /^line (\d+)/.exec(e.message);
  return m ? m[1] : '?';
}

export default async function (args, { paths: p, stdout, stderr }) {
  const [name, phase, ...rest] = args;
  if (!name || !['build', 'deploy'].includes(phase)) { stderr.write('usage: remote-deploy env <name> build|deploy [--set K=V] [--unset K]\n'); return 2; }
  const sets = [];
  const unsets = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--set') sets.push(rest[++i]);
    else if (rest[i] === '--unset') unsets.push(rest[++i]);
    else { stderr.write(`unknown argument ${rest[i]}\n`); return 2; }
  }
  // The file the run will actually read: the config may point elsewhere.
  const repo = await loadRepo(p, name);
  const file = phase === 'build' ? repo.buildEnvFile : repo.deployEnvFile;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.stat(file); } catch { await writeAtomic(file, ''); }
  await chownRemoteDeploy(file, { mode: 0o640, root: true });

  const label = `${name}.${phase}`;
  const report = (kv) => stdout.write(`${label}: ${[...kv.keys()].join(' ') || '(empty)'}\n`);

  if (sets.length || unsets.length) {
    let kv;
    try { kv = parseKV(await fs.readFile(file, 'utf8'), null); } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      stderr.write(`${file}: bad syntax at line ${syntaxErrorLine(e)}; fix it with: sudo remote-deploy env ${name} ${phase}\n`);
      return 1;
    }
    for (const s of sets) {
      const eq = s?.indexOf('=') ?? -1;
      if (eq <= 0) { stderr.write('--set wants KEY=value, got no "=" in the argument\n'); return 1; }
      const k = s.slice(0, eq);
      // Only the key is ever echoed back — never the value, even a malformed
      // one, so a botched paste never turns a usage error into a leak.
      if (!KEY_RE.test(k)) { stderr.write(`--set wants a plain KEY before "=", got key "${k}"\n`); return 1; }
      kv.set(k, s.slice(eq + 1));
    }
    for (const k of unsets) kv.delete(k);
    await writeAtomic(file, [...kv].map(([k, v]) => `${k}=${v}`).join('\n') + (kv.size ? '\n' : ''));
    report(kv);
    return 0;
  }

  // Edit a copy: the live file is replaced only by a version that parses, so a
  // build that starts mid-edit never reads a half-typed line.
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const draft = `${file}.edit`;
  await fs.copyFile(file, draft);
  await chownRemoteDeploy(draft, { mode: 0o640, root: true });
  try {
    for (;;) {
      const r = spawnSync(editor, [draft], { stdio: 'inherit', shell: editor.includes(' ') });
      if (r.status !== 0) { stderr.write(`${editor} exited ${r.status}; ${file} left as is\n`); return 1; }
      try {
        const kv = parseKV(await fs.readFile(draft, 'utf8'), null);
        await fs.rename(draft, file);
        report(kv);
        return 0;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        stderr.write(`${draft}: bad syntax at line ${syntaxErrorLine(e)}. Press enter to edit again, or ctrl-c to discard the edit.\n`);
        spawnSync('sh', ['-c', 'read _'], { stdio: 'inherit' });
      }
    }
  } finally {
    await fs.rm(draft, { force: true });
  }
}
