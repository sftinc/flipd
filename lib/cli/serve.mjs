import { serve } from '../serve.mjs';

export default async function (args, { paths, stderr }) {
  const svc = await serve({ paths, journal: (l) => stderr.write(`${l}\n`) });
  const stop = async (sig) => { stderr.write(`${sig}: stopping\n`); await svc.close(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await new Promise(() => {});   // run until signalled
}
