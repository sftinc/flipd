import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { createSocketServer, sendCommand } from '../lib/socket.mjs';

test('round trip, handler errors, stale file, service down', async () => {
  const sock = path.join(await tmpdir('remote-deploy-sock'), 'd.sock');
  await fs.writeFile(sock, 'stale');
  const server = await createSocketServer(sock, async (msg) => {
    if (msg.cmd === 'boom') throw new Error('bad');
    return { ok: true, echo: msg };
  });
  try {
    assert.deepEqual(await sendCommand(sock, { cmd: 'run', name: 'a' }), { ok: true, echo: { cmd: 'run', name: 'a' } });
    assert.deepEqual(await sendCommand(sock, { cmd: 'boom' }), { ok: false, error: 'bad' });
    assert.equal((await fs.stat(sock)).mode & 0o777, 0o660);
  } finally {
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(sendCommand(sock, { cmd: 'run' }), (e) => ['ENOENT', 'ECONNREFUSED'].includes(e.code));
});
