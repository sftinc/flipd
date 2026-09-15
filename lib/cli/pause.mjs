// lib/cli/pause.mjs
//
// A paused repo refuses pushes and `flipd trigger`, exactly where `pending` does;
// `run` and `rollback` still work, so the person handling an incident can still
// deploy a fix or go back. The marker lives in /var/lib/flipd/<name>/paused and
// is written by the service.
import { sendCommand } from '../socket.mjs';

// One message, one reply, or 3 for a service that cannot be reached. Shared by
// pause, resume and cancel.
export async function request(msg, { paths, stderr, sendOverride }) {
  const send = sendOverride ?? ((m) => sendCommand(paths.sock, m));
  try {
    return await send(msg);
  } catch (e) {
    stderr.write(`service down (${e.code ?? e.message}); is flipd.service running?\n`);
    return 3;
  }
}

export default async function (args, ctx) {
  const usage = () => { ctx.stderr.write('usage: flipd pause <name> [--reason TEXT]\n'); return 2; };
  const [name, ...rest] = args;
  if (!name || name.startsWith('-')) return usage();
  let reason = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--reason' && rest[i + 1] !== undefined) reason = rest[++i];
    else return usage();
  }
  const reply = await request({ cmd: 'pause', name, reason }, ctx);
  if (typeof reply === 'number') return reply;
  if (!reply.ok) { ctx.stderr.write(`${reply.error}\n`); return 1; }
  ctx.stdout.write(reply.already ? `${name}: already paused since ${reply.since ?? '(unknown)'}\n` : `paused ${name}\n`);
  return 0;
}
