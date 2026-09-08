import { sendCommand } from '../socket.mjs';

export async function viaSocket(cmd, args, { paths, stdout, stderr }) {
  const [name, ...rest] = args;
  const usage = () => { stderr.write(`usage: flipd ${cmd} <name> [--now]\n`); return 2; };
  if (!name) return usage();
  // --now skips STOP for this one attempt: the operator saying "cut it off"
  // in so many words. Anything else after the name is a usage error, not
  // silently ignored — a misspelt flag that is dropped looks like it worked.
  let now = false;
  for (const a of rest) {
    if (a === '--now') now = true;
    else return usage();
  }
  let reply;
  try {
    reply = await sendCommand(paths.sock, { cmd, name, now });
  } catch (e) {
    stderr.write(`service down (${e.code ?? e.message}); is flipd.service running?\n`);
    return 3;
  }
  if (!reply.ok) { stderr.write(`${reply.error}\n`); return 1; }
  return reply;
}

export default async function (args, ctx) {
  const r = await viaSocket('run', args, ctx);
  if (typeof r === 'number') return r;
  ctx.stdout.write(r.queued ? `queued ${args[0]}\n` : `not queued: ${r.reason}\n`);
  return 0;
}
