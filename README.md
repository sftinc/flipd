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
below without `sudo`. See [Permissions](#permissions).

## Add a repo

With an account for the host (see [Accounts](#accounts)), one command does
the whole setup:

    sudo flipd add https://forge.example.com/team/app --root .
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

`add` generates a read-only deploy key and uploads it, creates the push
webhook with the right URL and secret, and writes `REPO` exactly as the forge
renders it. Without an account for that host, `add` prints the two steps
for you to do instead:

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints). If you set --host after
    # this, `flipd check app` prints the webhook recipe again with the real host.
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

Every key the file accepts is in [The repo file](#the-repo-file); worked
`DEPLOY` commands are in [docs/deploy-recipes.md](docs/deploy-recipes.md).

## Accounts

An account lets `add` configure GitHub, Forgejo or Gitea for you. It is
one access token per host, used only while `add` runs, stored root-only in
`/etc/flipd/accounts/<host>.conf`. The service never reads it, and repos already
added keep working if it is revoked. Save the token in a file with your
editor (not with `echo`, which puts it in your shell history), then:

    sudo flipd account add forge.example.com --kind forgejo < token-file
    sudo flipd account add github.com --kind github < github-token-file
    rm token-file github-token-file
    flipd account list                          # host, kind, api, token: set

The token is read from stdin and nowhere else, so it never appears in `ps` or
in shell history. What it needs:

| Forge | Token | Permissions |
|---|---|---|
| GitHub | fine-grained personal access token, repository access limited to the repos flipd will add | *Metadata: read*, *Administration: write* (deploy keys live there), *Webhooks: write* |
| Forgejo, Gitea | access token (Settings > Applications) of a user who administers those repos | `write:repository` |

*Administration: write* is broad, which is why the token is used once, stored
root-only, and worth revoking after the last `add`; nothing already set up
depends on it. Forgejo and Gitea tokens are user-wide, so use a machine user
where you can.

For a Forgejo or Gitea host, `account add` also records the host's SSH key in
`/var/lib/flipd/.ssh/known_hosts` and prints its fingerprints. Compare them
with the ones the forge publishes before adding a repo. If SSH is not on
port 22 there, pass `--ssh-port`; the key is recorded under `[host]:port`,
which is how the `ssh://` URLs such a forge renders look it up. The API base
defaults to `https://api.github.com` for GitHub and `https://<host>/api/v1`
otherwise; `--api` overrides it and must be `https://`.

The key `account add` records is for the host in the URL — the forge's web
and API host. Forgejo and Gitea have a separate `SSH_DOMAIN` setting, so a
repository's `ssh_url` can name a different one; when it does, `add` names
that host and prints the `ssh-keyscan` command to record it, and its
fingerprint needs the same comparison before the first build.

`flipd account remove <host>` deletes the account. Repos on that host go back
to the manual `add` flow; nothing already added changes.

Forgejo's **Test delivery** button sends a real push for the repository's
head, not a ping, so pressing it starts a build.

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
[Commands](#commands): `0` up to date, `4` behind, `5` a `pending` release
that was flipped to but never confirmed, `1` a failed row, `3` service down.

To catch a lost webhook and deploy anyway:

    flipd check app >/dev/null; [ $? -eq 4 ] && flipd run app

`run` is a forced build, so a catch-up ignores `WATCH` and `IGNORE`. It does
not fire on `5`: a `pending` release is a failed deploy waiting to be looked
at, and rebuilding over it unattended is how it never is. `5` outranks `4`,
so a repo that is both behind and pending stays put until someone runs
`flipd rollback` or `flipd run` by hand.

## Where things live

Every path is keyed by the repo's name, which `add` takes from the URL
(`git@github.com:you/app.git` becomes `app`) unless `--name` says otherwise.
For a repo named `app`:

| Path | What |
|---|---|
| `/etc/flipd/flipd.conf` | the server file — see [The server file](#the-server-file) |
| `/etc/flipd/repos/app.conf` | the repo file `add` writes — see [The repo file](#the-repo-file) |
| `/etc/flipd/env/app.build`, `app.deploy` | extra environment for `BUILD` and `DEPLOY`, written by `flipd env` |
| `/etc/flipd/accounts/<host>.conf` | an account, written by `flipd account add`; root-only, read by `add` and `account list`; the service never does |
| `/var/lib/flipd/app/key`, `key.pub` | the deploy key `add` generates |
| `/var/lib/flipd/app/git/` | the bare clone, made on the first run, not by `add`. flipd's git runs with `HOME=/var/lib/flipd` and does not read `/etc/gitconfig`, so a git setting meant for flipd goes in `/var/lib/flipd/.gitconfig` |
| `/var/lib/flipd/app/releases/<id>/` | one git worktree per build; `<id>` is the attempt's UTC timestamp plus the short sha |
| `/var/lib/flipd/app/current` | a symlink to the release most recently flipped to, confirmed or not |
| `/var/lib/flipd/app/state.json` | which release is live, previous and pending |
| `/var/log/flipd/app/<id>.log` | one attempt log per build or rollback |
| `/var/log/flipd/app/events.log` | one line per attempt; never pruned by flipd (logrotate keeps twelve months). The `webhook` line carries the delivery id, so a delivery that matched a repo can be found here with `grep`; one that was ignored (a tag, a deleted branch, no matching repo) carries it in `journalctl -u flipd` instead |

flipd writes nowhere else. Getting the release to wherever it is served from
is `DEPLOY`'s job: see [docs/deploy-recipes.md](docs/deploy-recipes.md).
`/var/lib/flipd/app` is mode `0750`, owned `flipd:flipd`, so nothing running
as another user can read a release in place; the recipes take that into
account.

## Upgrade flipd

    git -C /opt/flipd pull && sudo systemctl restart flipd

Restarting drops anything mid-build: the in-flight command is killed, its
attempt is logged as `interrupted`, and the in-memory queue is lost. Check
that `flipd status` shows nothing running first.

One behaviour change to know about when upgrading past this version: a
checkout containing `.gitmodules` now initialises its submodules, so a repo
that carries one its build never needed — a docs theme, a vendor directory —
fails with `checkout failed` if the deploy key cannot read it. See the `KEY`
row in [The repo file](#the-repo-file) for the machine-user key that fixes it.

## What flipd does not do

- **Poll.** It reacts to pushes. `check`'s exit code is the hook for a
  schedule, and cron is the schedule — see [Every day](#every-day).
- **Post commit statuses.** It holds a deploy key and no API token, by
  decision, and a deploy key cannot write a status. `ON_FAILURE` is the
  substitute: the only signal is the one you wire up.
- **Notify on its own.** Beyond running `ON_FAILURE`, nothing.

## Tests

    npm test
