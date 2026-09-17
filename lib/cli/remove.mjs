import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendCommand } from '../socket.mjs';
import { takeLock, releaseLock, removeSite } from './domain.mjs';

const run = promisify(execFile);

export default async function (args, { paths: p, stdout, stderr, statusOverride, runOverride }) {
  const name = args[0];
  if (!name) { stderr.write('usage: flipd remove <name>\n'); return 2; }
  const conf = p.repoConf(name);   // validates the name: "../flipd" dies here
  try { await fs.stat(conf); } catch { stderr.write(`no repo named ${name}\n`); return 1; }
  let st = null;
  try {
    st = await (statusOverride ?? ((m) => sendCommand(p.sock, m, { timeoutMs: 1500 })))({ cmd: 'status' });
  } catch (e) {
    // ECONNREFUSED/ENOENT (no socket file, nothing listening) is a definite
    // "the service is down; nothing can be running" — safe to proceed. A bare
    // timeout, or anything else, is *not* proof of that: a busy worker can
    // simply miss the probe's window while a deploy for this very repo is in
    // flight. Failing open there would delete a running repo's config out
    // from under it, so refuse instead of guessing.
    if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT') {
      stderr.write(`could not reach flipd.service in time to check whether ${name} is running; try again once it is less busy\n`);
      return 1;
    }
  }
  if (st?.ok && (st.running === name || st.queued.includes(name))) {
    stderr.write(`${name} is ${st.running === name ? 'running' : 'queued'}; wait for it, then remove\n`);
    return 1;
  }
  const exec = runOverride ?? ((cmd, argv) => run(cmd, argv));
  try { await takeLock(p.domainLock, 'flipd remove'); }
  catch (e) { stderr.write(`${e.message}\n`); return 1; }
  let code = 0;
  try {
    await fs.rm(conf);
    try {
      if (await removeSite(p, name, exec, { stderr })) stdout.write(`removed ${p.caddySite(name)} and reloaded caddy\n`);
    } catch (e) {
      // Both deletions have happened by now. Reporting success would be a lie
      // about a site that is still answering.
      stderr.write(`${e.stderr?.trim() || e.message}\nthe site file is gone but caddy still has the old config; run: sudo systemctl reload caddy\n`);
      code = 1;
    }
  } finally {
    await releaseLock(p.domainLock);
  }
  stdout.write(`removed ${conf}
state and logs were kept. To delete them too:
  sudo rm -rf ${p.repoDir(name)}
  sudo rm -rf ${p.repoLog(name)}
  sudo rm -f ${p.envFile(name, 'build')} ${p.envFile(name, 'deploy')}
`);
  return code;
}
