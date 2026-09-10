// lib/repourl.mjs
//
// One parser for repository URLs, shared by `add` (to pick a forge and derive
// a name), `check` (to print the recipe), and `findRepoFor` (to match a push).
// Only the owner/repo shape every forge renders is recognised; anything else
// (file://, a GitLab subgroup path, an IPv6 literal, a bare path) is null and
// callers fall back to treating the string as opaque.

// scp form: [user@]host:owner/repo[.git][/]. The host cannot contain ":" or
// "/", which is what keeps "https://..." out of this arm.
const SCP_RE = /^(?:[^@/:\s]+@)?([^@/:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
// URL form: scheme://[user@]host[:port]/owner/repo[.git][/].
const URL_RE = /^(?:ssh|https?|git):\/\/(?:[^@/\s]+@)?([^/:\s\[\]]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export function parseRepoUrl(url) {
  if (typeof url !== 'string') return null;
  const m = URL_RE.exec(url) ?? SCP_RE.exec(url);
  if (!m) return null;
  const [, host, owner, repo] = m;
  return { host: host.toLowerCase(), owner, repo, name: repo.toLowerCase() };
}

// What a push and a conf have in common when they name the same repository:
// hostnames are case-insensitive everywhere, and GitHub, Forgejo and Gitea all
// treat the path so. The port goes because a forge that moves SSH to another
// port has not become a different forge.
export function repoIdentity(url) {
  const r = parseRepoUrl(url);
  return r ? `${r.host}/${r.owner}/${r.repo}`.toLowerCase() : null;
}

// Do a push and a conf, or two confs, name the same repository? By identity
// when both parse; URLs that do not (file://) compare as lowercased strings.
// Shared by the webhook matcher and by `check`'s sibling rows.
export function sameRepo(a, b) {
  const ia = repoIdentity(a);
  const ib = repoIdentity(b);
  return ia !== null && ib !== null ? ia === ib : a.toLowerCase() === b.toLowerCase();
}
