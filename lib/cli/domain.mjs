// lib/cli/domain.mjs
//
// One Caddy site block per repo. The record is the repo conf (DOMAIN,
// DOMAIN_PORT, DOMAIN_ROOT, DOMAIN_SPA); the site file is rendered whole from
// it on every change and never parsed back, which is what makes several
// hostnames cost nothing.

import fs from 'node:fs/promises';

// flipd writes and deletes a file in conf.d only when its first line is this.
// A hand-written file is refused, named, and left alone.
export const MARKER = '# managed by flipd';

// `log { output stderr }` is in both shapes deliberately: it makes
// `journalctl -u caddy` the record for this site the way it already is for
// /deploy, rather than depending on what the installed Caddy logs by default.
// Not `output file` — the unit's sandbox refuses writes under /var/log/caddy.
export function renderSite({ hosts, port, root, spa = false }) {
  const body = port
    ? ['    encode zstd gzip', `    reverse_proxy 127.0.0.1:${port}`]
    : [
        `    root * ${root}`,
        '    encode zstd gzip',
        ...(spa
          ? ['    handle {', '        try_files {path} /index.html', '        file_server', '    }']
          : ['    file_server']),
      ];
  return [
    `${MARKER} — edits are lost on the next \`flipd domain\` command`,
    `${hosts.join(', ')} {`,
    '    log {',
    '        output stderr',
    '    }',
    ...body,
    '}',
    '',
  ].join('\n');
}

// No other config-writing command in flipd locks, and env.mjs says outright
// that two concurrent `sudo flipd env` calls are a thing an operator can do.
// This needs a reason env does not have, and has three:
//
//   - Two first-use `domain add`s each see no import line and each append one.
//     Two imports expand every conf.d site block twice, and install.sh already
//     records what Caddy does with a duplicate site: it refuses the file with
//     `ambiguous site definition`. The loser rolls back its own files and
//     leaves the second import behind — a Caddyfile that will not load, from a
//     command that reported failure.
//   - `caddy validate` and `systemctl reload` are two separate readings of one
//     globally imported set. A validates, B writes its site file, A reloads:
//     A has published a config B never committed, and B's rollback then leaves
//     Caddy serving something no longer on disk.
//   - `flipd remove` races a domain change on the same repo, with no
//     coordination at all today.
//
// env's race loses one edit. This one leaves the running config and the disk
// disagreeing. Different class, different answer.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function takeLock(file, what) {
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(file, 'wx', 0o600);
      try { await fh.writeFile(`${process.pid}\n${what}\n${new Date().toISOString()}\n`); }
      finally { await fh.close(); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt > 0) throw e;
      // Stale locks are handled by the pid, not by a timeout: a timeout would
      // have to guess how long a `caddy validate` may legitimately take, and
      // guessing wrong breaks the safe case to rescue the broken one. A
      // recycled pid makes the refusal spurious, which fails in the safe
      // direction — a person can see it and remove the file in one command.
      // Stealing a lock from a live process cannot be undone.
      const [pid, held, when] = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n');
      if (/^\d+$/.test(pid ?? '') && alive(Number(pid))) {
        throw Object.assign(new Error(`another flipd command is changing domains: pid ${pid} (${held || 'unknown'}) since ${when || 'unknown'}.\nIf that process is gone, remove ${file}`), { code: 'ELOCKED' });
      }
      await fs.rm(file, { force: true });
    }
  }
}

export async function releaseLock(file) {
  await fs.rm(file, { force: true }).catch(() => {});
}
