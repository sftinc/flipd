// lib/cli/domain.mjs
//
// One Caddy site block per repo. The record is the repo conf (DOMAIN,
// DOMAIN_PORT, DOMAIN_ROOT, DOMAIN_SPA); the site file is rendered whole from
// it on every change and never parsed back, which is what makes several
// hostnames cost nothing.

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { loadMain, loadRepo, loadRepos, editKV, writeAtomic, ConfigError } from '../config.mjs';
import { checkHost } from '../paths.mjs';

const run = promisify(execFile);
const USAGE = `usage: flipd domain add <name> <host>... [--port N | --root DIR] [--spa]
       flipd domain remove <name> [<host>...]
       flipd domain list [name]
`;
// install.sh's own regex, so the line it writes is recognised as the line it wrote.
const IMPORT_RE = /^\s*import\s+(\/etc\/caddy\/)?conf\.d\/\*/m;

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

// Refused, never escaped into shape. DOMAIN_ROOT goes into the repo conf, and
// parseKV is line-oriented: a newline in this value splits the line, loadRepo
// throws, and the service skips that repo on every event afterwards — a
// cosmetic flag would have stopped the repo deploying. install.sh holds its own
// clone path to the same kind of rule for the same reason.
// Never add the `m` flag: `$` must not match before a trailing newline, or a
// value that is otherwise valid except for one trailing "\n" would pass.
export const ROOT_RE = /^\/[A-Za-z0-9/_.+@~:,-]*$/;

export function checkTarget({ port, root, spa = false }) {
  if (port && root) return 'give --port or --root, not both: a site block has one upstream';
  if (spa && !root) return '--spa serves a single-page app from a directory; it needs --root';
  if (port !== undefined && port !== null) {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) return '--port must be a whole number from 1 to 65535';
  }
  // The rejected value is never echoed: a botched paste must not turn a usage
  // error into a leak, and naming the flag is enough to find the argument.
  if (root !== undefined && root !== null && !ROOT_RE.test(root)) {
    return '--root must be an absolute path made of letters, digits and / _ . + @ ~ : , -';
  }
  return null;
}

export function checkHostArg(host) {
  const h = String(host ?? '').toLowerCase();
  // checkHost's own message interpolates the value, and an argument in the host
  // position can be a wrapped paste of a secret. The rule stays there; the
  // message stops here.
  try { return checkHost(h); }
  catch { throw Object.assign(new Error('a hostname must be a DNS name like app.example.com'), { code: 'EBADHOST' }); }
}

// Read a conf.d file only to decide whether it is ours. Anything whose first
// line is not the marker is someone else's and is neither written nor deleted.
async function ours(file) {
  const text = await fs.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (text === null) return { exists: false, mine: true, text: null };
  return { exists: true, mine: text.startsWith(MARKER), text };
}

// Is there already an import that will pick up this repo's site file once
// written? Two shapes count: install.sh's own line, at the real, unprefixed
// `/etc/caddy/conf.d` (IMPORT_RE, which is install.sh's own regex, so the line
// it writes is recognised as the line it wrote) — and the exact line bootstrap
// below appends, naming this call's own caddyDir. Matched per whole trimmed
// line, not by substring: a commented-out `# import .../conf.d/*` or an import
// of an unrelated directory that merely contains "conf.d/*" as a substring
// (a backup copy at /srv/backup/etc/caddy/conf.d/*, say) must not read as
// "already imported" — install.sh's own check is exactly this line-anchored
// regex, and the two must agree on one Caddyfile.
//
// Under a non-default FLIPD_PREFIX, a Caddyfile carrying the literal
// `/etc/caddy/conf.d/*` (IMPORT_RE's own match) names a directory that is
// *not* this prefix's caddyDir, so this can, in principle, misreport an
// unrelated real path as covering a prefixed one. Harmless in production,
// where the prefix is `/` and the two are the same path — this is a
// prefix-only test artifact, not a bug to fix here.
function hasImport(main, p) {
  return IMPORT_RE.test(main)
    || main.split('\n').some((l) => l.trim() === `import ${p.caddyDir}/*`);
}

