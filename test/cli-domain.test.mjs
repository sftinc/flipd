import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderSite, MARKER, takeLock, releaseLock, checkTarget, checkHostArg } from '../lib/cli/domain.mjs';
import domain from '../lib/cli/domain.mjs';
import { paths } from '../lib/paths.mjs';
import { loadRepo } from '../lib/config.mjs';

const runReal = promisify(execFile);
// Worked out once at module load, not inside the test body, so `skip` gets a
// plain boolean/string rather than a promise.
const caddyOnPath = await runReal('sh', ['-c', 'command -v caddy || true'])
  .then(({ stdout }) => Boolean(stdout.trim()))
  .catch(() => false);

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'flipd-domain-'));
}

// A prefix with /etc/flipd/repos/<name>.conf, /etc/caddy/Caddyfile, and
// optionally conf.d. Returns the paths object plus a recorder for the commands
// the command would have run.
async function box({ confs = { app: 'REPO=git@h:o/r.git\nBRANCH=main\n#BUILD=npm ci\nBUILD=x\nDEPLOY=y\n' }, main = 'PUBLIC_HOST=deploy.example.com\nWEBHOOK_SECRET=s\n', caddyfile = 'localhost:80 {\n}\n', confd = null, fail = null } = {}) {
  const prefix = await tmpdir();
  const p = paths(prefix);
  await fs.mkdir(p.reposDir, { recursive: true });
  await fs.mkdir(path.dirname(p.caddyMain), { recursive: true });
  await fs.writeFile(p.mainConf, main);
  if (caddyfile !== null) await fs.writeFile(p.caddyMain, caddyfile);
  for (const [n, text] of Object.entries(confs)) await fs.writeFile(p.repoConf(n), text);
  if (confd) { await fs.mkdir(p.caddyDir, { recursive: true }); for (const [f, t] of Object.entries(confd)) await fs.writeFile(path.join(p.caddyDir, f), t); }
  const ran = [];
  const runOverride = async (cmd, argv) => {
    ran.push([cmd, ...argv].join(' '));
    if (fail && `${cmd} ${argv[0]}`.startsWith(fail)) throw Object.assign(new Error('boom'), { stderr: 'caddy said no' });
    return { stdout: '', stderr: '' };
  };
  const out = { stdout: '', stderr: '' };
  const io = { paths: p, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } }, runOverride };
  return { p, io, out, ran, prefix };
}

test('a port site renders a reverse_proxy block with every host on one line', () => {
  assert.equal(renderSite({ hosts: ['app.example.com', 'www.example.com'], port: '3000' }), `${MARKER} — edits are lost on the next \`flipd domain\` command
app.example.com, www.example.com {
    log {
        output stderr
    }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
`);
});

test('a root site renders file_server, and --spa adds the try_files fallback', () => {
  const plain = renderSite({ hosts: ['a.example.com'], root: '/var/www/app' });
  assert.match(plain, /^    root \* \/var\/www\/app$/m);
  assert.match(plain, /^    file_server$/m);
  assert.doesNotMatch(plain, /try_files/);
  assert.doesNotMatch(plain, /handle/);

  const spa = renderSite({ hosts: ['a.example.com'], root: '/var/www/app', spa: true });
  assert.match(spa, /^    handle \{\n        try_files \{path\} \/index\.html\n        file_server\n    \}$/m);
});

test('every rendered file starts with the marker', () => {
  for (const s of [renderSite({ hosts: ['a.example.com'], port: '80' }), renderSite({ hosts: ['a.example.com'], root: '/x' })]) {
    assert.ok(s.startsWith(MARKER));
  }
});

