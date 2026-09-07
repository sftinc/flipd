# flipd

Build-on-push for a box you own. Push to a branch; the server fetches, builds,
flips a symlink, and runs your deploy command. One file per repo, one webhook,
no npm dependencies.

## How it works

A push arrives as a webhook. flipd fetches, checks out a fresh worktree, runs
`BUILD` in it, and only then flips: `current` is a symlink swapped by `rename()`
over a temp link, so it changes atomically and a build that fails never touches
the live release. `DEPLOY` runs after the flip, and its exit code is the whole
verdict — zero confirms the release, anything else leaves it `pending` and
blocks the next webhook build until someone looks.

## Install

The box needs `git`, `node` 20 or newer, `ssh-keygen` and `curl`.

    git clone git@github.com:sftinc/flipd.git /opt/flipd
    sudo /opt/flipd/install.sh --host deploy.example.com
    sudo usermod -aG flipd <you>        # then a fresh login shell, or `newgrp flipd`

`--host` needs a name that already points at the box; it installs Caddy, wires
TLS, and checks the path with a signed ping. Without it, everything else happens
and the Caddy block is printed to paste by hand. See
[docs/install.md](docs/install.md).

## Add a repo

    sudo flipd account add github.com --kind github < token-file   # once per forge
    sudo flipd add https://github.com/you/app --root .
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

The account is one access token, used only while `add` runs, stored root-only —
with it, `add` uploads the deploy key and creates the webhook for you. Where to
get the token and which scopes it needs are in
[docs/accounts.md](docs/accounts.md). Without an account, `add` prints the
deploy key and the webhook for you to paste instead:
[docs/adding-a-repo.md](docs/adding-a-repo.md).

## Every day

    flipd status
    flipd check app
    flipd log app [--follow]
    flipd run app          # build now, ignoring watch/ignore filters
    flipd rollback app     # back to the last confirmed release
    sudo flipd env app build --set NPM_TOKEN=...

`check` is the one to put in cron — it exits non-zero when the deploy is not
confirmed and live, which catches both a lost webhook and a deploy nobody
noticed had failed. See [docs/operating.md](docs/operating.md).

## Commands

| Command | What it does |
|---|---|
| `flipd serve` | the service, run by systemd |
| `flipd add <git-url>` | set a repo up: deploy key, webhook, conf file |
| `flipd account add\|list\|remove` | the forge token that lets `add` do that for you |
| `flipd check <name>` | verify the setup, and whether live matches the branch head |
| `flipd run <name>` | build now, ignoring `WATCH` and `IGNORE` |
| `flipd rollback <name>` | back to the last confirmed release |
| `flipd status [name]` | what is live, pending and running |
| `flipd log <name>` | the attempt log |
| `flipd env <name> build\|deploy` | extra environment for `BUILD` or `DEPLOY` |
| `flipd remove <name>` | drop the config, keep state and logs |

Flags, exit codes, and which need `sudo`: [docs/commands.md](docs/commands.md).

## Docs

| File | Answers |
|---|---|
| [install.md](docs/install.md) | requirements, `install.sh`, `--host`, upgrading |
| [adding-a-repo.md](docs/adding-a-repo.md) | the `add` walkthrough, both paths |
| [accounts.md](docs/accounts.md) | forge tokens, scopes, host keys |
| [configuration.md](docs/configuration.md) | every key in the repo file and the server file |
| [build-and-deploy.md](docs/build-and-deploy.md) | the contract both run under and the environment they see |
| [commands.md](docs/commands.md) | full reference: flags, exit codes, sudo and the `flipd` group |
| [operating.md](docs/operating.md) | day to day, `check` in cron, what `pending` means |
| [layout.md](docs/layout.md) | every path flipd writes |
| [deploy-recipes.md](docs/deploy-recipes.md) | worked `DEPLOY` commands, one per kind of thing served |
| [serving-with-caddy.md](docs/serving-with-caddy.md) | the site block that makes the app reachable |

## What flipd does not do

- **Poll.** It reacts to pushes. `check`'s exit code is the hook for a
  schedule, and cron is the schedule — see
  [docs/operating.md](docs/operating.md).
- **Post commit statuses.** It holds a deploy key and no API token, by
  decision, and a deploy key cannot write a status. `ON_FAILURE` is the
  substitute: the only signal is the one you wire up.
- **Notify on its own.** Beyond running `ON_FAILURE`, nothing.

## Tests

    npm test

## Design

The specification was retired from the tree once the build was done, and is
read from history:

    git show 3f493f0:docs/superpowers/specs/2026-09-05-remote-deploy-design.md
