import path from 'node:path';

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Every per-repo path goes through this, so no command can build a path from an
// unchecked name: `sudo flipd remove ../flipd` must die here, not in rm.
export function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw Object.assign(new Error(`bad repo name "${name}": must match ${NAME_RE}`), { code: 'EBADNAME' });
  }
  return name;
}

// A forge host is a lowercase DNS name: labels of [a-z0-9-] not starting or
// ending in "-", joined by ".", 253 characters at most. That is enough to keep
// "..", "/", and anything else that is not a hostname out of a path under
// /etc/flipd/accounts/. Callers lowercase before checking.
export const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function checkHost(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw Object.assign(new Error(`bad account host "${host}": must be a lowercase hostname like forge.example.com`), { code: 'EBADHOST' });
  }
  return host;
}

export function paths(prefix = process.env.FLIPD_PREFIX ?? '/') {
  const p = (...parts) => path.join(prefix, ...parts);
  return {
    prefix,
    etc: p('etc/flipd'),
    mainConf: p('etc/flipd/flipd.conf'),
    reposDir: p('etc/flipd/repos'),
    envDir: p('etc/flipd/env'),
    accountsDir: p('etc/flipd/accounts'),
    accountConf: (host) => p('etc/flipd/accounts', `${checkHost(host)}.conf`),
    lib: p('var/lib/flipd'),
    log: p('var/log/flipd'),
    sock: p('run/flipd/flipd.sock'),   // systemd's RuntimeDirectory=flipd owns /run/flipd
    knownHosts: p('var/lib/flipd/.ssh/known_hosts'),
    repoDir: (name) => p('var/lib/flipd', checkName(name)),
    repoLog: (name) => p('var/log/flipd', checkName(name)),
    repoConf: (name) => p('etc/flipd/repos', `${checkName(name)}.conf`),
    envFile: (name, phase) => {
      if (phase !== 'build' && phase !== 'deploy') throw new Error(`phase must be build or deploy, got "${phase}"`);
      return p('etc/flipd/env', `${checkName(name)}.${phase}`);
    },
  };
}
