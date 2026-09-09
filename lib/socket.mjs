// lib/socket.mjs
//
// One JSON line in, one JSON line out, over a Unix domain socket. This is the
// only door into the running service, and every privileged command the CLI
// can issue goes through it, so the socket's access control (mode 0660,
// group-readable/writable only) has to hold from the instant the file exists
// — never a window where it is listening and world-accessible.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createSocketServer(sockPath, handler, { journal = () => {} } = {}) {
  await fs.rm(sockPath, { force: true });
  const server = net.createServer((conn) => {
    // Registered first: a write to a half-closed or reset connection must
    // not surface as an unhandled 'error' and take the whole service down.
    conn.on('error', () => {});
    // Aborted when the client goes away. A handler holding a long reply
    // (trigger --wait follows a build to its end) can stop waiting instead
    // of pinning this connection and its own continuation until the attempt
    // settles — which, with no ceiling on TIMEOUT, can be hours.
    const gone = new AbortController();
    conn.once('close', () => gone.abort());
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
        reply = await handler(JSON.parse(line), { signal: gone.signal });
      } catch (e) {
        reply = { ok: false, error: e.message };
      }
      try {
        conn.end(`${JSON.stringify(reply)}\n`);
      } catch { /* client already gone */ }
    }
  });

  // Bind to a private temp path first, chmod it, then rename it onto the
  // well-known path. Rename within a directory is atomic and an actively
  // listening unix socket survives it, so sockPath itself never exists at
  // any mode other than 0660 — no global umask mutation needed, and no
  // window where a wider default mode is reachable at the well-known name.
  // Kept short and pid-qualified (not the socket's own basename): a Unix
  // domain socket path is capped at ~104 bytes on macOS and ~108 on Linux,
  // and a temp name should not itself become the binding constraint the
  // final, shorter name never was.
  const tmpPath = path.join(path.dirname(sockPath), `.${process.pid}.s`);
  await fs.rm(tmpPath, { force: true });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(tmpPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // From here on the server is up: a later server-level error (e.g.
    // EMFILE under fd exhaustion) must be journaled, not left to become an
    // uncaught exception that takes the whole service down. journal() itself
    // must never be allowed to throw back into this listener — a synchronous
    // stderr write hitting EPIPE is the realistic case — or we're back to
    // the same crash one level down.
    server.on('error', (e) => {
      try { journal(`socket server error: ${e.stack ?? e}`); } catch { /* journal must never throw */ }
    });
    await fs.chmod(tmpPath, 0o660);
    await fs.rename(tmpPath, sockPath);
  } catch (e) {
    if (server.listening) await new Promise((r) => server.close(r));
    await fs.rm(tmpPath, { force: true });
    throw e;
  }
  return server;
}

// timeoutMs null arms no timer at all: the connection's lifetime is then the
// timeout, and the service dying reads as a closed socket. (Infinity is not an
// option — setTimeout clamps it to 1ms.)
export function sendCommand(sockPath, msg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = '';
    let settled = false;
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    }
    const timer = timeoutMs === null ? null : setTimeout(() => {
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