test('the lock is taken, refuses a second live holder, and is released', async () => {
  const lock = path.join(await tmpdir(), 'domain.lock');
  await takeLock(lock, 'domain add');
  await assert.rejects(takeLock(lock, 'domain remove'), (e) => {
    assert.equal(e.code, 'ELOCKED');
    assert.match(e.message, new RegExp(String(process.pid)));   // names the holder
    assert.match(e.message, /domain add/);                       // and what it is doing
    assert.match(e.message, new RegExp(lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  await releaseLock(lock);
  await takeLock(lock, 'domain add');                            // free again
  await releaseLock(lock);
});

// A SIGKILLed command must not block `flipd remove` — the command an operator
// reaches for when they are already cleaning up a mess.
test('a lock whose holder is gone is stolen, not obeyed', async () => {
  const lock = path.join(await tmpdir(), 'domain.lock');
  await fs.writeFile(lock, '999999\ndomain add\n2026-09-17T00:00:00.000Z\n');
  await takeLock(lock, 'flipd remove');
  assert.match(await fs.readFile(lock, 'utf8'), new RegExp(`^${process.pid}\\n`));
  await releaseLock(lock);
});

test('a corrupt lock file is stolen rather than jamming the command forever', async () => {
  const lock = path.join(await tmpdir(), 'domain.lock');
  await fs.writeFile(lock, 'not a pid at all\n');
  await takeLock(lock, 'domain add');
  await releaseLock(lock);
});

test('releasing a lock that is not there is not an error', async () => {
  await releaseLock(path.join(await tmpdir(), 'nope.lock'));
});

test('a port must be a whole number in range', () => {
  assert.equal(checkTarget({ port: '3000' }), null);
  for (const port of ['0', '65536', '-1', '3000x', '', 'http']) {
    assert.match(checkTarget({ port }), /--port/);
  }
});

// The real hazard is not a broken Caddy directive. DOMAIN_ROOT is written into
// the repo conf, and parseKV is line-oriented: a newline splits the line, the
// next parse throws, and the service skips that repo on every event afterwards.
test('a root must be absolute and free of anything but path characters', () => {
  assert.equal(checkTarget({ root: '/var/www/app-1.0_x' }), null);
  for (const root of ['relative/path', '/var/www/a b', '/var/www/a\nDEPLOY=rm -rf /', '/var/www/a\rb', '/var/www/a"b', '/var/www/a`b', '/var/www/a{b', '/var/www/a#b', '/var/www/a\\b']) {
    assert.match(checkTarget({ root }), /--root/, `should refuse ${JSON.stringify(root)}`);
  }
});

test('a refusal never echoes the value it rejected', () => {
  assert.doesNotMatch(checkTarget({ root: '/var/www/SECRETVALUE b' }), /SECRETVALUE/);
});

// Otherwise valid content with nothing wrong but a trailing newline: locks
// down ROOT_RE's `$` boundary against an `m` flag creeping in later.
test('a trailing newline on an otherwise valid root is still refused', () => {
  assert.match(checkTarget({ root: '/var/www/app\n' }), /--root/);
});

test('the target flags are mutually exclusive, and --spa needs --root', () => {
  assert.match(checkTarget({ port: '3000', root: '/x' }), /--port|--root/);
  assert.match(checkTarget({ port: '3000', spa: true }), /--spa/);
  assert.equal(checkTarget({ root: '/x', spa: true }), null);
});

test('a host is lowercased and held to a hostname shape', () => {
  assert.equal(checkHostArg('App.Example.COM'), 'app.example.com');
  for (const h of ['not a host', 'a..b', '-lead.example.com', 'x/y', '']) {
    assert.throws(() => checkHostArg(h), { code: 'EBADHOST' });
  }
});

// checkHost's own thrown message interpolates the value, and the host
// position can be a wrapped paste of a secret — checkHostArg must not let
// that message reach a terminal or journald.
test('a bad host refusal never echoes the value it rejected', () => {
  assert.throws(() => checkHostArg('SECRETVALUE not a host'), (e) => {
    assert.equal(e.code, 'EBADHOST');
    assert.doesNotMatch(e.message, /SECRETVALUE/);
    return true;
  });
});

test('add writes the conf keys and the site file, then validates and reloads', async () => {
  const { p, io, out, ran } = await box();
  assert.equal(await domain(['add', 'app', 'App.Example.com', '--port', '3000'], io), 0);
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.match(conf, /^DOMAIN=app\.example\.com$/m);       // lowercased
  assert.match(conf, /^DOMAIN_PORT=3000$/m);
  assert.match(conf, /^#BUILD=npm ci$/m);                  // comments survive
  const site = await fs.readFile(p.caddySite('app'), 'utf8');
  assert.match(site, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.equal((await fs.stat(p.caddySite('app'))).mode & 0o777, 0o644);
  assert.deepEqual(ran, [`caddy validate --config ${p.caddyMain}`, 'systemctl reload caddy']);
  assert.match(out.stdout, /app\.example\.com/);
});

test('a second add puts both hosts on one block, in order', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  assert.equal(await domain(['add', 'app', 'b.example.com'], io), 0);
  assert.match(await fs.readFile(p.repoConf('app'), 'utf8'), /^DOMAIN=a\.example\.com b\.example\.com$/m);
  assert.match(await fs.readFile(p.caddySite('app'), 'utf8'), /^a\.example\.com, b\.example\.com \{$/m);
});

test('re-adding a host is success and reports no change; a repeat in one call lands once', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  assert.equal(await domain(['add', 'app', 'a.example.com'], io), 0);
  assert.match(out.stdout, /unchanged/i);
  await domain(['add', 'app', 'c.example.com', 'c.example.com'], io);
  assert.match(await fs.readFile(p.repoConf('app'), 'utf8'), /^DOMAIN=a\.example\.com c\.example\.com$/m);
});

test('a new target retargets the whole site', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  await domain(['add', 'app', '--root', '/var/www/app', '--spa'], io);
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.doesNotMatch(conf, /^DOMAIN_PORT=/m);
  assert.match(conf, /^DOMAIN_ROOT=\/var\/www\/app$/m);
  assert.match(conf, /^DOMAIN_SPA=yes$/m);
  assert.match(await fs.readFile(p.caddySite('app'), 'utf8'), /try_files/);
});

test('conf.d and the import line are created when missing, and never duplicated', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  const first = await fs.readFile(p.caddyMain, 'utf8');
  assert.match(first, new RegExp(`^import ${p.caddyDir}/\\*$`, 'm'));
  await domain(['add', 'app', 'b.example.com'], io);
  assert.equal(await fs.readFile(p.caddyMain, 'utf8'), first);
  assert.equal((first.match(/^import /gm) || []).length, 1);
});

test('an import line the installer already wrote is recognised and not added again', async () => {
  const { p, io } = await box({ caddyfile: 'import /etc/caddy/conf.d/*\n' });
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  assert.equal(await fs.readFile(p.caddyMain, 'utf8'), 'import /etc/caddy/conf.d/*\n');
});

test('refuses the webhook hostname whatever its case, naming the trap', async () => {
  const { io, out } = await box({ main: 'PUBLIC_HOST=Deploy.Example.com\nWEBHOOK_SECRET=s\n' });
  assert.equal(await domain(['add', 'app', 'deploy.example.com', '--port', '3000'], io), 1);
  assert.match(out.stderr, /ambiguous site definition/);
});

test('refuses a host another repo already claims, naming that repo', async () => {
  const { io, out } = await box({ confs: {
    app: 'REPO=git@h:o/r.git\nBUILD=x\nDEPLOY=y\n',
    docs: 'REPO=git@h:o/d.git\nBUILD=x\nDEPLOY=y\nDOMAIN=shared.example.com\nDOMAIN_PORT=4000\n',
  } });
  assert.equal(await domain(['add', 'app', 'shared.example.com', '--port', '3000'], io), 1);
  assert.match(out.stderr, /docs/);
});

test('a repo conf that will not parse is skipped and named, not fatal', async () => {
  const { p, io, out } = await box({ confs: {
    app: 'REPO=git@h:o/r.git\nBUILD=x\nDEPLOY=y\n',
    broken: 'this line has no equals sign\n',
  } });
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 0);
  assert.match(out.stderr, /broken/);
  const site = await fs.readFile(p.caddySite('app'), 'utf8');
  assert.match(site, /^a\.example\.com \{$/m);
  assert.match(site, /reverse_proxy 127\.0\.0\.1:3000/);
});

test('refuses a nonempty conf.d that nothing imports', async () => {
  const { io, out } = await box({ confd: { 'someone-elses.caddy': 'x.example.com {\n}\n' } });
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.match(out.stderr, /1 file/);
  assert.doesNotMatch(out.stderr, /someone-elses/);   // filenames can carry control characters
  assert.doesNotMatch(out.stderr, /install\.sh/);      // that only moves the surprise
});

test('refuses when there is no Caddyfile at all', async () => {
  const { io, out } = await box({ caddyfile: null });
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.match(out.stderr, /install\.sh --host/);
});

test('refuses an unknown repo, and a repo with no target yet and no flag', async () => {
  const a = await box();
  assert.equal(await domain(['add', 'nope', 'a.example.com', '--port', '3000'], a.io), 1);
  const b = await box();
  assert.equal(await domain(['add', 'app', 'a.example.com'], b.io), 2);
  assert.match(b.out.stderr, /--port|--root/);
});

test('refuses to write over a conf.d file that is not flipd\'s', async () => {
  const { p, io, out } = await box();
  await fs.mkdir(p.caddyDir, { recursive: true });
  await fs.writeFile(p.caddyMain, `import ${p.caddyDir}/*\n`);
  await fs.writeFile(p.caddySite('app'), 'hand written\n');
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.equal(await fs.readFile(p.caddySite('app'), 'utf8'), 'hand written\n');
  assert.match(out.stderr, /not managed by flipd/);
});

test('a failing validate puts both files back exactly as they were', async () => {
  const { p, io, out, ran } = await box({ fail: 'caddy validate' });
  const before = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), before);
  await assert.rejects(fs.stat(p.caddySite('app')));        // did not exist before, does not now
  assert.ok(!ran.includes('systemctl reload caddy'));       // no reload was owed
  assert.match(out.stderr, /caddy said no/);                // caddy's own words are relayed
});

test('a failing validate restores a site file that did exist, byte for byte', async () => {
  const good = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], good.io);
  const site = await fs.readFile(good.p.caddySite('app'), 'utf8');
  const conf = await fs.readFile(good.p.repoConf('app'), 'utf8');
  good.io.runOverride = async (cmd, argv) => { if (cmd === 'caddy') throw Object.assign(new Error('boom'), { stderr: 'nope' }); return {}; };
  assert.equal(await domain(['add', 'app', 'b.example.com'], good.io), 1);
  assert.equal(await fs.readFile(good.p.caddySite('app'), 'utf8'), site);
  assert.equal(await fs.readFile(good.p.repoConf('app'), 'utf8'), conf);
});

