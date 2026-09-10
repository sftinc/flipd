# Installing flipd

## Requirements

The box needs `git`, `node` 20 or newer, `ssh-keygen` and `curl`. The first
three are checked up front, and the installer stops cleanly if one is missing.
`curl` is also required, but is not checked beforehand; it is used partway
through (GitHub's host keys, Caddy repo setup, and the signed ping), so a box
without it gets a partial install and a raw shell `command not found` rather
than a clean refusal. On Debian and Ubuntu, `apt install nodejs` does **not**
include `npm` — that is a separate package, needed only if your `BUILD` command
uses it (`apt install npm`). A `BUILD=npm test` on a box with `node` but no
`npm` fails with exit 127 and `npm: not found` in the attempt log; the fix is
upstream of flipd.

## Install

There are two installs, and the difference is only whether pushes reach the box
over HTTP. Everything else — the user, the trees, the service, the commands —
is the same.

**With a webhook.** Needs a hostname that already points at the box:

    git clone git@github.com:sftinc/flipd.git /opt/flipd
    sudo /opt/flipd/install.sh --host deploy.example.com

`--host` installs Caddy, wires TLS, checks the path with a signed ping, and
sets `PUBLIC_HOST` — which is what turns the webhook listener on.

**Without one.** No hostname, no TLS, no open port:

    git clone git@github.com:sftinc/flipd.git /opt/flipd
    sudo /opt/flipd/install.sh

Everything happens except the Caddy step, whose site block is printed for you
to paste if you ever want it, and flipd runs with no HTTP listener at all.
Pushes then arrive over SSH — a CI job running `flipd trigger <name> --wait`
through a key locked to that one command, which also makes the job go red when
a deploy fails. That is [triggering-over-ssh.md](triggering-over-ssh.md), and
`flipd add` prints the recipe for it.

To add a webhook later, re-run with `--host`; to front it with your own TLS
instead, paste the block and set `PUBLIC_HOST` in `flipd.conf` yourself.

With `--host`, the site block lives at `/etc/caddy/conf.d/flipd.caddy` and
logs every request to this site — source IP, method, path, status, and the
request headers with `X-Hub-Signature-256` filtered out — to journald, so
`journalctl -u caddy` is where to look when a webhook seems not to arrive.
The `log` directive is inside the site block, so it covers this site only,
not others on the same Caddy. The block is rewritten on each `--host` run, so
hand edits there do not survive; and everything in `conf.d/` is imported, so
a backup file left there defines the site twice and Caddy refuses the reload.

Partway through its output, the installer prints a
`sudo usermod -aG flipd <you>` line — run it (and start a fresh login
shell, or `newgrp flipd`) so your own account can use the commands
below without `sudo`. See [Permissions](commands.md#permissions).

## What the installer does

It runs as root, and every step is skip-if-present, so a re-run is safe — and
is how a `git pull` to the clone reaches the systemd unit and the logrotate
policy, which are files in this repository. In order:

- **Checks the prerequisites** — `git`, `node` 20 or newer, `ssh-keygen`. A
  missing one stops the run before anything is written.
- **Creates the `flipd` system user**, no login shell, home `/var/lib/flipd`,
  with a group of the same name. That group is the whole access control for the
  commands, which is why the run prints a `sudo usermod -aG flipd <you>` line
  for you to run.
- **Creates the trees** — `/etc/flipd` with `repos/` and `env/`, mode `0750`
  `root:flipd`; `/var/lib/flipd` and `/var/log/flipd`, mode `0750`
  `flipd:flipd`. Config is readable by the service and writable only by root;
  state and logs are the service's own. See [Where things
  live](layout.md).
- **Writes `/etc/flipd/flipd.conf`** with a freshly generated `WEBHOOK_SECRET`
  and defaults for the rest — see [The server
  file](configuration.md#the-server-file). An existing file is left as it is,
  apart from `PUBLIC_HOST`, which `--host` sets. Its ownership is repaired to
  `root:flipd 0640` on every run, including for a file you wrote by hand: left
  `root:root 0600` the service cannot read it and crash-loops.
- **Fetches GitHub's SSH host keys** from `api.github.com/meta` into
  `/var/lib/flipd/.ssh/known_hosts`, once. An empty or keyless answer aborts
  rather than writing the file, because a non-empty-but-useless `known_hosts`
  wedges every fetch on host key verification and no later run would replace
  it.
- **Links `/usr/local/bin/flipd`** to `bin/flipd` in this clone, and sets the
  mode bit a checkout may have lost.
- **Installs `flipd.logrotate`** — a file in the repository root — to
  `/etc/logrotate.d/flipd`. It rotates every repo's `events.log` monthly and
  keeps twelve, re-creating each one `0640 flipd flipd` so the service can
  still append to it. flipd never prunes that log itself.
- **Installs `flipd.service`** — also in the repository root — to
  `/etc/systemd/system/`, enables it, restarts it, and checks two seconds later
  that it is still running. The unit runs `bin/flipd serve` as `flipd`;
  `RuntimeDirectory=flipd` is what creates `/run/flipd` for the socket the
  commands talk to; and `KillMode=mixed` sends `SIGTERM` to flipd alone, so a
  stop lets it kill a running build's process group deliberately and record the
  attempt as `interrupted`. The shipped `ExecStart` names `/opt/flipd`; a clone
  anywhere else gets its real path substituted into the installed copy, and the
  run says so out loud.
- **Wires Caddy**, with `--host` only. Installs Caddy from its apt repository
  if it is missing, writes the site block described above, adds `import
  /etc/caddy/conf.d/*` to `/etc/caddy/Caddyfile` if it is not there already,
  reloads, and then proves the path end to end with a signed ping to
  `https://<host>/deploy`. The ping is retried with a growing gap for up to 50
  seconds, because a first install is still waiting on an ACME certificate and
  every handshake fails until it lands; `pong` means a webhook from GitHub will
  arrive.

Nothing else on the box is touched, apart from the apt repository and
keyring the Caddy step adds when it has to install Caddy itself.

## Upgrade flipd

    git -C /opt/flipd pull && sudo systemctl restart flipd

Restarting drops anything mid-build: the in-flight command is killed, its
attempt is logged as `interrupted`, and the in-memory queue is lost. Check
that `flipd status` shows nothing running first.

One behaviour change to know about when upgrading past this version: a
checkout containing `.gitmodules` now initialises its submodules, so a repo
that carries one its build never needed — a docs theme, a vendor directory —
fails with `checkout failed` if the deploy key cannot read it. See the `KEY`
row in [The repo file](configuration.md#the-repo-file) for the machine-user key that fixes it.
