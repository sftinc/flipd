// lib/cli/cancel.mjs
//
// Stops a repo: the running attempt (as a shutdown would, up to and including
// DEPLOY), everything queued for it, and a rollback being accepted. The reply is
// a request, not a verdict — `flipd status <name>` shows the outcome.
import { request } from './pause.mjs';

export default async function (args, ctx) {
  const [name, ...rest] = args;
  if (!name || name.startsWith('-') || rest.length) { ctx.stderr.write('usage: flipd cancel <name>\n'); return 2; }
  const reply = await request({ cmd: 'cancel', name }, ctx);
  if (typeof reply === 'number') return reply;
  if (!reply.ok) { ctx.stderr.write(`${reply.error}\n`); return 1; }
  if (reply.signalled) {
    const dropped = reply.dropped ? ` (${reply.dropped} queued dropped)` : '';
    ctx.stdout.write(`cancel requested for active attempt on ${name}${dropped}; run flipd status ${name} to see its outcome\n`);
  } else {
    ctx.stdout.write(`dropped ${reply.dropped} queued for ${name}\n`);
  }
  return 0;
}
