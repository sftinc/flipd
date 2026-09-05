import { viaSocket } from './run.mjs';

export default async function (args, ctx) {
  const r = await viaSocket('rollback', args, ctx);
  if (typeof r === 'number') return r;
  // r.queued can be false (e.g. the service is mid-shutdown): say so, the way
  // `run` already does, rather than reporting "queued" for work that was
  // actually dropped.
  ctx.stdout.write(r.queued ? `queued rollback of ${args[0]} to ${r.target}\n` : `not queued: ${r.reason}\n`);
  return 0;
}
