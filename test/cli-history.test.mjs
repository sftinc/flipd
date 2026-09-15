import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePrefix } from './helpers.mjs';
import { writeState, emptyState } from '../lib/state.mjs';
import history from '../lib/cli/history.mjs';
import log from '../lib/cli/log.mjs';

const BIN = fileURLToPath(new URL('../bin/flipd', import.meta.url));

function io() {
  let out = '', err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, out: () => out, err: () => err };
}

const row = (attempt, extra = {}) => ({ attempt, trigger: 'webhook', sha: 'a'.repeat(40), release: `${attempt}-aaaaaaa`, outcome: 'ok', started: '2026-09-14T00:00:00.000Z', finished: '2026-09-14T00:01:24.200Z', log: `/l/${attempt}.log`, ...extra });

async function fixture() {
  const p = await makePrefix();
  const logDir = p.repoLog('app');
  await fs.mkdir(logDir, { recursive: true });
  const rows = [
    row('2026-09-14T16-01-20Z', { trigger: 'ssh' }),
    row('2026-09-14T17-12-55Z', { outcome: 'deploy failed' }),
    row('2026-09-15T09-40-03Z', { trigger: 'manual' }),
  ];
  await fs.writeFile(path.join(logDir, 'history.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{"torn\n`);
  const running = { attempt: '2026-09-15T10-02-11Z', trigger: 'webhook', sha: 'c'.repeat(40), release: null, outcome: null, started: '2026-09-15T10:02:11.000Z', finished: null, log: '/l/x.log' };
  await writeState(p.repoDir('app'), {
    ...emptyState(),
    live: rows[2].release,
    previous: rows[0].release,
    pending: rows[1].release,
    releases: { [rows[0].release]: { sha: 'a' }, [rows[1].release]: { sha: 'a' }, [rows[2].release]: { sha: 'a' } },
    last: running,
  });
  return { p, rows, running };
}

test('history: newest first, the unfinished last merged as running, roles, torn line reported', async () => {
  const { p } = await fixture();
  const o = io();
  assert.equal(await history(['app'], { paths: p, ...o }), 0);
  const lines = o.out().trimEnd().split('\n');
  assert.match(lines[0], /^ATTEMPT\s+TRIGGER\s+SHA\s+OUTCOME\s+DURATION\s+RELEASE$/);
  assert.match(lines[1], /^2026-09-15T10-02-11Z\s+webhook\s+ccccccc\s+running\s+-$/);
  assert.match(lines[2], /^2026-09-15T09-40-03Z\s+manual\s+aaaaaaa\s+ok\s+84\.2s\s+live$/);
  assert.match(lines[3], /^2026-09-14T17-12-55Z\s+webhook\s+aaaaaaa\s+deploy failed\s+84\.2s\s+pending$/);
  assert.match(lines[4], /^2026-09-14T16-01-20Z\s+ssh\s+aaaaaaa\s+ok\s+84\.2s\s+previous$/);
  assert.match(o.err(), /skipped 1 unreadable line/);
});

test('history: --limit, --json with role and duration, a duplicated id shows once, pending outranks previous', async () => {
  const { p, rows } = await fixture();
  // The same release both pending and previous, as a failed rollback leaves it,
  // and the backstop having written the last row a second time.
  await writeState(p.repoDir('app'), { ...emptyState(), live: rows[2].release, previous: rows[1].release, pending: rows[1].release, releases: { [rows[1].release]: { sha: 'a' }, [rows[2].release]: { sha: 'a' } }, last: rows[2] });
  await fs.appendFile(path.join(p.repoLog('app'), 'history.jsonl'), `${JSON.stringify(rows[2])}\n`);
  const o = io();
  assert.equal(await history(['app', '--json', '--limit', '2'], { paths: p, ...o }), 0);
  const out = JSON.parse(o.out());
  assert.deepEqual(out.map((r) => [r.attempt, r.role, r.duration_s]), [['2026-09-15T09-40-03Z', 'live', 84.2], ['2026-09-14T17-12-55Z', 'pending', 84.2]]);
});

test('history: a finished last missing from the file is listed; a malformed last is ignored; nothing at all is exit 1; bad flags are 2', async () => {
  const p = await makePrefix();
  await writeState(p.repoDir('solo'), { ...emptyState(), last: row('2026-09-15T09-40-03Z') });
  const o = io();
  assert.equal(await history(['solo'], { paths: p, ...o }), 0);
  assert.match(o.out(), /2026-09-15T09-40-03Z/);
  await writeState(p.repoDir('bad'), { ...emptyState(), last: { attempt: 42 } });
  const none = io();
  assert.equal(await history(['bad'], { paths: p, ...none }), 1);
  assert.match(none.err(), /no history for bad yet/);
  assert.equal(await history([], { paths: p, ...io() }), 2);
  assert.equal(await history(['solo', '--limit', '0'], { paths: p, ...io() }), 2);
  assert.equal(await history(['solo', '--bogus'], { paths: p, ...io() }), 2);
});

test('log: an attempt id opens that log; a traversal is usage; an unknown id is 1', async () => {
  const p = await makePrefix();
  await fs.mkdir(p.repoLog('a'), { recursive: true });
  await fs.writeFile(path.join(p.repoLog('a'), '2026-01-01T00-00-00Z.log'), 'old');
  await fs.writeFile(path.join(p.repoLog('a'), '2026-01-02T00-00-00Z.log'), 'new');
  const o = io();
  assert.equal(await log(['a', '2026-01-01T00-00-00Z'], { paths: p, ...o }), 0);
  assert.equal(o.out(), 'old');
  const bad = io();
  assert.equal(await log(['a', '../../../etc/passwd'], { paths: p, ...bad }), 2);
  assert.match(bad.err(), /usage: flipd log <name> \[attempt\] \[--follow\]/);
  const gone = io();
  assert.equal(await log(['a', '2026-01-03T00-00-00Z'], { paths: p, ...gone }), 1);
  assert.match(gone.err(), /no attempt log 2026-01-03T00-00-00Z for a \(pruned, or never existed\)/);
});

test('bin/flipd knows history', async () => {
  const { code, err } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'history']);
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(code, 2);
  assert.match(err, /usage: flipd history <name> \[--limit N\] \[--json\]/);
});
