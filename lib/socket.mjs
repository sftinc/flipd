// lib/socket.mjs
//
// One JSON line in, one JSON line out, over a Unix domain socket. This is the
// only door into the running service, and every privileged command the CLI
// can issue goes through it, so the socket's access control (mode 0660,
// group-readable/writable only) has to hold from the instant the file exists
// — never a window where it is listening and world-accessible.
import net from 'node:net';
import fs from 'node:fs/promises';

export async function createSocketServer(sockPath, handler) {
  await fs.rm(sockPath, { force: true });
  const server = net.createServer((conn) => {
    // Registered first: a write to a half-closed or reset connection must
    // not surface as an unhandled 'error' and take the whole service down.
    conn.on('error', () => {});
    let buf = '';
    let handled = false;
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return; // wait for the rest of a fragmented line
      handled = true;
      const line = buf.slice(0, nl);
      buf = '';
      respond(line);
    });
    async function respond(line) {
      let reply;
      try {
        reply = await handler(JSON.parse(line));
      } catch (e) {
        reply = { ok: false, error: e.message };
      }
      try {
        conn.end(`${JSON.stringify(reply)}\n`);
      } catch { /* client already gone */ }
    }
  });

  // net.Server#listen() binds the unix socket synchronously before it
  // returns, so restricting the umask around this call (and only this call)
  // means the file is created with mode 0660 from its very first instant —
  // there is no gap where a wider default mode is on disk and listening.
  const restoreUmask = process.umask(0o117); // 0777 & ~0117 == 0660
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(restoreUmask);
  }
  // Belt and suspenders: assert the mode explicitly in case some platform's
  // bind() ever ignores umask for unix sockets.
  await fs.chmod(sockPath, 0o660);
  return server;
}

export function sendCommand(sockPath, msg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = '';
    let settled = false;
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
    const timer = setTimeout(() => {
      conn.destroy();
      finish(reject, new Error('socket timeout'));
    }, timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(msg)}\n`));
    conn.on('data', (c) => { buf += c; });
    conn.on('error', (e) => finish(reject, e));
    conn.on('close', () => {
      if (settled) return;
      try {
        finish(resolve, JSON.parse(buf.trim()));
      } catch {
        finish(reject, new Error(`bad reply: ${buf}`));
      }
    });
  });
}
