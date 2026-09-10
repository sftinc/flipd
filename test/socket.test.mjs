import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { createSocketServer, sendCommand } from '../lib/socket.mjs';

async function newSockPath() {
  return path.join(await tmpdir('flipd-sock'), 'd.sock');
}

// Writes raw lines over a fresh connection and resolves with everything the
// server wrote back before closing. Used where sendCommand's one-line
// contract can't express the scenario under test (multiple lines, a
// mid-flight destroy).
function rawRoundTrip(sock, write) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => write(conn));
    conn.on('data', (c) => { buf += c; });
    conn.on('error', reject);
    conn.on('close', () => resolve(buf.trim()));
  });
}

test('round trip, handler errors, stale file, service down', async () => {
  const sock = await newSockPath();
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

test('the socket is mode 0660 as soon as it is listening', async () => {
  const sock = await newSockPath();
  const server = await createSocketServer(sock, async () => ({ ok: true }));
  try {
    assert.equal((await fs.stat(sock)).mode & 0o777, 0o660);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a journal that throws does not crash the server; a later command still works', async () => {
  const sock = await newSockPath();
  const server = await createSocketServer(sock, async () => ({ ok: true }), {
    journal: () => { throw new Error('EPIPE'); },
  });
  try {
    // Simulate a later server-level error (e.g. EMFILE) whose journaling
    // itself blows up (e.g. a broken stderr pipe).
    server.emit('error', Object.assign(new Error('simulated'), { code: 'EMFILE' }));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await sendCommand(sock, { cmd: 'still-alive' }), { ok: true });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a malformed, non-JSON line does not crash the service; a later command still works', async () => {
  const sock = await newSockPath();
  const server = await createSocketServer(sock, async (msg) => ({ ok: true, echo: msg }));
  try {
    const reply = JSON.parse(await rawRoundTrip(sock, (conn) => conn.write('not json at all\n')));
    assert.equal(reply.ok, false);
    assert.match(reply.error, /JSON/i);
    assert.deepEqual(await sendCommand(sock, { cmd: 'still-here' }), { ok: true, echo: { cmd: 'still-here' } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('timeout rejects with the expected message, and the connection and server survive it', async () => {
  const sock = await newSockPath();
  const server = await createSocketServer(sock, async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  });
  try {
    await assert.rejects(
      sendCommand(sock, { cmd: 'slow' }, { timeoutMs: 20 }),
      (e) => e.message === 'socket timeout',
    );
    // No pending timer or connection was left behind: a fresh, un-timed-out
    // command on the same server still completes normally right after.
    assert.deepEqual(await sendCommand(sock, { cmd: 'fast' }), { ok: true });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('two lines sent on one connection dispatch the handler only once', async () => {
  const sock = await newSockPath();
  let calls = 0;
  const server = await createSocketServer(sock, async (msg) => {
    calls += 1;
    return { ok: true, echo: msg };
  });
  try {
    const reply = await rawRoundTrip(sock, (conn) => {
      conn.write(`${JSON.stringify({ cmd: 'one' })}\n`);
      conn.write(`${JSON.stringify({ cmd: 'two' })}\n`);
    });
    assert.deepEqual(JSON.parse(reply), { ok: true, echo: { cmd: 'one' } });
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a client that destroys the connection mid-handler does not crash the server', async () => {
  const sock = await newSockPath();
  let handlerSettled = false;
  const server = await createSocketServer(sock, async (msg) => {
    await new Promise((r) => setTimeout(r, 50));
    handlerSettled = true;
    return { ok: true, echo: msg };
  });
  try {
    await new Promise((resolve, reject) => {
      const conn = net.createConnection(sock);
      conn.on('connect', () => {
        conn.write(`${JSON.stringify({ cmd: 'x' })}\n`);
        conn.destroy();
        resolve();
      });
      conn.on('error', reject);
    });
    // Give the handler time to finish and attempt its now-futile write.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(handlerSettled, true);
    // The service is still alive and answers a fresh request normally.
    assert.deepEqual(await sendCommand(sock, { cmd: 'still-alive' }), { ok: true, echo: { cmd: 'still-alive' } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('sendCommand with timeoutMs null arms no timer: a slow reply still arrives; a number still times out', async () => {
  const sock = await newSockPath();
  const server = await createSocketServer(sock, async () => { await new Promise((r) => setTimeout(r, 150)); return { ok: true }; });
  try {
    assert.deepEqual(await sendCommand(sock, { cmd: 'slow' }, { timeoutMs: null }), { ok: true });
    await assert.rejects(sendCommand(sock, { cmd: 'slow' }, { timeoutMs: 50 }), /socket timeout/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the handler is given a signal that fires when the client closes before the reply', async () => {
  const sock = await newSockPath();
  let fired = false;
  let release;
  const held = new Promise((r) => (release = r));
  const server = await createSocketServer(sock, async (msg, { signal }) => {
    signal.addEventListener('abort', () => { fired = true; release(); }, { once: true });
    await held;
    return { ok: true };
  });
  try {
    await rawRoundTrip(sock, (conn) => {
      conn.write('{"cmd":"x"}\n');
      setTimeout(() => conn.destroy(), 50);
    });
    await held;
    assert.equal(fired, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
