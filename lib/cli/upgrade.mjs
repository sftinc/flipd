// lib/cli/upgrade.mjs
//
// Waits for every repo to be idle, fast-forwards the clone the service runs
// from, restarts the unit, and proves the socket answers again. It replaces a
// procedure whose warning ("check that flipd status shows nothing running
// first") is repeated in root CLAUDE.md, docs/install.md and docs/agent.md.
//
// CLI-only on purpose: the service cannot restart itself and still report what
// happened, so nothing here is a socket command and nothing in lib/serve.mjs
// changes. The one socket call is {cmd:'status'}, which already exists.

// `systemctl show flipd -p LoadState -p ...` prints one KEY=VALUE per line.
// Labelled properties and not `--value`, because a unit that does not exist
// exits 0 with LoadState=not-found: the exit code is not the answer here, the
// labels are. ExecStart prints as `{ path=... ; argv[]=... ; ... }`.
export function parseSystemdShow(out) {
  const kv = {};
  for (const line of String(out).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const m = /(?:^|[\s{])path=([^;]+?)\s*;/.exec(kv.ExecStart ?? '');
  return {
    loadState: kv.LoadState ?? '',
    activeState: kv.ActiveState ?? '',
    subState: kv.SubState ?? '',
    mainPid: kv.MainPID ?? '0',
    execStart: m ? m[1] : '',
  };
}

export default async function (args, { stderr }) {
  let restartOnly = false;
  for (const a of args) {
    if (a === '--restart-only') restartOnly = true;
    else { stderr.write('usage: flipd upgrade [--restart-only]\n'); return 2; }
  }
  void restartOnly;
  return 0;
}