// mkdir the directory and append the import if it is missing. Neither is ever
// undone: a directory and an import that name no files publish nothing — an
// import glob matching nothing is a warning to Caddy, not an error — so a failed
// add can leave both and has changed nothing observable. That is what keeps
// /etc/caddy/Caddyfile out of the rollback, and keeping it out is the point: it
// is a dpkg conffile, and restoring it would mean writing its own inode to
// preserve its mode and owner. The only thing done to it here is one append.
async function bootstrap(p, stderr) {
  const main = await fs.readFile(p.caddyMain, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (main === null) {
    stderr.write(`no ${p.caddyMain}: caddy is not installed here. Install it and run install.sh --host <name>\n`);
    return false;
  }
  if (!hasImport(main, p)) {
    // Appending the wildcard import would publish whatever is already parked in
    // that directory, which is not this command's to publish. Not a pointer at
    // install.sh --host: that performs the same activation *and* overwrites
    // flipd.caddy and edits the packaged :80 block, so it moves the surprise.
    // The count, never the names — a filename can carry control characters.
    const parked = await fs.readdir(p.caddyDir).catch(() => []);
    if (parked.length) {
      stderr.write(`${p.caddyDir} holds ${parked.length} file${parked.length === 1 ? '' : 's'} and nothing imports it.\nLook at what is in there, then add "import ${p.caddyDir}/*" to ${p.caddyMain} yourself\n`);
      return false;
    }
    await fs.appendFile(p.caddyMain, `\nimport ${p.caddyDir}/*\n`);
  }
  await fs.mkdir(p.caddyDir, { recursive: true, mode: 0o755 });
  return true;
}

// Render this repo's site file from its conf — or unlink it when the repo has no
// hostnames left — then validate and reload. Both readings are of one globally
// imported set, which is why the caller holds the lock across them.
export async function applySite(p, name, exec) {
  const r = await loadRepo(p, name);
  const file = p.caddySite(name);
  if (r.domain.length) {
    await fs.writeFile(file, renderSite({ hosts: r.domain, port: r.domainPort, root: r.domainRoot, spa: r.domainSpa }), { mode: 0o644 });
    await fs.chmod(file, 0o644);   // root's umask is often 077; caddy runs as its own user
  } else {
    await fs.rm(file, { force: true });
  }
  await exec('caddy', ['validate', '--config', p.caddyMain]);
  await exec('systemctl', ['reload', 'caddy']);
}

export default async function (args, { paths: p, stdout, stderr, runOverride }) {
  const verb = args[0];
  if (!['add', 'remove', 'list'].includes(verb)) { stderr.write(USAGE); return 2; }
  const exec = runOverride ?? ((cmd, argv) => run(cmd, argv));
  // list reads and does not write, so it takes no lock and needs no caddy.
  if (verb === 'list') return await list(args.slice(1), { paths: p, stdout, stderr });

  let parsed;
  try {
    parsed = parseArgs({ args: args.slice(1), allowPositionals: true, options: { port: { type: 'string' }, root: { type: 'string' }, spa: { type: 'boolean' } } });
  } catch {
    // parseArgs' own message quotes the offending token back, twice; an argv
    // token is exactly where a botched paste of a secret lands, and env.mjs
    // refuses to echo a stray argument for the same reason. Say what was
    // wrong and print the accepted flags; the operator can see their own
    // command line.
    stderr.write(`unknown option, or an option given without its value\n${USAGE}`); return 2;
  }
  const [name, ...rawHosts] = parsed.positionals;
  if (!name) { stderr.write(USAGE); return 2; }

  let hosts;
  try { hosts = rawHosts.map(checkHostArg); } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  // `remove` has nowhere to put a target flag, and dropping one silently is
  // destructive: `domain remove app --port 3000` reads as "unname port 3000"
  // but every hostname is what would go. Refuse it here, where the verb is
  // known — checkTarget is pure and cannot see one.
  if (verb === 'remove' && (parsed.values.port !== undefined || parsed.values.root !== undefined || parsed.values.spa)) {
    stderr.write(`remove takes hostnames only; --port, --root and --spa belong to add\n${USAGE}`); return 2;
  }
  // Only `add` needs a target: `remove` with no hostnames is the "remove all"
  // shape. `--spa` counts, since on a repo that already has DOMAIN_ROOT it is
  // a change on its own.
  if (verb === 'add' && !hosts.length && !parsed.values.port && !parsed.values.root && !parsed.values.spa) { stderr.write(USAGE); return 2; }

  let repo;
  try { repo = await loadRepo(p, name); } catch (e) {
    // A conf that is not there (or a name that cannot name one) is "no repo
    // named X". A conf that is there but will not parse is a different
    // problem and gets ConfigError's own message — line numbers only, never
    // a value off the file — the same shape the sibling scan below already
    // relays for every *other* repo's broken conf.
    if (e instanceof ConfigError) { stderr.write(`${p.repoConf(name)}: ${e.message}\n`); return 1; }
    stderr.write(`no repo named ${name}\n`); return 1;
  }

  // `--spa` with no `--root` is only a mistake when there is no root for it to
  // apply to. A repo that already has DOMAIN_ROOT and is not being retargeted
  // has one, and "--spa needs --root" would be a false reason for the refusal.
  // checkTarget is pure and cannot see the repo, so that one case is settled
  // here — by suppressing the spa rule only, so a bad --port or --root in the
  // same call is still caught, and so the conf's own root is never run through
  // ROOT_RE and refused with a message about a flag that was not given.
  const inheritsRoot = verb === 'add' && parsed.values.spa
    && parsed.values.root === undefined && parsed.values.port === undefined && repo.domainRoot;
  const bad = checkTarget(inheritsRoot ? { ...parsed.values, spa: false } : parsed.values);
  if (bad) { stderr.write(`${bad}\n`); return 2; }

  try { await takeLock(p.domainLock, `domain ${verb}`); }
  catch (e) { stderr.write(`${e.message}\n`); return 1; }
  try {
    return verb === 'add'
      ? await add(p, name, repo, hosts, parsed.values, { stdout, stderr, exec })
      : await removeHosts(p, name, repo, hosts, { stdout, stderr, exec });
  } finally {
    await releaseLock(p.domainLock);
  }
}

async function add(p, name, repo, hosts, flags, { stdout, stderr, exec }) {
  const main = await loadMain(p).catch(() => ({ publicHost: null }));
  // Both sides lowercased: install.sh accepts --host App.Example.com and writes
  // it through unchanged, so a case-different spelling would otherwise walk past
  // this and land on `caddy validate` — which catches it, but with a parser
  // error instead of the sentence this refusal exists to print.
  const webhook = (main.publicHost ?? '').toLowerCase();
  for (const h of hosts) {
    if (h === webhook) {
      stderr.write(`${h} is the webhook's own hostname. Two site blocks for one address is an "ambiguous site definition": caddy refuses the whole config, the running server keeps the one it has, and the next restart comes up with no caddy at all. Give the site its own name\n`);
      return 1;
    }
  }
  // Best-effort by construction: loadRepos never throws for one bad conf, and
  // `caddy validate` is the backstop that cannot be skipped.
  const { repos, errors } = await loadRepos(p);
  for (const e of errors) stderr.write(`warning: skipped ${e.name} while checking hostnames: ${e.error.message}\n`);
  for (const other of repos) {
    if (other.name === name) continue;
    for (const h of hosts) if (other.domain.includes(h)) { stderr.write(`${h} is already served for ${other.name}\n`); return 1; }
  }

  const merged = [...repo.domain];
  let added = 0;
  for (const h of hosts) if (!merged.includes(h)) { merged.push(h); added++; }
  if (!merged.length) { stderr.write(`${name} has no hostnames; give one\n`); return 2; }

  const retarget = flags.port !== undefined || flags.root !== undefined;
  const port = retarget ? (flags.port ?? null) : repo.domainPort;
  const root = retarget ? (flags.root ?? null) : repo.domainRoot;
  // Without a retarget, `--spa` turns SPA on for the root the repo already
  // has — there is nothing else it could mean, and silently dropping it would
  // report success for a change that never happened.
  const spa = retarget ? Boolean(flags.spa) : (flags.spa ? true : repo.domainSpa);
  if (!port && !root) { stderr.write(`${name} has no target yet: give --port N or --root DIR\n`); return 2; }

  const site = await mySite(p, name, stderr);
  if (!site) return 1;
  // Before anything is written, and only once the site file is known to be
  // ours: bootstrap appends to the Caddyfile, and a refusal must leave it alone.
  if (!(await bootstrap(p, stderr))) return 1;

  const code = await applyChange(p, name, new Map([
    ['DOMAIN', merged.join(' ')],
    ['DOMAIN_PORT', port ? String(port) : null],
    ['DOMAIN_ROOT', root ?? null],
    ['DOMAIN_SPA', spa ? 'yes' : null],
  ]), site, exec, { stderr });
  if (code) return code;
  const changed = added || retarget || spa !== repo.domainSpa;
  stdout.write(`${name}: ${merged.join(' ')} -> ${port ? `127.0.0.1:${port}` : root}${spa ? ' (spa)' : ''}${changed ? '' : '  (unchanged)'}\n`);
  return 0;
}

async function removeHosts(p, name, repo, hosts, { stdout, stderr, exec }) {
  // No hostnames means all of them: this is the cleanup verb, and it is what
  // `flipd remove` calls.
  const going = hosts.length ? hosts : repo.domain;
  const left = repo.domain.filter((h) => !going.includes(h));
  const site = await mySite(p, name, stderr);
  if (!site) return 1;

  const clearing = left.length === 0;
  const code = await applyChange(p, name, new Map([
    ['DOMAIN', clearing ? null : left.join(' ')],
    ...(clearing ? [['DOMAIN_PORT', null], ['DOMAIN_ROOT', null], ['DOMAIN_SPA', null]] : []),
  ]), site, exec, { stderr });
  if (code) return code;
  // Only claim the file was removed when there was one: a repo with no DOMAIN
  // at all takes this path too, and "removed <path>" about a file that never
  // existed sends an operator looking for what deleted it.
  stdout.write(left.length
    ? `${name}: ${left.join(' ')}\n`
    : `${name}: no hostnames left${site.exists ? `; removed ${p.caddySite(name)}` : ''}\n`);
  return 0;
}

// Is this repo's site file ours to write? Anything whose first line is not the
// marker is someone else's; the refusal lives here so `add` and `remove` cannot
// drift on what they say about it. Returns null once it has said so.
async function mySite(p, name, stderr) {
  const site = await ours(p.caddySite(name));
  if (site.mine) return site;
  stderr.write(`${p.caddySite(name)} is not managed by flipd (no "${MARKER}" first line); move it aside first\n`);
  return null;
}

// The write both verbs make: edit the conf's DOMAIN* keys, re-render, validate
// and reload — and on a caddy failure put both files back as `site` found them.
// One copy, because the rollback is correctness-bearing: each restore in its own
// try/catch, so a restore that itself fails (ENOSPC, EROFS, EACCES) does not
// skip the other one and is not swallowed — the operator is then looking at a
// command that reported failure while some of what it changed is still in
// place, which is exactly the disk/running-config divergence the lock exists to
// prevent. Site file first: it is the file Caddy reads, and it is what a failed
// reload leaves stale on disk.
async function applyChange(p, name, changes, site, exec, { stderr }) {
  const confBefore = await fs.readFile(p.repoConf(name), 'utf8');
  const { text } = editKV(confBefore, changes);
  await writeAtomic(p.repoConf(name), text);
  try {
    await applySite(p, name, exec);
  } catch (e) {
    const restoreNotes = [];
    try {
      if (site.exists) { await fs.writeFile(p.caddySite(name), site.text); await fs.chmod(p.caddySite(name), 0o644); }
      else await fs.rm(p.caddySite(name), { force: true });
    } catch (e2) { restoreNotes.push(`could not restore ${p.caddySite(name)}: ${e2.message}`); }
    try { await writeAtomic(p.repoConf(name), confBefore); }
    catch (e2) { restoreNotes.push(`could not restore ${p.repoConf(name)}: ${e2.message}`); }
    const noteLines = restoreNotes.map((n) => `${n}\n`).join('');
    stderr.write(`${e.stderr?.trim() || e.message}\n${noteLines}${restoreNotes.length ? '' : 'nothing was changed. '}If caddy validated and the reload failed, check journalctl -u caddy\n`);
    return 1;
  }
  return 0;
}

// The configured state — the conf — not the rendered file, because the conf is
// the record. Where the two disagree the row says so: a row claiming a hostname
// nothing serves is the failure this whole feature is about.
async function list(args, { paths: p, stdout, stderr }) {
  const only = args[0];
  const { repos, errors } = await loadRepos(p);
  for (const e of errors) stderr.write(`warning: skipped ${e.name}: ${e.error.message}\n`);
  const rows = [];
  for (const r of repos) {
    if (only && r.name !== only) continue;
    if (!r.domain.length) continue;
    const target = r.domainPort ? `127.0.0.1:${r.domainPort}` : `${r.domainRoot}${r.domainSpa ? ' (spa)' : ''}`;
    const served = await fs.stat(p.caddySite(r.name)).then(() => true, () => false);
    rows.push([r.name, r.domain.join(' '), target, served ? '' : 'no site file']);
  }
  const w = (i) => Math.max(...rows.map((r) => r[i].length), 1);
  for (const r of rows) stdout.write(`${r[0].padEnd(w(0))}  ${r[1].padEnd(w(1))}  ${r[2]}${r[3] ? `  ${r[3]}` : ''}\n`);
  return 0;
}

// What `flipd remove` calls once the conf is gone. Returns true when it deleted
// something, so the caller knows whether a reload was needed at all.
export async function removeSite(p, name, exec, { stderr }) {
  const site = await ours(p.caddySite(name));
  if (!site.exists) return false;
  if (!site.mine) { stderr.write(`left ${p.caddySite(name)} alone: it is not managed by flipd\n`); return false; }
  await fs.rm(p.caddySite(name), { force: true });
  await exec('caddy', ['validate', '--config', p.caddyMain]);
  await exec('systemctl', ['reload', 'caddy']);
  return true;
}
