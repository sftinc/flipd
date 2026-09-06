import { checkName } from '../paths.mjs';
import { sendCommand } from '../socket.mjs';
import { loadMain, loadRepo } from '../config.mjs';
import { parseRepoUrl } from './add.mjs';
import { webhookRecipe } from './recipe.mjs';

// The check itself runs on the worker (lib/check.mjs): only the service can read
// the deploy key, and only the worker can touch the clone without racing a run.
export default async function (args, { paths: p, stdout, stderr, sendOverride }) {
  const name = args.find((a) => !a.startsWith('--'));
  const setRemote = args.includes('--set-remote');
  if (!name) { stderr.write('usage: flipd check <name> [--set-remote]\n'); return 2; }
  try { checkName(name); } catch (e) { stderr.write(`${e.message}\n`); return 1; }
  const send = sendOverride ?? ((m) => sendCommand(p.sock, m, { timeoutMs: 600000 }));
  let reply;
  try {
    reply = await send({ cmd: 'check', name, setRemote });
  } catch (e) {
    stderr.write(`service down (${e.code ?? e.message}); is flipd.service running?\n`);
    return 3;
  }
  if (!reply.ok) { stderr.write(`${reply.error}\n`); return 1; }
  for (const [k, v] of reply.rows ?? []) stdout.write(`${k.padEnd(8)} ${v}\n`);

  // The webhook recipe, re-printable. `add` shows it once, and if --host was
  // set afterwards it showed a placeholder; this is the second chance. Best
  // effort: a conf that cannot be read means the rows above already said so
  // (or the service did), and the recipe is not worth a second error. The
  // host comes from the main conf first, then the HOOK_HOST recorded at add
  // time, then a placeholder -- never a guess.
  let repo = null;
  try { repo = await loadRepo(p, name); } catch { /* unreadable here (EACCES, or removed since the service read it): the recipe is not worth a second error */ }
  if (repo) {
    let main = null;
    try { main = await loadMain(p); } catch { /* installer not run yet: placeholder */ }
    const host = main?.publicHost ?? repo.hookHost ?? '<PUBLIC_HOST>';
    const gh = parseRepoUrl(repo.repo);
    const ghRepo = gh ? `${gh.owner}/${gh.repo}` : '<owner>/<repo>';
    stdout.write(`\nwebhook  ${webhookRecipe({ host, ghRepo, mainConf: p.mainConf })}\n`);
  }

  if (!reply.passed) return 1;
  // Nothing is wrong with the setup in either case. 5 outranks 4 because they
  // want opposite things: 4 is a catch-up (`flipd run`), 5 is an unconfirmed
  // flip that a catch-up would silently build over.
  if (reply.pending) return 5;   // 5: a release is flipped but never confirmed
  return reply.behind ? 4 : 0;   // 4: live is not the head
}
