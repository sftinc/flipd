import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attemptIdFor, openAttemptLog, appendEvent, pruneLogs, latestLog, makeScrubber } from '../lib/log.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'flipd-log-'));
const fixed = () => new Date('2026-09-05T08:14:02.345Z');

test('attempt id is the UTC second with dashes', () => {
  assert.equal(attemptIdFor(fixed()), '2026-09-05T08-14-02Z');
});

test('two attempts in one second get distinct ids and files', async () => {
  const dir = await tmp();
  const a = await openAttemptLog(dir, { now: fixed });
  const b = await openAttemptLog(dir, { now: fixed });
  const c = await openAttemptLog(dir, { now: fixed });
  assert.equal(a.id, '2026-09-05T08-14-02Z');
  assert.equal(b.id, '2026-09-05T08-14-02Z-2');
  assert.equal(c.id, '2026-09-05T08-14-02Z-3');
  assert.equal(a.file, path.join(dir, '2026-09-05T08-14-02Z.log'));
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('a single line is cut at 4 KiB', async () => {
  const dir = await tmp();
  const log = await openAttemptLog(dir, { now: fixed });
  await log.line('x'.repeat(10000));
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.ok(text.length < 5000);
  assert.match(text, /\[line cut at 4096 bytes\]/);
});

test('lines are stamped, output is capped once with a marker, and lines still land after the cap', async () => {
  const dir = await tmp();
  const log = await openAttemptLog(dir, { now: fixed, maxBytes: 10 });
  await log.line('start');
  await log.output('123456');
  await log.output('789012');   // crosses the cap
  await log.output('more');      // discarded
  await log.line('end');
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[^ ]+  start\n/);
  assert.ok(text.includes('123456'));
  assert.ok(!text.includes('789012'));
  assert.ok(!text.includes('more'));
  assert.equal((text.match(/\[output truncated at 10 bytes\]/g) || []).length, 1);
  assert.ok(text.trimEnd().endsWith('end'));
});

test('a secret longer than 256 bytes is still caught across a chunk boundary', async () => {
  const dir = await tmp();
  const big = 'Z'.repeat(600);
  const log = await openAttemptLog(dir, { now: fixed, mask: [big] });
  await log.output(`before ${big.slice(0, 400)}`);
  await log.output(`${big.slice(400)} after\n`);
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.ok(!text.includes('ZZZZZZZZZZ'));
  assert.match(text, /before \*\*\* after/);
  const scrub = makeScrubber(['abcdefghij', 'abcd']);
  assert.equal(scrub('xabcdefghijx'), 'x***x');
  assert.equal(scrub.longest, 10);
});

test('masked values are replaced in lines and output, even across a chunk boundary; short values are not', async () => {
  const dir = await tmp();
  const log = await openAttemptLog(dir, { now: fixed, mask: ['s3cretTOKENvalue', 'true', 'short'] });
  await log.line('token is s3cretTOKENvalue and flag is true');
  await log.output('Authorization: Bearer s3cretTO');
  await log.output('KENvalue\nnext line short\n');
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.ok(!text.includes('s3cretTOKENvalue'));
  assert.match(text, /token is \*\*\* and flag is true/);
  assert.match(text, /Bearer \*\*\*\n/);
  assert.match(text, /next line short/);
});

test('a line call between two halves of a split secret does not leak either half', async () => {
  const dir = await tmp();
  const secret = 's3cretTOKENvalue'; // 16 chars, >= 8
  const log = await openAttemptLog(dir, { now: fixed, mask: [secret] });
  await log.output(`Authorization: Bearer ${secret.slice(0, 6)}`); // ends mid-secret
  await log.line('unrelated interleaved line');
  await log.output(`${secret.slice(6)}\n`); // carries the rest
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(secret.slice(0, 6)));
  assert.match(text, /unrelated interleaved line/);
  assert.match(text, /Bearer \*\*\*/);
});

test('a line call that pushes a masked value across the 4096-byte cut still fully masks it', async () => {
  const dir = await tmp();
  const secret = 'SECRETpart12345'; // 15 chars, >= 8; straddles the byte-4096 cut below
  const prefix = 'a'.repeat(4090);
  const suffix = 'trailing-text';
  const log = await openAttemptLog(dir, { now: fixed, mask: [secret] });
  await log.line(`${prefix}${secret}${suffix}`);
  await log.close();
  const text = await fs.readFile(log.file, 'utf8');
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(secret.slice(0, 6)));
});

test('events append one line each', async () => {
  const dir = await tmp();
  await appendEvent(dir, 'queued', 'x');
  await appendEvent(dir, 'finished', 'x ok 3s /log');
  const lines = (await fs.readFile(path.join(dir, 'events.log'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\S+ queued x$/);
});

test('pruneLogs keeps the newest N and never events.log; latestLog finds the newest', async () => {
  const dir = await tmp();
  for (const id of ['2026-01-01T00-00-00Z', '2026-01-01T00-00-01Z', '2026-01-01T00-00-01Z-2', '2026-01-01T00-00-02Z']) {
    await fs.writeFile(path.join(dir, `${id}.log`), id);
  }
  await appendEvent(dir, 'x', '');
  assert.equal(await latestLog(dir), path.join(dir, '2026-01-01T00-00-02Z.log'));
  const gone = await pruneLogs(dir, 2);
  assert.deepEqual(gone.sort(), ['2026-01-01T00-00-00Z.log', '2026-01-01T00-00-01Z.log']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['2026-01-01T00-00-01Z-2.log', '2026-01-01T00-00-02Z.log', 'events.log']);
  assert.deepEqual(await pruneLogs(dir, 0), []);
});
