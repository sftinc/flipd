# flipd

Build-on-push for a box you own. Push to a branch; the server fetches, builds,
flips a symlink, and runs your deploy command. One file per repo, one webhook,
no npm dependencies.

Design: the specification was retired from the tree once the build was done,
and is read from history:

    git show 3f493f0:docs/superpowers/specs/2026-09-05-remote-deploy-design.md

## Install (once per server)

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

    git clone git@github.com:sftinc/flipd.git /opt/flipd
    sudo /opt/flipd/install.sh --host deploy.example.com

`--host` needs a name that already points at the box; it installs Caddy, wires
TLS, and checks the path with a signed ping. Without it, everything else
happens and the Caddy block is printed to paste by hand.
The block logs every request to the site — source IP, method, path, status —
to journald, so `journalctl -u caddy` is where to look when a webhook seems
not to arrive. The block lives at `/etc/caddy/conf.d/flipd.caddy` and is
rewritten on each `--host` run, so hand edits there do not survive; and
everything in `conf.d/` is imported, so a backup file left there defines the
site twice and Caddy refuses the reload.

Partway through its output, the installer prints a
`sudo usermod -aG flipd <you>` line — run it (and start a fresh login
shell, or `newgrp flipd`) so your own account can use the commands
below without `sudo`. See [Permissions](#permissions).

## Add a repo

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints)
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

## Every day

    flipd status
    flipd check app
    flipd log app [--follow]
    flipd run app          # build now, ignoring watch/ignore filters
    flipd rollback app     # back to the last confirmed release
    sudo flipd env app build --set NPM_TOKEN=...

`check` is the one to put in cron: it exits `0` when the deploy is confirmed
and live matches the branch head, and non-zero otherwise, so

    flipd check app || notify-me "app needs a look"

catches both a lost webhook and a deploy nobody noticed had failed. To tell
those apart, use the exit code directly — see `check`'s row in
[Commands](#commands): `0` up to date, `4` behind (or unconfirmed), `1` a
failed row, `3` service down.

## Permissions

`/etc/flipd` is root-owned, so **`add`, `env` and `remove` need
`sudo`.**

`status`, `check`, `run`, `rollback` and `log` don't need `sudo`, but they do
need your account in the `flipd` group (the install step above) — none
of the three directories they touch is world-readable, on purpose:
`/etc/flipd/repos` (mode `0750`, `root:flipd` — `status` and
`check` list repos from it), the Unix socket at
`/run/flipd/flipd.sock` (mode `0660`,
`flipd:flipd` — the only way to reach `run`, `rollback`, and
the deploy key `check` needs), and `/var/log/flipd` (mode `0750`, same
owner — `log` reads from it). Without group membership (and not running as
root):

- `check`, `run`, `rollback` and `log` report `service down` from the
  unreachable socket or an unreadable log directory, indistinguishable from
  the service actually being down;
- `status` fails outright with a bare `EACCES: permission denied, scandir
  '/etc/flipd/repos'` (exit `1`), since it cannot even list the
  configured repos.

If you see either of those but `systemctl status flipd` says the
service is fine, it's almost always a missing group, not a dead service.

### A DEPLOY command that needs root

`DEPLOY` runs as the `flipd` user. If it must do something only root can —
restart a system service, say — give `flipd` passwordless `sudo` for **one
script and nothing else**, and put the privileged steps in that script:

    echo 'flipd ALL=(root) NOPASSWD: /usr/local/bin/<your-adopt-script>' > /etc/sudoers.d/flipd
    chmod 0440 /etc/sudoers.d/flipd

Then `DEPLOY=sudo /usr/local/bin/<your-adopt-script>`. Keep the script's path
absolute and its contents root-owned and not group- or world-writable, or the
rule grants root to whoever can edit it. The installer used to print this on
every run; it lives here now so that it is read when it is needed rather than
skimmed when it is not.

## Commands

| Command | Sudo / group needed | Exit codes |
|---|---|---|
| `flipd serve` | run by systemd as `flipd` | runs until `SIGTERM`/`SIGINT` |
| `flipd add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]` | sudo | `0` written; `1` a name/value/config problem; `2` usage |
| `flipd check <name> [--set-remote]` | group (or sudo) | `0` pass, live matches branch head; `4` pass, but live is behind (nothing wrong with the setup, just not deployed yet); `1` a row failed (bad config, key, or clone); `2` usage; `3` service down (or unreachable — see [Permissions](#permissions)) |
| `flipd run <name>` | group (or sudo) | `0` request handled (see stdout: `queued <name>` or `not queued: <reason>` if a build for it is already running/queued/the service is shutting down); `1` the service refused it (a config error); `2` usage; `3` service down |
| `flipd rollback <name>` | group (or sudo) | same as `run`, printing `queued rollback of <name> to <sha>` or `not queued: <reason>` |
| `flipd status [name]` | group (or sudo) | `0` printed (the activity column falls back to `service down` if the socket is merely unreachable); `1` no such repo / nothing configured, **or** a bare `EACCES` if you're not in the `flipd` group — see [Permissions](#permissions) |
| `flipd log <name> [--follow]` | group (or sudo) | `0` printed (or tailing, until `--follow` is stopped); `1` no logs / read error; `2` usage |
| `flipd env <name> build\|deploy [--set K=V] [--unset K]` | sudo | `0` saved; `1` bad key/value, unparseable file, or editor exited non-zero; `2` usage |
| `flipd remove <name>` | sudo | `0` config removed (state, logs and env files are kept — the command prints the `rm` lines for all three); `1` no such repo, or it's running/queued; `2` usage |

`env` with neither `--set` nor `--unset` opens the file in `$EDITOR`
(default `vi`) and re-validates on save. `flipd` never prints a
`WEBHOOK_SECRET`, a private key, or any env-file value — only key names.

## Upgrade flipd

    git -C /opt/flipd pull && sudo systemctl restart flipd

Restarting drops anything mid-build: the in-flight command is killed, its
attempt is logged as `interrupted`, and the in-memory queue is lost. Check
that `flipd status` shows nothing running first.

## Tests

    npm test