test('a failing reload restores the same way and says where to look', async () => {
  const { p, io, out } = await box({ fail: 'systemctl reload' });
  const before = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), before);
  assert.match(out.stderr, /journalctl -u caddy/);
});

test('the lock is gone after a success and after a failure', async () => {
  const ok = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], ok.io);
  await assert.rejects(fs.stat(ok.p.domainLock));
  const bad = await box({ fail: 'caddy validate' });
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], bad.io);
  await assert.rejects(fs.stat(bad.p.domainLock));
});

test('a live lock refuses the command', async () => {
  const { p, io, out } = await box();
  await fs.mkdir(p.etc, { recursive: true });
  await takeLock(p.domainLock, 'domain add');
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.match(out.stderr, /another flipd command/);
  await releaseLock(p.domainLock);
});

// C1 regression: install.sh's own activation check is line-anchored
// (`^\s*import\s+(/etc/caddy/)?conf\.d/\*`), so a commented-out copy of that
// line reads as "not imported" to install.sh too. hasImport must agree, or a
// Caddyfile with the import commented out (staged, or half-undone by hand)
// would see `add` report success while the site file it just wrote is never
// picked up by Caddy at all. The unanchored substring check this replaces
// would find "<caddyDir>/*" inside the commented line too and wrongly treat
// it as already imported — reproduced here against this fixture's own
// caddyDir, not the installer's literal /etc/caddy path, which is what made
// the old check pass under this test's tmp-prefixed paths in the first place.
test('a commented-out import line does not count; a real one is appended and the site is live', async () => {
  const { p, io } = await box();
  await fs.writeFile(p.caddyMain, `# import ${p.caddyDir}/*   (not enabled yet)\n`);
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 0);
  const main = await fs.readFile(p.caddyMain, 'utf8');
  assert.match(main, new RegExp(`^import ${p.caddyDir}/\\*$`, 'm'));                          // the real import got added
  assert.match(main, new RegExp(`^# import ${p.caddyDir}/\\*   \\(not enabled yet\\)$`, 'm')); // the comment is untouched
  assert.ok(await fs.readFile(p.caddySite('app'), 'utf8'));
});

