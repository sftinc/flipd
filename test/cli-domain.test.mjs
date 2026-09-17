import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderSite, MARKER, takeLock, releaseLock } from '../lib/cli/domain.mjs';

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
