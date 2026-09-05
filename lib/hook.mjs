// lib/hook.mjs
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 26 * 1024 * 1024;   // GitHub caps payloads at 25 MB; a lower cap loses pushes

export function verifySignature(secret, body, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;   // keep draining so the 413 can be written and read; hold nothing
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHookServer({ secret, findRepo, onPush, journal }) {
  const server = http.createServer((req, res) => {
    // Nothing thrown in here may escape: an unhandled rejection in a request
    // handler takes the whole service down under Node's default mode.
    handle(req, res, { secret, findRepo, onPush, journal }).catch((e) => {
      journal(`webhook handler error: ${e.stack ?? e}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); }
      else res.end();
    });
  });
  server.requestTimeout = 60000;    // a 26 MiB body over a slow link, and no more
  server.headersTimeout = 15000;
  return server;
}

async function handle(req, res, { secret, findRepo, onPush, journal }) {
  const reply = (status, body = '') => { res.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }); res.end(body); };
  const from = req.socket.remoteAddress;
  if (req.method !== 'POST' || req.url !== '/deploy') return reply(404);

  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) {
    journal(`webhook rejected from ${from}: body too large (${declared} bytes)`);
    req.resume();
    return reply(413);
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    journal(`webhook rejected from ${from}: ${e.message}`);
    // Connection: close, so the client reads the 413 and neither side reuses a
    // socket with an unread body on it. No destroy: a reset would lose the reply.
    res.setHeader('connection', 'close');
    reply(e.status ?? 400);
    return;
  }
  if (!verifySignature(secret, body, req.headers['x-hub-signature-256'])) {
    journal(`webhook rejected from ${from}: bad or missing signature`);
    return reply(401);
  }

  const event = req.headers['x-github-event'];
  if (event === 'ping') return reply(200, 'pong');
  if (event !== 'push') return reply(200, 'ignored');

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return reply(400, 'not json');
  }
  const sshUrl = payload?.repository?.ssh_url;
  const ref = payload?.ref;
  if (typeof sshUrl !== 'string' || typeof ref !== 'string') return reply(400, 'missing repository.ssh_url or ref');
  if (!ref.startsWith('refs/heads/')) return reply(200, 'ignored');
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted === true) return reply(200, 'ignored');   // a branch deletion is not a request
  const id = Number.isInteger(payload?.repository?.id) ? payload.repository.id : null;

  const repo = await findRepo({ sshUrl, branch, id });
  if (!repo) {
    journal(`ignored push from ${from}: ${sshUrl} ${branch} matches no repo config`);
    return reply(200, 'ignored');
  }

  const info = { sha: typeof payload.after === 'string' ? payload.after : '', pusher: payload?.pusher?.name ?? '', sshUrl, id };
  const { status, body: text } = await onPush(repo, info);
  return reply(status, text);
}
