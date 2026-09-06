// lib/forge.mjs
//
// The forge API, as much of it as `add` needs: look a repository up, list its
// webhooks, add a read-only deploy key, add a push webhook, and delete a key
// again when a later step fails. GitHub and the Gitea family (Forgejo, Gitea)
// are close enough that this is one request helper and a table of differences.
// Node's global fetch; no dependency. Used by `add` only — the service never
// holds a token.
import { cleanForLog } from './hook.mjs';

export class ForgeError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.status = status;
  }
}

const github = {
  auth: (token) => `Bearer ${token}`,
  headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  hookBody: ({ url, secret }) => ({ name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret } }),
};
// `type` is the one field that differs inside the family: Forgejo accepts
// "forgejo" and "gitea", Gitea accepts only "gitea". The payload it then sends
// is the same either way.
const gitea = (type) => ({
  auth: (token) => `token ${token}`,
  headers: { Accept: 'application/json' },
  hookBody: ({ url, secret }) => ({ type, active: true, events: ['push'], config: { url, content_type: 'json', secret } }),
});
const KINDS = { github, forgejo: gitea('forgejo'), gitea: gitea('gitea') };

export function createForge({ kind, api, token }, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown forge kind "${kind}"`);
  const seg = (s) => encodeURIComponent(String(s));

  async function call(method, route, body) {
    let res;
    try {
      res = await fetchImpl(`${api}${route}`, {
        method,
        headers: {
          'User-Agent': 'flipd',
          Authorization: k.auth(token),
          ...k.headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        // A cross-origin redirect would otherwise have undici replay the
        // request at the new origin, Authorization header and all — this
        // token is scoped to one forge, not to wherever a 3xx sends it. Fail
        // outright instead: correct by construction rather than by relying
        // on redirect-stripping behaviour (which fetch does not even
        // guarantee across origins) staying as it is.
        redirect: 'error',
      });
    } catch (e) {
      // fetch's own errors name the URL at most, never the header. The cause
      // code (ECONNREFUSED, ENOTFOUND) is the useful part; a timeout has none.
      const why = e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (e.cause?.code ?? e.message);
      throw new ForgeError(`${method} ${route}: ${why}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json: an HTML error page, say */ }
    if (!res.ok) {
      // The body came off the wire: cleaned and capped before it can reach a
      // terminal or a log. The API's `message` is what both forges put their
      // reason in; anything else is quoted as a bounded prefix.
      const msg = typeof json?.message === 'string' ? json.message : text.slice(0, 200);
      throw new ForgeError(`${method} ${route}: ${res.status}${msg ? ' ' + cleanForLog(msg, 200) : ''}`, { status: res.status });
    }
    return json;
  }

  return {
    async getRepo(owner, repo) {
      const r = await call('GET', `/repos/${seg(owner)}/${seg(repo)}`);
      return { sshUrl: r?.ssh_url, id: r?.id };
    },
    async listHooks(owner, repo) {
      const r = await call('GET', `/repos/${seg(owner)}/${seg(repo)}/hooks`);
      return (Array.isArray(r) ? r : []).map((h) => ({ id: h.id, url: typeof h.config?.url === 'string' ? h.config.url : '' }));
    },
    async addDeployKey(owner, repo, { title, key }) {
      const route = `/repos/${seg(owner)}/${seg(repo)}/keys`;
      const r = await call('POST', route, { title, key, read_only: true });
      // A 2xx with no id (an empty body, an unexpected shape) is not a
      // usable success: the caller stores this id to delete the key again on
      // a later failure, and `undefined` there is a `DELETE .../keys/undefined`
      // waiting to happen. Treated as a ForgeError rather than an id of
      // `undefined`, so the null-versus-undefined distinction the caller
      // would otherwise have to make (a key never uploaded vs. one whose id
      // we failed to learn) does not need to exist at all. status is null,
      // not r's status: the request itself succeeded; what failed is the body.
      if (r?.id == null) throw new ForgeError(`POST ${route}: response carried no id`, { status: null });
      return { id: r.id };
    },
    async addHook(owner, repo, { url, secret }) {
      const route = `/repos/${seg(owner)}/${seg(repo)}/hooks`;
      const r = await call('POST', route, k.hookBody({ url, secret }));
      if (r?.id == null) throw new ForgeError(`POST ${route}: response carried no id`, { status: null });
      return { id: r.id };
    },
    async deleteDeployKey(owner, repo, id) {
      await call('DELETE', `/repos/${seg(owner)}/${seg(repo)}/keys/${seg(id)}`);
    },
  };
}
