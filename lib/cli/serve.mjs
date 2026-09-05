import { serve } from '../serve.mjs';

export default async function (args, { paths, stderr }) {
  const svc = await serve({ paths, journal: (l) => stderr.write(`${l}\n`) });
  const stop = async (sig) => {
    stderr.write(`${sig}: stopping\n`);
    try {
      await svc.close();
      process.exit(0);
    } catch (e) {
      // A rejecting close() must exit with a line, not an unhandled
      // rejection's stack — this runs from a signal handler with nothing
      // else to catch it.
      stderr.write(`shutdown error: ${e.message}\n`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await new Promise(() => {});   // run until signalled
}
