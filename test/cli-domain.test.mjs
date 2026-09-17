import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderSite, MARKER, takeLock, releaseLock, checkTarget, checkHostArg } from '../lib/cli/domain.mjs';

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'flipd-domain-'));
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
