import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { latestLog, ATTEMPT_ID_RE } from '../log.mjs';

export default async function (args, { paths: p, stdout, stderr }) {
  const follow = args.includes('--follow') || args.includes('-f');
  const positional = args.filter((a) => a !== '--follow' && a !== '-f');
  const usage = () => { stderr.write('usage: flipd log <name> [attempt] [--follow]\n'); return 2; };
  const [name, attempt] = positional;
  if (!name || positional.length > 2 || positional.some((a) => a.startsWith('-'))) return usage();
  // The attempt id pattern is the guard against `../`: nothing else reaches path.join.
  if (attempt !== undefined && !ATTEMPT_ID_RE.test(attempt)) return usage();
  let file;
  try {
    const dir = p.repoLog(name);
    if (attempt === undefined) {
      file = await latestLog(dir);
      if (!file) { stderr.write(`no attempt logs for ${name}\n`); return 1; }
    } else {
      file = path.join(dir, `${attempt}.log`);
      try { await fs.access(file); } catch { stderr.write(`no attempt log ${attempt} for ${name} (pruned, or never existed)\n`); return 1; }
    }
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
  if (!follow) {
    stdout.write(await fs.readFile(file, 'utf8'));
    return 0;
  }
  const tail = spawn('tail', ['-n', '+1', '-f', file], { stdio: 'inherit' });
  return new Promise((resolve) => tail.on('close', (code) => resolve(code ?? 0)));
}
