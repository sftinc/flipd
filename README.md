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

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints). If you set --host after
    # this, `flipd check app` prints the webhook recipe again with the real host.
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

Every key the file accepts is in [The repo file](#the-repo-file); worked
`DEPLOY` commands are in [docs/deploy-recipes.md](docs/deploy-recipes.md).

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
| `/var/lib/flipd/app/key`, `key.pub` | the deploy key `add` generates |
| `/var/lib/flipd/app/git/` | the bare clone, made on the first run, not by `add` |
| `/var/lib/flipd/app/releases/<id>/` | one git worktree per build; `<id>` is the attempt's UTC timestamp plus the short sha |
| `/var/lib/flipd/app/current` | a symlink to the release most recently flipped to, confirmed or not |
| `/var/lib/flipd/app/state.json` | which release is live, previous and pending |
| `/var/log/flipd/app/<id>.log` | one attempt log per build or rollback |
| `/var/log/flipd/app/events.log` | one line per attempt; never pruned by flipd (logrotate keeps twelve months). The `webhook` line carries GitHub's delivery id, so a delivery that matched a repo can be found here with `grep`; one that was ignored (a tag, a deleted branch, no matching repo) carries it in `journalctl -u flipd` instead |

flipd writes nowhere else. Getting the release to wherever it is served from
is `DEPLOY`'s job: see [docs/deploy-recipes.md](docs/deploy-recipes.md).
`/var/lib/flipd/app` is mode `0750`, owned `flipd:flipd`, so nothing running
as another user can read a release in place; the recipes take that into
account.

## The repo file

`/etc/flipd/repos/<name>.conf` is `KEY=value` lines. Blank lines and `#`
comments are ignored; an unknown key is an error. The file is re-read on
every event, so an edit needs no restart. A file that fails to parse is
logged to journald and skipped, and the other repos are unaffected. `REPO`,
`BUILD` and `DEPLOY` are required; everything else has a default.

| Key | Default | Meaning |
|---|---|---|
| `REPO` | required | The URL to fetch. `add` rewrites a GitHub `https://` URL to `git@github.com:owner/repo.git`, because a push is matched to a repo by comparing this value to the payload's `ssh_url`, case-insensitively. A repository renamed on GitHub is matched by its numeric id once one webhook run has recorded it, and `events.log` says to update `REPO`. A URL carrying `user:password@` or `token@` is refused; use the deploy key. |
| `BRANCH` | `main` | The branch to follow. A push to any other branch is answered `ignored`. |
| `ROOT` | `.` | The directory inside the checkout that `BUILD` and `DEPLOY` run in. Relative, no `..`. It does not change where flipd puts files. |
| `BUILD` | required | Run by `/bin/sh -c` in the fresh checkout. A non-zero exit is `build failed`: nothing is flipped and the live release is untouched. |
| `DEPLOY` | required | Run after `current` is flipped to the new release. Exit `0` confirms the release; anything else is `deploy failed`. Run again on rollback. See [docs/deploy-recipes.md](docs/deploy-recipes.md). |
| `ON_FAILURE` | none | Run after every outcome other than `ok` and `skipped`, capped at 60 seconds, in `/var/lib/flipd/<name>`, with `DEPLOY_OUTCOME` and `DEPLOY_LOG` added to the deploy environment. Its own exit code is one `events.log` line and changes nothing. |
| `WATCH` | everything | Space-separated globs. A push whose changed files (since the live release) match none of them is `skipped`. |
| `IGNORE` | none | Globs subtracted from `WATCH`: a changed file matching one does not count. |
| `TIMEOUT` | `1200` | Seconds, applied to `BUILD` and to `DEPLOY` separately. A command still running at the limit is killed and the attempt fails. |
| `KEY` | `/var/lib/flipd/<name>/key` | The private key for the fetch. `add --key` sets it, for a machine user's key shared across repos. A deploy key is accepted by one repository only, so a repo whose submodule is a second private repository needs `--key` with a machine user's key that can read both. |
| `BUILD_ENV_FILE` | `/etc/flipd/env/<name>.build` | Where `BUILD`'s extra environment is read from. |
| `DEPLOY_ENV_FILE` | `/etc/flipd/env/<name>.deploy` | The same for `DEPLOY` and `ON_FAILURE`. |
| `HOOK_HOST` | written by `add` | The `PUBLIC_HOST` at the time `add` ran. `check` prints the webhook recipe with `PUBLIC_HOST` if it is set, otherwise this. |

Globs: `*` matches anything except `/`, `**` anything including `/`, `**/`
zero or more directories, `?` one character. A pattern must match the whole
path from the repo root, so `src/**` covers the tree under `src` and `*.md`
covers only top-level markdown. The filter runs only when there is a live
release to diff against: `flipd run` bypasses it, so does an empty commit,
and if the live sha can no longer be found in the clone (a force-push) flipd
builds rather than guess.

When the checkout contains `.gitmodules`, submodules are initialised
recursively over the same key before `BUILD` runs. A submodule that cannot
be fetched is `checkout failed`, and the live release is untouched.

## What BUILD and DEPLOY see

Both run as the `flipd` user under `/bin/sh -c`, in `releases/<id>/<ROOT>`,
with their output going to the attempt log. The environment is built from
scratch, not inherited from the service:

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/var/lib/flipd`, so npm's cache persists across builds |
| `DEPLOY_NAME` | the repo's name |
| `DEPLOY_REPO` | `REPO` |
| `DEPLOY_BRANCH` | `BRANCH` |
| `DEPLOY_SHA` | the commit being built, or on rollback, flipped to |
| `DEPLOY_PREVIOUS_SHA` | the commit that was live when this attempt started, or empty |
| `DEPLOY_RELEASE_DIR` | absolute path of `releases/<id>` |
| `DEPLOY_RELEASE_ID` | the release id |
| `DEPLOY_ATTEMPT_ID` | the attempt id, which names the log file |
| `DEPLOY_OUTCOME` | `ON_FAILURE` only: `fetch failed`, `checkout failed`, `build failed`, `deploy failed` or `interrupted` |
| `DEPLOY_LOG` | `ON_FAILURE` only: path of the attempt log |

Then every line of the phase's env file, set with
`sudo flipd env <name> build|deploy --set K=V`. flipd's own variables win: an
env file cannot replace `PATH` or `HOME` or set any `DEPLOY_*` name, and a
line that tries is one warning in the attempt log. Both env files are read
once when the attempt opens, and every value of eight characters or more is
masked wherever the attempt's output is written, so a secret a build prints
does not reach a log.

## The server file

`/etc/flipd/flipd.conf` is written by the installer and read once, when the
service starts, so an edit needs `sudo systemctl restart flipd`. Same syntax
as a repo file.

| Key | Default | Meaning |
|---|---|---|
| `LISTEN` | `127.0.0.1:9000` | Where the webhook listener binds. Loopback with Caddy in front, unless you accept push payloads travelling in clear. |
| `PUBLIC_HOST` | none | The name Caddy serves; set by `install.sh --host`. Used only to print the webhook recipe. |
| `WEBHOOK_SECRET` | required | Generated by the installer; the same value goes in GitHub's webhook form. Never printed by flipd. |
| `KEEP` | `5` | Release directories kept after each run, beyond live, previous and pending. Older ones are removed, failed builds included. |
| `LOG_KEEP` | `50` | Attempt logs kept per repo, oldest deleted first. `events.log` is not counted. |
| `LOG_MAX_BYTES` | `52428800` | Cap on one attempt log. A command that prints more has its output cut, not its run. |

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
| `flipd check <name> [--set-remote]` | group (or sudo) | `0` pass, live matches branch head; `4` pass, but live is behind (nothing wrong with the setup, just not deployed yet); `5` pass, but a release is `pending` — flipped to and never confirmed — which outranks `4`; `1` a row failed (bad config, key, or clone); `2` usage; `3` service down (or unreachable — see [Permissions](#permissions)). Also prints the webhook recipe (Payload URL, secret location, `gh api` pipeline) with the current `PUBLIC_HOST`, so it can be read again after `--host` |
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
