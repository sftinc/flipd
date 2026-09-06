import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { makePrefix } from './helpers.mjs';
import account, { fingerprint } from '../lib/cli/account.mjs';

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}
const piped = (s) => Readable.from([s]);
const FAKE_KEY = Buffer.from('not a real key, but base64 is base64').toString('base64');

test('fingerprint: SHA256 of the decoded blob, base64 without padding, prefixed by the key type', () => {
  // ssh-keygen -lf prints "256 SHA256:<hash> host (ED25519)"; we print the type
  // and the same hash, which is what the forge's own page shows.
  const line = `forge.example.com ssh-ed25519 ${FAKE_KEY}`;
  assert.match(fingerprint(line), /^ssh-ed25519 SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(fingerprint(`[h]:2222 ssh-ed25519 ${FAKE_KEY}`), fingerprint(line), 'the host field does not enter the hash');
});

test('account add: writes a root-only conf from a piped token, records the host key once, prints fingerprints and never the token', async () => {
  const p = await makePrefix();
  const calls = [];
  const keyscan = async (host, port) => { calls.push([host, port]); return [`[forge.example.com]:2222 ssh-ed25519 ${FAKE_KEY}`]; };
  const o = io();
  assert.equal(await account(['add', 'Forge.Example.com', '--kind', 'forgejo', '--ssh-port', '2222'], { paths: p, ...o, stdin: piped('tok_ABC123\n'), keyscanOverride: keyscan }), 0);
  const conf = p.accountConf('forge.example.com');
  assert.equal((await fs.stat(conf)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(p.accountsDir)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(conf, 'utf8'), 'KIND=forgejo\nTOKEN=tok_ABC123\n', 'one trailing newline trimmed; no API line when defaulted');
  assert.deepEqual(calls, [['forge.example.com', 2222]]);
  const count = async () => (await fs.readFile(p.knownHosts, 'utf8')).split('\n').filter((l) => l.startsWith('[forge.example.com]:2222 ')).length;
  assert.equal(await count(), 1);
  assert.match(o.out(), /ssh-ed25519 SHA256:/);
  assert.match(o.out(), /compare/i);
  assert.ok(!o.out().includes('tok_ABC123') && !o.err().includes('tok_ABC123'));
  // twice is refused before anything is read or scanned
  assert.equal(await account(['add', 'forge.example.com', '--kind', 'forgejo'], { paths: p, ...io(), stdin: piped('x'), keyscanOverride: keyscan }), 1);
  assert.equal(calls.length, 1);
  // remove, then add again: the host key line is not duplicated
  assert.equal(await account(['remove', 'forge.example.com'], { paths: p, ...io() }), 0);
  await assert.rejects(fs.stat(conf));
  assert.equal(await account(['add', 'forge.example.com', '--kind', 'forgejo', '--ssh-port', '2222', '--api', 'https://forge.example.com/api/v1/'], { paths: p, ...io(), stdin: piped('tok2'), keyscanOverride: keyscan }), 0);
  assert.equal(await count(), 1);
  assert.match(await fs.readFile(conf, 'utf8'), /^API=https:\/\/forge\.example\.com\/api\/v1$/m, '--api written, trailing slash trimmed');
  // github.com: no keyscan (the installer wrote those keys)
  assert.equal(await account(['add', 'github.com', '--kind', 'github'], { paths: p, ...io(), stdin: piped('ghp_x'), keyscanOverride: keyscan }), 0);
  assert.equal(calls.length, 2);
  // list: one row per conf, token shown as "set"
  const l = io();
  assert.equal(await account(['list'], { paths: p, ...l }), 0);
  assert.match(l.out(), /^forge\.example\.com\s+forgejo\s+https:\/\/forge\.example\.com\/api\/v1\s+token: set$/m);
  assert.match(l.out(), /^github\.com\s+github\s+https:\/\/api\.github\.com\s+token: set$/m);
  assert.ok(!l.out().includes('tok2') && !l.out().includes('ghp_x'));
});

test('account add: every refusal leaves nothing behind, and none echoes the token', async () => {
  const p = await makePrefix();
  const T = 'tokVALUE';
  const tty = Object.assign(Readable.from(['x']), { isTTY: true });
  const scan = async () => [`h.example ssh-ed25519 ${FAKE_KEY}`];
  const cases = [
    ['tty stdin', ['add', 'h.example', '--kind', 'forgejo'], { stdin: tty }],
    ['empty token', ['add', 'h.example', '--kind', 'forgejo'], { stdin: piped('\n') }],
    ['whitespace in token', ['add', 'h.example', '--kind', 'forgejo'], { stdin: piped(`${T} x`) }],
    ['control char in token', ['add', 'h.example', '--kind', 'forgejo'], { stdin: piped(`${T}\x1b`) }],
    ['bad host', ['add', 'h.example/x', '--kind', 'forgejo'], { stdin: piped(T) }],
    ['bad kind', ['add', 'h.example', '--kind', 'gitlab'], { stdin: piped(T) }],
    ['http api', ['add', 'h.example', '--kind', 'forgejo', '--api', 'http://h.example/api/v1'], { stdin: piped(T) }],
    ['bad port', ['add', 'h.example', '--kind', 'forgejo', '--ssh-port', 'x'], { stdin: piped(T) }],
    ['empty keyscan', ['add', 'h.example', '--kind', 'forgejo'], { stdin: piped(T), keyscanOverride: async () => [] }],
    ['failing keyscan', ['add', 'h.example', '--kind', 'forgejo'], { stdin: piped(T), keyscanOverride: async () => { throw new Error('no route'); } }],
  ];
  for (const [label, args, extra] of cases) {
    const o = io();
    assert.equal(await account(args, { paths: p, ...o, keyscanOverride: scan, ...extra }), 1, label);
    assert.ok(!o.err().includes(T) && !o.out().includes(T), `${label}: token echoed`);
    assert.ok(o.err().length > 0, `${label}: says why`);
  }
  await assert.rejects(fs.stat(p.accountsDir), 'no conf directory was created');
  assert.equal(await fs.readFile(p.knownHosts, 'utf8'), '', 'known_hosts untouched');
  // usage
  assert.equal(await account([], { paths: p, ...io() }), 2);
  assert.equal(await account(['bogus'], { paths: p, ...io() }), 2);
  assert.equal(await account(['add'], { paths: p, ...io() }), 2);
  assert.equal(await account(['add', 'h.example'], { paths: p, ...io() }), 2, '--kind is required');
  assert.equal(await account(['remove'], { paths: p, ...io() }), 2);
  assert.equal(await account(['remove', 'nothere.example'], { paths: p, ...io() }), 1);
  assert.equal(await account(['list'], { paths: p, ...io() }), 0, 'list with no accounts dir is an empty list, not an error');
});
