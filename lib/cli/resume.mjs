import { request } from './pause.mjs';

export default async function (args, ctx) {
  const [name, ...rest] = args;
  if (!name || name.startsWith('-') || rest.length) { ctx.stderr.write('usage: flipd resume <name>\n'); return 2; }
  const reply = await request({ cmd: 'resume', name }, ctx);
  if (typeof reply === 'number') return reply;
  if (!reply.ok) { ctx.stderr.write(`${reply.error}\n`); return 1; }
  ctx.stdout.write(reply.resumed ? `resumed ${name}\n` : `${name}: not paused\n`);
  return 0;
}
