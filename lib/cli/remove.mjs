import fs from 'node:fs/promises';
import { sendCommand } from '../socket.mjs';

export default async function (args, { paths: p, stdout, stderr, statusOverride }) {
  const name = args[0];
  if (!name) { stderr.write('usage: remote-deploy remove <name>\n'); return 2; }
  const conf = p.repoConf(name);   // validates the name: "../remote-deploy" dies here
  try { await fs.stat(conf); } catch { stderr.write(`no repo named ${name}\n`); return 1; }
  let st = null;
  try { st = await (statusOverride ?? ((m) => sendCommand(p.sock, m, { timeoutMs: 1500 })))({ cmd: 'status' }); } catch { /* service down: nothing can be running */ }
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
