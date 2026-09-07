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

## What you get

| Feature | What it means |
|---|---|
| **Any number of repos on one box** | One conf file and one webhook each, one service for all of them; one worker, so no two builds ever interleave. |
| **GitHub, Forgejo and Gitea** | With an account for the host, `add` generates the deploy key, uploads it, and creates the webhook itself. |
| **Atomic releases** | `current` is swapped by `rename()`, and a failure before the flip leaves the live release untouched. |
| **Rollback that means it** | `flipd rollback` re-runs the `DEPLOY` recorded with that release, not whatever the conf says now. |
| **A failed deploy blocks the next build** | An unconfirmed release stays `pending` until you settle it, so a broken deploy is never buried by the next push. |
| **Path filters and subdirectories** | `WATCH` and `IGNORE` globs and `ROOT`, so one project in a monorepo builds only when its own files change. |
| **Survives a restart** | An interrupted attempt is recorded as interrupted, orphaned release directories are cleaned, and an unconfirmed flip is reported rather than built over. |
| **Config is live** | Repo files are re-read on every event — edit one and the next push uses it, no restart. |
| **Secrets stay out of logs** | Env-file secrets are masked wherever an attempt's output is written; flipd never prints a token, a key, or the webhook secret. |
| **A deploy key per repo, and no API token at runtime** | The forge token is used only while `add` runs, stored root-only, and safe to revoke afterwards. |
| **Webhooks verified before they are parsed** | Constant-time HMAC-SHA256, with a body cap and a connection cap. |
| **No dependency tree** | Zero npm dependencies, by rule; automatic TLS if you let the installer set up Caddy. |

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

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

`add` generates a read-only deploy key and prints it, along with the webhook to
create — Payload URL, where the secret is, and a `gh api` pipeline if you would
rather not click. Adding more than one repo, or on Forgejo or Gitea? Give flipd
an account for the host and `add` does both steps itself:
[docs/accounts.md](docs/accounts.md). Either way,
[docs/adding-a-repo.md](docs/adding-a-repo.md) is the full walkthrough.

## Or let an agent do it

Setup is the fiddly part — a deploy key, a webhook, and a `DEPLOY` command that
actually fits your app. Paste this into a coding agent open in the repo you
want deployed:

    Set up flipd to build and deploy this repo on my server, following
    https://raw.githubusercontent.com/sftinc/flipd/main/docs/agent-setup.md

It reads your project to work out `BUILD` and `DEPLOY`, then sets flipd up on
your box over SSH, stopping to ask before anything that cannot be undone —
the installer, the forge token, and the deploy key and webhook it creates on
your forge. [docs/agent-setup.md](docs/agent-setup.md) is what it follows, and
is worth reading first so you know what it will and will not do.

The same file covers what comes after: upgrading flipd, adding a second repo,
changing a build command, rotating a token, rolling back. Point an agent at it
again for any of those.

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
| [agent-setup.md](docs/agent-setup.md) | pointing a coding agent at your server, to set flipd up and to manage it after |
| [install.md](docs/install.md) | requirements, `install.sh` and what it does to the box, `--host`, upgrading |
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