test('a pure retarget is a real change and must not print "unchanged"', async () => {
  const { io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  out.stdout = '';
  assert.equal(await domain(['add', 'app', '--root', '/var/www/app', '--spa'], io), 0);
  assert.doesNotMatch(out.stdout, /unchanged/i);
});

test('a repo conf that exists but carries an unknown key gets its parse error relayed, not "no repo named"', async () => {
  const { io, out } = await box({ confs: { app: 'REPO=git@h:o/r.git\nBUILD=x\nDEPLOY=y\nBOGUS=1\n' } });
  assert.equal(await domain(['add', 'app', 'a.example.com', '--port', '3000'], io), 1);
  assert.doesNotMatch(out.stderr, /no repo named/);
  assert.match(out.stderr, /unknown key/);
});

test('removing one host re-renders without it', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', 'b.example.com', '--port', '3000'], io);
  assert.equal(await domain(['remove', 'app', 'a.example.com'], io), 0);
  assert.match(await fs.readFile(p.repoConf('app'), 'utf8'), /^DOMAIN=b\.example\.com$/m);
  assert.match(await fs.readFile(p.caddySite('app'), 'utf8'), /^b\.example\.com \{$/m);
});

test('removing the last host deletes the file and clears every DOMAIN key', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', '--root', '/var/www/app', '--spa'], io);
  assert.equal(await domain(['remove', 'app', 'a.example.com'], io), 0);
  await assert.rejects(fs.stat(p.caddySite('app')));
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  for (const k of ['DOMAIN', 'DOMAIN_PORT', 'DOMAIN_ROOT', 'DOMAIN_SPA']) {
    assert.doesNotMatch(conf, new RegExp(`^${k}=`, 'm'));
  }
  assert.match(conf, /^BUILD=x$/m);   // the rest of the conf is untouched
});

