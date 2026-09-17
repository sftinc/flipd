// lib/cli/domain.mjs
//
// One Caddy site block per repo. The record is the repo conf (DOMAIN,
// DOMAIN_PORT, DOMAIN_ROOT, DOMAIN_SPA); the site file is rendered whole from
// it on every change and never parsed back, which is what makes several
// hostnames cost nothing.

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
