# remote-deploy

Build-on-push for a box you own. Push to a branch; the server fetches, builds,
flips a symlink, and runs your deploy command. One file per repo, one webhook,
no npm dependencies.

Design: `docs/superpowers/specs/2026-09-05-remote-deploy-design.md`.

## Install (once per server)

    git clone git@github.com:sftinc/remote-deploy.git /opt/remote-deploy
    sudo /opt/remote-deploy/install.sh --host deploy.example.com

`--host` needs a name that already points at the box; it installs Caddy, wires
TLS, and checks the path with a signed ping. Without it, everything else
happens and the Caddy block is printed to paste by hand.

The installer's last step prints a `sudo usermod -aG remote-deploy <you>`
line — run it (and start a fresh login shell, or `newgrp remote-deploy`) so
your own account can use the commands below without `sudo`. See
[Permissions](#permissions).

## Add a repo

    sudo remote-deploy add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the two gh lines)
    sudo vi /etc/remote-deploy/repos/app.conf        # BUILD and DEPLOY
    remote-deploy check app

## Every day

    remote-deploy status
    remote-deploy check app
    remote-deploy log app [--follow]
    remote-deploy run app          # build now, ignoring watch/ignore filters
    remote-deploy rollback app     # back to the last confirmed release
    sudo remote-deploy env app build --set NPM_TOKEN=...

`check` is the one to put in cron: it exits `0` when the deploy is confirmed
and live matches the branch head, and non-zero otherwise, so

    remote-deploy check app || notify-me "app needs a look"

catches both a lost webhook and a deploy nobody noticed had failed. To tell
those apart, use the exit code directly — see `check`'s row in
[Commands](#commands): `0` up to date, `4` behind (or unconfirmed), `1` a
failed row, `3` service down.

## Permissions

`/etc/remote-deploy` is root-owned, so **`add`, `env` and `remove` need
`sudo`.**

`status`, `check`, `run`, `rollback` and `log` don't need `sudo`, but they do
need your account in the `remote-deploy` group (the install step above) — they
either talk to the Unix socket at `/run/remote-deploy/remote-deploy.sock`
(mode `0660`, owner `remote-deploy:remote-deploy`) or read
`/var/log/remote-deploy` (mode `0750`, same owner), and neither is
world-readable on purpose: that socket is the only way to reach `run`,
`rollback` and the deploy key `check` needs. Without group membership (and not
running as root), `status` and `check` report the same `service down` you'd
see if the service had actually crashed — if you see that but
`systemctl status remote-deploy` says otherwise, it's almost always a missing
group, not a dead service.

## Commands

| Command | Sudo / group needed | Exit codes |
|---|---|---|
| `remote-deploy serve` | run by systemd as `remote-deploy` | runs until `SIGTERM`/`SIGINT` |
| `remote-deploy add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]` | sudo | `0` written; `1` a name/value/config problem; `2` usage |
| `remote-deploy check <name> [--set-remote]` | group (or sudo) | `0` pass, live matches branch head; `4` pass, but live is behind (nothing wrong with the setup, just not deployed yet); `1` a row failed (bad config, key, or clone); `2` usage; `3` service down (or unreachable — see [Permissions](#permissions)) |
| `remote-deploy run <name>` | group (or sudo) | `0` request handled (see stdout: `queued <name>` or `not queued: <reason>` if a build for it is already running/queued/the service is shutting down); `2` usage; `3` service down |
| `remote-deploy rollback <name>` | group (or sudo) | same as `run`, printing `queued rollback of <name> to <sha>` or `not queued: <reason>` |
| `remote-deploy status [name]` | none (activity column needs group/sudo, or shows `service down`) | `0` printed; `1` no such repo / nothing configured |
| `remote-deploy log <name> [--follow]` | group (or sudo) | `0` printed (or tailing, until `--follow` is stopped); `1` no logs / read error; `2` usage |
| `remote-deploy env <name> build\|deploy [--set K=V] [--unset K]` | sudo | `0` saved; `1` bad key/value, unparseable file, or editor exited non-zero; `2` usage |
| `remote-deploy remove <name>` | sudo | `0` config removed (state, logs and env files are kept — the command prints the `rm` lines for all three); `1` no such repo, or it's running/queued; `2` usage |

`env` with neither `--set` nor `--unset` opens the file in `$EDITOR`
(default `vi`) and re-validates on save. `remote-deploy` never prints a
`WEBHOOK_SECRET`, a private key, or any env-file value — only key names.

## Upgrade remote-deploy

    git -C /opt/remote-deploy pull && sudo systemctl restart remote-deploy

Restarting drops anything mid-build: the in-flight command is killed, its
attempt is logged as `interrupted`, and the in-memory queue is lost. Check
that `remote-deploy status` shows nothing running first.

## Tests

    npm test