test('remove with no hostnames removes them all', async () => {
  const { p, io } = await box();
  await domain(['add', 'app', 'a.example.com', 'b.example.com', '--port', '3000'], io);
  assert.equal(await domain(['remove', 'app'], io), 0);
  await assert.rejects(fs.stat(p.caddySite('app')));
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  for (const k of ['DOMAIN', 'DOMAIN_PORT', 'DOMAIN_ROOT', 'DOMAIN_SPA']) {
    assert.doesNotMatch(conf, new RegExp(`^${k}=`, 'm'));
  }
});

// `remove`'s rollback is the half nothing covered: `add`'s failure path only
// ever has to *delete* a file it created, while a failed remove-all has to put
// a deleted site file back — same bytes, same 0644, or caddy is left serving a
// config that is no longer on disk.
test('a failing validate during a remove restores the conf and recreates the site file', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', 'b.example.com', '--port', '3000'], io);
  const site = await fs.readFile(p.caddySite('app'), 'utf8');
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  out.stderr = '';
  const ran = [];
  io.runOverride = async (cmd, argv) => {
    ran.push([cmd, ...argv].join(' '));
    if (cmd === 'caddy') throw Object.assign(new Error('boom'), { stderr: 'caddy said no' });
    return {};
  };
  assert.equal(await domain(['remove', 'app'], io), 1);
  assert.equal(await fs.readFile(p.caddySite('app'), 'utf8'), site);          // recreated, byte for byte
  assert.equal((await fs.stat(p.caddySite('app'))).mode & 0o777, 0o644);      // and readable by caddy's own user
  assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), conf);           // DOMAIN* keys all back
  assert.ok(!ran.includes('systemctl reload caddy'));                          // no reload was owed
  assert.match(out.stderr, /caddy said no/);
  await assert.rejects(fs.stat(p.domainLock));                                 // and the lock is released
});

