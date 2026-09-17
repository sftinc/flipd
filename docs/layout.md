# Where things live

Every path is keyed by the repo's name, which `add` takes from the URL
(`git@github.com:you/app.git` becomes `app`) unless `--name` says otherwise.
The name, not the repository, is the unit: several repo files may name one
repository (a monorepo — see [Several projects in one
repository](adding-a-repo.md#several-projects-in-one-repository)), and each
gets its own clone, releases, state and logs below. For a repo named `app`:

| Path | What |
|---|---|
| `/etc/flipd/flipd.conf` | the server file — see [The server file](configuration.md#the-server-file) |
| `/etc/flipd/repos/app.conf` | the repo file `add` writes — see [The repo file](configuration.md#the-repo-file) |
| `/etc/flipd/env/app.build`, `app.deploy` | extra environment for `BUILD` and `DEPLOY`, written by `flipd env` |
| `/etc/flipd/accounts/<host>.conf` | an account, written by `flipd account add`; root-only, read by `add` and `account list`; the service never does |
| `/var/lib/flipd/app/key`, `key.pub` | the deploy key `add` generates |
| `/var/lib/flipd/app/git/` | the bare clone, made on the first run, not by `add`. flipd's git runs with `HOME=/var/lib/flipd` and does not read `/etc/gitconfig`, so a git setting meant for flipd goes in `/var/lib/flipd/.gitconfig` |
| `/var/lib/flipd/app/releases/<id>/` | one git worktree per build; `<id>` is the attempt's UTC timestamp plus the short sha |
| `/var/lib/flipd/app/current` | a symlink to the release most recently flipped to, confirmed or not |
| `/var/lib/flipd/app/state.json` | which release is live, previous and pending |
| `/var/lib/flipd/app/paused` | present while `flipd pause` is in effect: one JSON line, `since` and `reason`. A marker that cannot be read counts as paused |
| `/var/log/flipd/app/<id>.log` | one attempt log per build or rollback |
| `/var/log/flipd/app/history.jsonl` | one JSON line per attempt, as `state.json`'s `last` was when it closed; trimmed to `LOG_KEEP` lines (all of them at `0`). Read by `flipd history`. Attempts before this file existed are not in it |
| `/etc/flipd/domain.lock` | present only while a `flipd domain` command or a `flipd remove` is running, holding the pid, the command and when it started. Serialises the two writes below, because two of them at once can leave the Caddyfile importing `conf.d` twice — which Caddy refuses to load at all |
| `/etc/caddy/conf.d/flipd-app.caddy` | the site block `flipd domain` renders, and `flipd remove` deletes. Rendered whole from the repo file's `DOMAIN*` keys every time and never read back; the `flipd-` prefix keeps a repo named `flipd` off the installer's own `flipd.caddy` |
| `/var/log/flipd/app/events.log` | one line per event — `webhook`, `queued`, `started`, `refused`, `renamed`, `notified`, `paused`, `resumed` and `cancel` among them, not just one per attempt; never pruned by flipd (logrotate keeps twelve months). The `webhook` line carries the delivery id, so a delivery that matched a repo can be found here with `grep`; one that was ignored (a tag, a deleted branch, no matching repo) carries it in `journalctl -u flipd` instead |

flipd writes nowhere else, with one exception, and it is worth knowing where
the line is. The two `/etc/caddy` rows are the only things flipd writes outside
its own directories, they are written by `flipd domain` and `flipd remove` and
by nothing else, and no build or deploy ever touches them — nothing in that
table changes on a push. `flipd domain` also appends a single
`import /etc/caddy/conf.d/*` line to `/etc/caddy/Caddyfile` the first time it
runs on a box that has none, and never edits that file again. It does not touch
`flipd.caddy`, which belongs to `install.sh --host`.

Getting the release to wherever it is served from is still `DEPLOY`'s job: see
[deploy-recipes.md](deploy-recipes.md).
`/var/lib/flipd/app` is mode `0750`, owned `flipd:flipd`, so nothing running
as another user can read a release in place; the recipes take that into
account.
