import { viaSocket } from './run.mjs';

export default async function (args, ctx) {
  const r = await viaSocket('rollback', args, ctx);
  if (typeof r === 'number') return r;
  ctx.stdout.write(`queued rollback of ${args[0]} to ${r.target}\n`);
  return 0;
}