// The flag exists to stop a newline splitting the conf line: DOMAIN_ROOT is
// written into the repo conf, and a broken conf means the service skips this
// repo on every push afterwards. checkTarget is unit-tested; this pins the
// whole path, including that the conf still parses.
test('a --root carrying a newline is refused before anything is written, and the conf still parses', async () => {
  const { p, io, out, ran } = await box();
  const before = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.equal(await domain(['add', 'app', 'h.example.com', '--root', '/var/www/a\nDEPLOY=rm -rf /'], io), 2);
  assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), before);   // byte-unchanged
  assert.deepEqual(ran, []);                                           // caddy was never asked
  await assert.rejects(fs.stat(p.caddySite('app')));
  const repo = await loadRepo(p, 'app');                               // and it still parses
  assert.equal(repo.deploy, 'y');
  assert.deepEqual(repo.domain, []);
  assert.doesNotMatch(out.stderr, /rm -rf/);                           // the value is never echoed
});

test('a live lock refuses domain remove too, and touches nothing', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  const site = await fs.readFile(p.caddySite('app'), 'utf8');
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  out.stderr = '';
  await takeLock(p.domainLock, 'flipd remove');
  assert.equal(await domain(['remove', 'app'], io), 1);
  assert.match(out.stderr, /another flipd command/);
  assert.equal(await fs.readFile(p.caddySite('app'), 'utf8'), site);
  assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), conf);
  await releaseLock(p.domainLock);
});

// `--port` on a remove used to validate, then be dropped: the empty host list
// read as "remove all", so a flag written to *scope* a removal took the whole
// site offline and exited 0.
test('remove refuses a target flag rather than reading it as "remove everything"', async () => {
  const { p, io, out, ran } = await box();
  await domain(['add', 'app', 'a.example.com', 'b.example.com', '--port', '3000'], io);
  const site = await fs.readFile(p.caddySite('app'), 'utf8');
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  out.stderr = '';
  for (const flags of [['--port', '3000'], ['--root', '/var/www/app'], ['--spa']]) {
    assert.equal(await domain(['remove', 'app', ...flags], io), 2, flags.join(' '));
    assert.match(out.stderr, /hostnames only/);
    assert.equal(await fs.readFile(p.caddySite('app'), 'utf8'), site);
    assert.equal(await fs.readFile(p.repoConf('app'), 'utf8'), conf);
  }
  assert.deepEqual(ran, [`caddy validate --config ${p.caddyMain}`, 'systemctl reload caddy']);   // the add's, and nothing since
});

// Nothing was removed, so nothing may be claimed to have been: a repo with no
// DOMAIN at all takes the remove-all path too.
test('remove on a repo with no hostnames does not claim it deleted a site file', async () => {
  const { p, io, out } = await box();
  assert.equal(await domain(['remove', 'app'], io), 0);
  assert.doesNotMatch(out.stdout, /removed/);
  assert.doesNotMatch(out.stdout, new RegExp(p.caddySite('app').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// The repo has a root; refusing with "--spa needs --root" would be a lie about
// why. checkTarget cannot see the repo, so `add` has to decide this one.
test('--spa alone turns SPA on for the root the repo already has', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--root', '/var/www/app'], io);
  out.stdout = '';
  assert.equal(await domain(['add', 'app', 'b.example.com', '--spa'], io), 0);
  const conf = await fs.readFile(p.repoConf('app'), 'utf8');
  assert.match(conf, /^DOMAIN_SPA=yes$/m);
  assert.match(conf, /^DOMAIN_ROOT=\/var\/www\/app$/m);   // the root it had, not one it lost
  assert.match(conf, /^DOMAIN=a\.example\.com b\.example\.com$/m);
  assert.match(await fs.readFile(p.caddySite('app'), 'utf8'), /try_files/);
  assert.doesNotMatch(out.stdout, /unchanged/i);
  // …and on a repo whose target is a port there is no root to turn it on for.
  const port = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], port.io);
  assert.equal(await domain(['add', 'app', '--spa'], port.io), 2);
  assert.match(port.out.stderr, /--spa/);
});

// parseArgs' own message quotes the offending token back verbatim, and argv is
// exactly where a botched paste of a secret lands — lib/cli/env.mjs refuses to
// echo a stray argument for the same reason.
test('an unknown option is named as one, never quoted back', async () => {
  const { io, out } = await box();
  assert.equal(await domain(['add', 'app', '--SECRETVALUEpasted'], io), 2);
  assert.doesNotMatch(out.stderr, /SECRETVALUE/);
  assert.match(out.stderr, /unknown option/);
  assert.match(out.stderr, /usage: flipd domain add/);
});

test('remove refuses a site file that is not flipd\'s', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  await fs.writeFile(p.caddySite('app'), 'hand written\n');
  assert.equal(await domain(['remove', 'app'], io), 1);
  assert.equal(await fs.readFile(p.caddySite('app'), 'utf8'), 'hand written\n');
});

