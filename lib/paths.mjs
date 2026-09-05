import path from 'node:path';

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Every per-repo path goes through this, so no command can build a path from an
// unchecked name: `sudo remote-deploy remove ../remote-deploy` must die here, not in rm.
export function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw Object.assign(new Error(`bad repo name "${name}": must match ${NAME_RE}`), { code: 'EBADNAME' });
  }
  return name;
}

export function paths(prefix = process.env.REMOTE_DEPLOY_PREFIX ?? '/') {
  const p = (...parts) => path.join(prefix, ...parts);
  return {
    prefix,
    etc: p('etc/remote-deploy'),
    mainConf: p('etc/remote-deploy/remote-deploy.conf'),
    reposDir: p('etc/remote-deploy/repos'),
    envDir: p('etc/remote-deploy/env'),
    lib: p('var/lib/remote-deploy'),
    log: p('var/log/remote-deploy'),
    sock: p('run/remote-deploy/remote-deploy.sock'),   // systemd's RuntimeDirectory=remote-deploy owns /run/remote-deploy
    knownHosts: p('var/lib/remote-deploy/.ssh/known_hosts'),
    repoDir: (name) => p('var/lib/remote-deploy', checkName(name)),
    repoLog: (name) => p('var/log/remote-deploy', checkName(name)),
    repoConf: (name) => p('etc/remote-deploy/repos', `${checkName(name)}.conf`),
    envFile: (name, phase) => {
      if (phase !== 'build' && phase !== 'deploy') throw new Error(`phase must be build or deploy, got "${phase}"`);
      return p('etc/remote-deploy/env', `${checkName(name)}.${phase}`);
    },
  };
}
