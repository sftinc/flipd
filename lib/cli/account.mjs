// lib/cli/account.mjs
//
// An account is one access token per host, used by `add` to upload the
// deploy key and create the webhook, and by nothing else. The conf is root-only
// (0600) because no unprivileged command needs it and the service must not be
// able to read a credential that can create webhooks.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { HOST_RE } from '../paths.mjs';
import { loadAccount } from '../config.mjs';

const run = promisify(execFile);
const KINDS = ['github', 'forgejo', 'gitea'];
const USAGE = `usage: flipd account add <host> --kind github|forgejo|gitea [--api URL] [--ssh-port N]  < token-file
       flipd account list
       flipd account remove <host>
`;

// "SHA256:<base64, no padding>" of the decoded key blob — the same string
// `ssh-keygen -lf` prints and the same one a forge shows on its own page, so
// the operator can compare without a second tool.
export function fingerprint(line) {
  const [, type, b64] = line.trim().split(/\s+/);
  const hash = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
  return `${type} SHA256:${hash}`;
}

// ssh-keyscan prints one known_hosts line per key type and its banner chatter
// on stderr. Off port 22 the host field is "[host]:port", which is how ssh
// looks the key up for the ssh://host:port/... URLs such a forge renders.
export async function defaultKeyscan(host, port) {
  const args = ['-t', 'ed25519,ecdsa,rsa', ...(port ? ['-p', String(port)] : []), host];
  const { stdout } = await run('ssh-keyscan', args, { timeout: 30000 });
  return stdout.split('\n').filter((l) => l && !l.startsWith('#'));
}

async function readToken(stdin) {
  let s = '';
  stdin.setEncoding?.('utf8');
  for await (const c of stdin) s += c;
  return s.replace(/\r?\n$/, '');
}

async function addAccount(rest, { p, stdout, stderr, stdin, keyscanOverride }) {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { kind: { type: 'string' }, api: { type: 'string' }, 'ssh-port': { type: 'string' } } });
  } catch (e) {
    stderr.write(`${e.message}\n`); return 2;
  }
  const host = parsed.positionals[0]?.toLowerCase();
  const { kind, api } = parsed.values;
  if (!host || parsed.positionals.length > 1 || !kind) { stderr.write(USAGE); return 2; }
  // Every value is validated before anything is read from stdin or written:
  // a refused invocation leaves no conf, no directory and no known_hosts line.
  if (!HOST_RE.test(host)) { stderr.write(`bad host "${host}": must be a hostname like forge.example.com\n`); return 1; }
  if (!KINDS.includes(kind)) { stderr.write(`--kind must be one of ${KINDS.join(', ')}\n`); return 1; }
  if (api !== undefined && !/^https:\/\//i.test(api)) { stderr.write('--api must be an https:// URL (the token travels in every request)\n'); return 1; }
  const portStr = parsed.values['ssh-port'];
  if (portStr !== undefined && !/^\d{1,5}$/.test(portStr)) { stderr.write('--ssh-port must be a port number\n'); return 1; }
  const port = portStr === undefined ? null : Number(portStr);
  const conf = p.accountConf(host);
  try { await fs.stat(conf); stderr.write(`${conf} already exists; flipd account remove ${host} first\n`); return 1; } catch { /* good */ }

  // The token comes in on stdin and nowhere else: a flag lands in `ps` for the
  // life of the process and in the shell's history for good.
  if (stdin.isTTY) { stderr.write(`pipe the token on stdin: flipd account add ${host} --kind ${kind} < token-file\n`); return 1; }
  const token = await readToken(stdin);
  if (!token) { stderr.write('empty token on stdin\n'); return 1; }
  if (/[\s\x00-\x1f\x7f]/.test(token)) { stderr.write('the token contains whitespace or a control character\n'); return 1; }

  // Host key, for any host the installer did not already cover.
  let scanned = [];
  if (host !== 'github.com') {
    try {
      scanned = await (keyscanOverride ?? defaultKeyscan)(host, port);
    } catch (e) {
      stderr.write(`ssh-keyscan ${host} failed: ${e.message}\n`); return 1;
    }
    if (scanned.length === 0) { stderr.write(`ssh-keyscan ${host} returned no host key; refusing to record nothing\n`); return 1; }
    let existing = '';
    try { existing = await fs.readFile(p.knownHosts, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const known = new Set(existing.split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean));
    const fresh = scanned.filter((l) => !known.has(l.split(/\s+/)[0]));
    if (fresh.length) await fs.appendFile(p.knownHosts, fresh.map((l) => `${l}\n`).join(''));
  }

  await fs.mkdir(p.accountsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(p.accountsDir, 0o700);   // mkdir's mode is subject to umask; this is not
  const lines = [`KIND=${kind}`, ...(api ? [`API=${api.replace(/\/+$/, '')}`] : []), `TOKEN=${token}`];
  await fs.writeFile(conf, lines.join('\n') + '\n', { mode: 0o600 });
  await fs.chmod(conf, 0o600);

  stdout.write(`wrote ${conf}\n`);
  if (scanned.length) {
    stdout.write(`recorded ${host}'s SSH host key in ${p.knownHosts}. Compare these fingerprints with the ones ${host} publishes:\n`);
    for (const l of scanned) stdout.write(`  ${fingerprint(l)}\n`);
  }
  stdout.write(`\nnext:  sudo flipd add <url on ${host}>\n`);
  return 0;
}

async function listAccounts({ p, stdout }) {
  let files = [];
  try {
    files = (await fs.readdir(p.accountsDir)).filter((f) => f.endsWith('.conf')).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const f of files) {
    const host = f.slice(0, -'.conf'.length);
    try {
      const acct = await loadAccount(p, host);
      stdout.write(`${host}  ${acct.kind}  ${acct.api}  token: set\n`);
    } catch (e) {
      stdout.write(`${host}  (unreadable: ${e.message})\n`);   // ConfigError messages never carry a value
    }
  }
  return 0;
}

async function removeAccount(rest, { p, stdout, stderr }) {
  const host = rest[0]?.toLowerCase();
  if (!host || rest.length > 1) { stderr.write(USAGE); return 2; }
  const conf = p.accountConf(host);   // validates the host
  try { await fs.stat(conf); } catch { stderr.write(`no account named ${host}\n`); return 1; }
  await fs.rm(conf);
  stdout.write(`removed ${conf}\nrepos already added on ${host} are unaffected; new ones take the manual add path\n`);
  return 0;
}

export default async function (args, { paths: p, stdout, stderr, stdin = process.stdin, keyscanOverride }) {
  const [sub, ...rest] = args;
  const ctx = { p, stdout, stderr, stdin, keyscanOverride };
  if (sub === 'add') return addAccount(rest, ctx);
  if (sub === 'list') return listAccounts(ctx);
  if (sub === 'remove') return removeAccount(rest, ctx);
  stderr.write(USAGE);
  return 2;
}
