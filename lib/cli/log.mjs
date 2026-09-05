import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { latestLog } from '../log.mjs';

export default async function (args, { paths: p, stdout, stderr }) {
  const name = args.find((a) => !a.startsWith('--'));
  const follow = args.includes('--follow') || args.includes('-f');
  if (!name) { stderr.write('usage: remote-deploy log <name> [--follow]\n'); return 2; }
  let file;
  try { file = await latestLog(p.repoLog(name)); } catch (e) { stderr.write(`${e.message}\n`); return 1; }
  if (!file) { stderr.write(`no attempt logs for ${name}\n`); return 1; }
  if (!follow) {
    stdout.write(await fs.readFile(file, 'utf8'));
    return 0;
  }
  const tail = spawn('tail', ['-n', '+1', '-f', file], { stdio: 'inherit' });
  return new Promise((resolve) => tail.on('close', (code) => resolve(code ?? 0)));
}
