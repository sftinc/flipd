import { sendCommand } from '../socket.mjs';

export async function viaSocket(cmd, args, { paths, stdout, stderr }) {
  const name = args[0];
  if (!name) { stderr.write(`usage: flipd ${cmd} <name>\n`); return 2; }
  let reply;
  try {
    reply = await sendCommand(paths.sock, { cmd, name });
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
