// lib/cli/trigger.mjs
//
// The SSH door: what a CI job runs over a forced-command key
// (docs/triggering-over-ssh.md). It is the webhook in exit-code form —
// accepted 0, refused 1, service down 3 — and never `run`'s override: the
// service enqueues it as a webhook, so the pending refusal, the already-live
// skip and WATCH/IGNORE all apply, and --now is not accepted. --wait holds the
// connection until the covering attempt settles and maps the outcome to the
// exit code; it is the one thing this door can do that HTTP cannot.
import { sendCommand } from '../socket.mjs';

export default async function (args, { paths, stdout, stderr, sendOverride }) {
  const [name, ...rest] = args;
  const usage = () => { stderr.write('usage: flipd trigger <name> [--wait]\n'); return 2; };
  if (!name) return usage();
  let wait = false;
  for (const a of rest) {
    if (a === '--wait') wait = true;
    else return usage();   // as `run` treats anything but --now: dropped silently, a typo looks like it worked
  }
  // With --wait there is no client timeout: the connection's lifetime is the
  // timeout, and the service dying reads as a closed socket (exit 3).
  // sendCommand's default 5s would cut off every real build.
  const send = sendOverride ?? ((m, o) => sendCommand(paths.sock, m, o));
  let reply;
  try {
    reply = await send({ cmd: 'trigger', name, wait }, wait ? { timeoutMs: null } : {});
  } catch (e) {
    stderr.write(`service down (${e.code ?? e.message}); is flipd.service running?\n`);
    return 3;
  }
  if (!reply.ok) { stderr.write(`${reply.refused ?? reply.error}\n`); return 1; }
  if (!wait) { stdout.write(`queued ${name}${reply.reason ? ` (${reply.reason})` : ''}\n`); return 0; }
  stdout.write(`${name}: ${reply.outcome}\n`);
  // `skipped` is 0 on purpose: CI must not go red because nothing needed deploying.
  return reply.outcome === 'ok' || reply.outcome === 'skipped' ? 0 : 1;
}
