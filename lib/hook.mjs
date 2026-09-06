// lib/hook.mjs
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 26 * 1024 * 1024;   // GitHub caps payloads at 25 MB; a lower cap loses pushes

// Anything that came off the wire and is about to be journaled goes through
// here first. Verification proves the sender holds the secret; it does not
// make a header or a payload field safe to write to a log. A newline forges a
// second journal line, an ESC can hide text in a terminal, and an unbounded
// value can flood the journal. Works on the UTF-8 bytes so that what is logged
// is an honest account of what arrived, one '?' per replaced byte.
export function cleanForLog(value, max = 80) {
  if (value === undefined || value === null) return '';
  const bytes = Buffer.from(String(value), 'utf8');
  let out = '';
  for (const b of bytes) {
    if (out.length >= max) break;
    out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '?';
  }
  return out;
}

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

  // Every arm from here down runs after the signature has verified, and every
  // one journals. The rejections above already do; before this, six arms
  // returned silently, two of them 400s -- so a sender holding the correct
  // secret could be failing on every delivery and the server would not say
  // so, and an operator wiring up a webhook could not tell an accepted ping
  // from one that never arrived. Fields only, cleaned, never the body.
  // `x-github-event` and `x-hub-signature-256` are read on purpose and not
  // the forge's own names: Forgejo, Gitea and Gogs all send these GitHub
  // compatibility headers beside their X-Forgejo-*/X-Gitea-*/X-Gogs-* ones,
  // with the same "sha256=" prefix, so one pair of names covers every forge
  // flipd supports. Do not "fix" them.
  const event = cleanForLog(req.headers['x-github-event'], 40) || '(none)';
  if (event === 'ping') { journal(`webhook ping from ${from}: ok`); return reply(200, 'pong'); }
  if (event !== 'push') { journal(`ignored ${event} event from ${from}`); return reply(200, 'ignored'); }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    journal(`webhook rejected from ${from}: body is not json`);
    return reply(400, 'not json');
  }
  const sshUrl = payload?.repository?.ssh_url;
  const ref = payload?.ref;
  if (typeof sshUrl !== 'string' || typeof ref !== 'string') {
    journal(`webhook rejected from ${from}: missing repository.ssh_url or ref`);
    return reply(400, 'missing repository.ssh_url or ref');
  }
  const url = cleanForLog(sshUrl);
  if (!ref.startsWith('refs/heads/')) {
    journal(`ignored push from ${from}: ${url} ${cleanForLog(ref)} is not a branch`);
    return reply(200, 'ignored');
  }
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted === true) {   // a branch deletion is not a request
    journal(`ignored push from ${from}: ${url} ${cleanForLog(branch)} was deleted`);
    return reply(200, 'ignored');
  }
  const id = Number.isInteger(payload?.repository?.id) ? payload.repository.id : null;

  const repo = await findRepo({ sshUrl, branch, id });
  if (!repo) {
    journal(`ignored push from ${from}: ${url} ${cleanForLog(branch)} matches no repo config`);
    return reply(200, 'ignored');
  }

  // `delivery` is GitHub's per-delivery GUID, shown beside each entry in the
  // repository's webhook log. Raw here, like sha and pusher: onPush cleans at
  // the sink, because appendEvent writes raw by contract (lib/log.mjs).
  const delivery = typeof req.headers['x-github-delivery'] === 'string' ? req.headers['x-github-delivery'] : '';
  const info = { sha: typeof payload.after === 'string' ? payload.after : '', pusher: payload?.pusher?.name ?? payload?.pusher?.login ?? '', sshUrl, id, delivery };
  const { status, body: text } = await onPush(repo, info);
  return reply(status, text);
}
