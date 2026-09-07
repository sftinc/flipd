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

    git clone git@github.com:sftinc/flipd.git /opt/flipd
    sudo /opt/flipd/install.sh --host deploy.example.com

`--host` needs a name that already points at the box; it installs Caddy, wires
TLS, and checks the path with a signed ping. Without it, everything else
happens and the Caddy block is printed to paste by hand.

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
