# Configuration

## The repo file

`/etc/flipd/repos/<name>.conf` is `KEY=value` lines. Blank lines and `#`
comments are ignored; an unknown key is an error. The file is re-read on
every event, so an edit needs no restart. A file that fails to parse is
logged to journald and skipped, and the other repos are unaffected. `REPO`,
`BUILD` and `DEPLOY` are required; everything else has a default.

| Key | Default | Meaning |
|---|---|---|
| `REPO` | required | The URL to fetch. A push is matched to a repo by comparing this value to the payload's `ssh_url` as host/owner/repo, so case, a `.git` suffix and the `git@host:` versus `ssh://git@host:port/` forms do not matter; a URL that is not of that shape (`file://`) is compared as a lowercased string. A repository renamed on its forge is matched by its numeric id once one webhook run has recorded it, scoped to the same host when both hosts are known, and the attempt log says to update `REPO`. `add` rewrites a GitHub `https://` URL to `git@github.com:owner/repo.git` (fetch needs the SSH form) and, with an account, writes the URL the forge itself renders. A URL carrying `user:password@` or `token@` is refused; use the deploy key. |
| `BRANCH` | `main` | The branch to follow. A push to any other branch is answered `ignored`. |
| `ROOT` | `.` | The directory inside the checkout that `BUILD` and `DEPLOY` run in. Relative, no `..`. It does not change where flipd puts files. |
| `BUILD` | required | Run by `/bin/sh -c` in the fresh checkout. A non-zero exit is `build failed`: nothing is flipped and the live release is untouched. |
| `STOP` | none | Run after `BUILD` passes and before the flip, to let the running process finish its work. Exit `0` means it is safe to switch; anything else, including hitting `TIMEOUT`, is `stop failed`: nothing is flipped and `current`, live, previous and pending are exactly as they were. Runs in the release `current` points at (the target on a first deploy), so a script kept in the repo is the copy that matches the process being stopped — which means enabling a relative `STOP` needs the script already present in the current release; the first deploy after adding one is `flipd run <name> --now`. Runs on rollback too. See [build-and-deploy.md](build-and-deploy.md#stop) and [deploy-recipes.md](deploy-recipes.md#draining-before-the-switch). |
| `DEPLOY` | required | Run after `current` is flipped to the new release. Exit `0` confirms the release; anything else is `deploy failed`. Run again on rollback. See [deploy-recipes.md](deploy-recipes.md). |
| `ON_FAILURE` | none | Run after every outcome other than `ok` and `skipped`, capped at 60 seconds, in `/var/lib/flipd/<name>`, with `DEPLOY_OUTCOME` and `DEPLOY_LOG` added to the deploy environment. Its own exit code is one `events.log` line and changes nothing. |
| `WATCH` | everything | Space-separated globs. A push whose changed files (since the live release) match none of them is `skipped`. |
| `IGNORE` | none | Globs subtracted from `WATCH`: a changed file matching one does not count. |
| `TIMEOUT` | `1200` | Seconds, applied to `BUILD`, `STOP` and `DEPLOY` separately. A command still running at the limit is killed and the attempt fails. |
| `KEY` | `/var/lib/flipd/<name>/key` | The private key for the fetch. `add --key` sets it, for a machine user's key shared across repos. A deploy key is accepted by one repository only, so a repo whose submodule is a second private repository needs `--key` with a machine user's key that can read both. |
| `BUILD_ENV_FILE` | `/etc/flipd/env/<name>.build` | Where `BUILD`'s extra environment is read from. |
| `DEPLOY_ENV_FILE` | `/etc/flipd/env/<name>.deploy` | The same for `STOP`, `DEPLOY` and `ON_FAILURE`. |
| `HOOK_HOST` | written by `add` | The `PUBLIC_HOST` at the time `add` ran. With `PUBLIC_HOST` set, `check` prints the webhook recipe using it; with `PUBLIC_HOST` unset and this present, `check` says the webhook is configured off and where it pointed, then prints the SSH recipe. Not written when `add` ran without `PUBLIC_HOST`. |

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

## The server file

`/etc/flipd/flipd.conf` is written by the installer and read once, when the
service starts, so an edit needs `sudo systemctl restart flipd`. Same syntax
as a repo file.

| Key | Default | Meaning |
|---|---|---|
| `LISTEN` | `127.0.0.1:9000` | Where the webhook listener binds. Loopback with Caddy in front, unless you accept push payloads travelling in clear. |
| `PUBLIC_HOST` | none | **The HTTP switch.** Set (by `install.sh --host`, or by hand): the webhook listener binds `LISTEN`, and this is the name in the recipe and in the webhooks `add` creates. Unset: no listener at all — the journal says `webhook listener off` — and deploys arrive over the socket: `flipd trigger` over SSH ([triggering-over-ssh.md](triggering-over-ssh.md)), `run`, `rollback`. Comment it out and restart to turn the webhook off. |
| `WEBHOOK_SECRET` | required with `PUBLIC_HOST` | Generated by the installer; the same value goes in the forge's webhook form. Required only when `PUBLIC_HOST` is set (nothing listens otherwise); `install.sh --host` writes one if the file has none. Never printed by flipd. |
| `KEEP` | `5` | Release directories kept after each run, beyond live, previous and pending. Older ones are removed, failed builds included. |
| `LOG_KEEP` | `50` | Attempt logs kept per repo, oldest deleted first. `events.log` is not counted. |
| `LOG_MAX_BYTES` | `52428800` | Cap on one attempt log. A command that prints more has its output cut, not its run. |