test('list prints the configured state, one row per repo that has one', async () => {
  const { io, out } = await box({ confs: {
    app: 'REPO=git@h:o/r.git\nBUILD=x\nDEPLOY=y\n',
    docs: 'REPO=git@h:o/d.git\nBUILD=x\nDEPLOY=y\nDOMAIN=d.example.com\nDOMAIN_ROOT=/var/www/d\nDOMAIN_SPA=yes\n',
    none: 'REPO=git@h:o/n.git\nBUILD=x\nDEPLOY=y\n',
  } });
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  out.stdout = '';
  assert.equal(await domain(['list'], io), 0);
  assert.match(out.stdout, /app\s+a\.example\.com\s+127\.0\.0\.1:3000/);
  assert.match(out.stdout, /docs\s+d\.example\.com\s+\/var\/www\/d \(spa\)/);
  assert.doesNotMatch(out.stdout, /none/);
});

// A row claiming a hostname nothing serves is the failure this feature exists
// to remove, so it must never be printed as if it were fine.
test('list marks a row whose site file has gone missing', async () => {
  const { p, io, out } = await box();
  await domain(['add', 'app', 'a.example.com', '--port', '3000'], io);
  await fs.rm(p.caddySite('app'));
  out.stdout = '';
  await domain(['list'], io);
  assert.match(out.stdout, /no site file/);
});

test('list needs no lock and no caddy', async () => {
  const { p, io, ran } = await box({ caddyfile: null });
  await takeLock(p.domainLock, 'domain add');
  assert.equal(await domain(['list'], io), 0);
  assert.deepEqual(ran, []);   // no caddy validate, no systemctl reload — no external process at all
  await releaseLock(p.domainLock);
});

// /etc/caddy/Caddyfile is a dpkg conffile; writeAtomic renames a new file into
// place, which would replace its inode, mode and owner and leave Caddy unable
// to read its own config. Pinned at the source, the way test/install.test.mjs
// pins invariants about install.sh: a later refactor that reaches for
// writeAtomic near caddyMain "for consistency" must fail this test, not ship.
test('the source never lets writeAtomic touch the Caddyfile', async () => {
  const src = await fs.readFile(new URL('../lib/cli/domain.mjs', import.meta.url), 'utf8');
  const bad = src.split('\n').filter((l) => l.includes('writeAtomic') && l.includes('caddyMain'));
  assert.deepEqual(bad, []);
});

// The one test in this file that runs the real caddy. It pins the fact the
// bootstrap's design rests on: a failed `domain add` may leave behind a
// conf.d it created and the import line pointing at it, and that empty
// directory must not stop caddy loading its own config. An override cannot
// establish this — it can only record what would have been run, never what
// caddy actually does with it.
//
// SKIPPING THIS TEST IS NOT PASSING IT. A skip means the environment has no
// caddy to check against, so the empty-import-glob claim above is simply
// unverified here — not confirmed. A green suite on a laptop without caddy
// proves nothing about this specific behaviour; only a run where this test
// actually executes (e.g. CI, with caddy on PATH) does.
test('an import glob that matches no files is not an error to caddy', { skip: !caddyOnPath && 'caddy is not installed (not on PATH)' }, async () => {
  const dir = await tmpdir();
  const confd = path.join(dir, 'conf.d');
  await fs.mkdir(confd);
  const main = path.join(dir, 'Caddyfile');
  // Binds nothing meaningful — caddy validate parses and adapts the config,
  // it does not start a server or bind a port.
  await fs.writeFile(main, `localhost:8080 {\n    respond 200\n}\n\nimport ${confd}/*\n`);
  // Asserts the exit status, not the warning text: the status is the
  // interface flipd's rollback design depends on, the wording is not.
  await runReal('caddy', ['validate', '--config', main]);
});
