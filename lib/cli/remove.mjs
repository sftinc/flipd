import fs from 'node:fs/promises';
import { sendCommand } from '../socket.mjs';

export default async function (args, { paths: p, stdout, stderr, statusOverride }) {
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
  await fs.rm(conf);
  stdout.write(`removed ${conf}
state and logs were kept. To delete them too:
  sudo rm -rf ${p.repoDir(name)}
  sudo rm -rf ${p.repoLog(name)}
  sudo rm -f ${p.envFile(name, 'build')} ${p.envFile(name, 'deploy')}
`);
  return 0;
}
