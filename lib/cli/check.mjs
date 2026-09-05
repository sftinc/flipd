import { checkName } from '../paths.mjs';
import { sendCommand } from '../socket.mjs';

// The check itself runs on the worker (lib/check.mjs): only the service can read
// the deploy key, and only the worker can touch the clone without racing a run.
export default async function (args, { paths: p, stdout, stderr, sendOverride }) {
  const name = args.find((a) => !a.startsWith('--'));
  const setRemote = args.includes('--set-remote');
  if (!name) { stderr.write('usage: remote-deploy check <name> [--set-remote]\n'); return 2; }
  try { checkName(name); } catch (e) { stderr.write(`${e.message}\n`); return 1; }
  const send = sendOverride ?? ((m) => sendCommand(p.sock, m, { timeoutMs: 600000 }));
  let reply;
  try {
    reply = await send({ cmd: 'check', name, setRemote });
  } catch (e) {
    stderr.write(`service down (${e.code ?? e.message}); is remote-deploy.service running?\n`);
    return 3;
  }
  if (!reply.ok) { stderr.write(`${reply.error}\n`); return 1; }
  for (const [k, v] of reply.rows) stdout.write(`${k.padEnd(8)} ${v}\n`);
  if (!reply.passed) return 1;
  return reply.behind ? 4 : 0;   // 4: nothing is wrong with the setup, but live is not the head
}
