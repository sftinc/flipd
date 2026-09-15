# Commands

`flipd <command>` with no arguments prints this list. Exit `2` is always a
usage error; exit `3` is always the service being down or unreachable.

| Command | Needs | Does |
|---|---|---|
| `flipd serve` | systemd, as `flipd` | the service; runs until `SIGTERM`/`SIGINT` |
| `flipd add <git-url>` | sudo | sets a repo up: deploy key, webhook, conf file |
| `flipd account add\|list\|remove` | sudo | the forge token `add` uses |
| `flipd check <name>` | group | verifies the setup and whether live matches the branch head |
| `flipd run <name>` | group | builds now, ignoring `WATCH` and `IGNORE` |
| `flipd trigger <name>` | group | builds as a push would |
| `flipd rollback <name>` | group | back to the last confirmed release, or `--to` an older one |
| `flipd pause <name>` | group | refuse pushes and triggers until `resume` |
| `flipd resume <name>` | group | accept them again |
| `flipd status [name]` | group | one row per repo |
| `flipd history <name>` | group | past attempts, newest first |
| `flipd log <name> [attempt]` | group | an attempt log, the latest by default |
| `flipd env <name> build\|deploy` | sudo | extra environment for `BUILD` or `DEPLOY` |
| `flipd remove <name>` | sudo | deletes the conf file, keeps state and logs |

"group" means your account is in the `flipd` group, or you are root. See
[Permissions](#permissions).

## Flags and exit codes

**`add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]`**
`0` written. `1` a name, value or config problem — or, with an account, a call
the forge refused, in which case the uploaded deploy key and its local files are
undone and a webhook already created this run is left in place and named in the
output.

**`account add <host> --kind github|forgejo|gitea [--api URL] [--ssh-port N] < token-file`**, `account list`, `account remove <host>`
`0` done. `1` a bad host, kind or token, an account that already exists or does
not, or a host key that could not be scanned.

**`check <name> [--set-remote]`**
`0` pass and live matches the branch head. `4` pass, but live is behind —
nothing wrong, just not deployed yet. `5` pass, but a release is `pending`,
flipped to and never confirmed; it outranks `4`. `6` pass, but the repo is
paused; `5` outranks it and it outranks `4`, so the cron catch-up never
force-builds a paused repo. `1` a row failed: config, key
or clone. Two rows worth knowing: `shares`, the other repo files a push to this
repository also builds, and `stale`, a repo file holding this repository's forge
id under a different `REPO` — a rename applied to one and not the other. It also
reprints the setup recipe: the webhook one when the conf has `PUBLIC_HOST`
(Payload URL, where the secret is, a `gh api` pipeline), the SSH trigger one
when it does not.

**`run <name> [--now]`** and **`rollback <name> [--to <release-id|sha>] [--now]`**
`0` the request was handled — stdout says `queued <name>` (or
`queued rollback of <name> to <sha>`) or `not queued: <reason>` when a build for
it is already running or queued, or the service is shutting down. `1` the
service refused it, which means a config error. `--now` skips `STOP` for that
one attempt.

`--to` rolls back to any kept release that was confirmed live at least once,
named by its release id (from `flipd history`) or by a sha of 7 or more hex
characters — the newest confirmed release built from that commit. It is refused,
exit `1`, for a release that never deployed (a failed build or deploy), one no
longer kept (the refusal lists the ones that are), an ambiguous sha prefix, and
the live release when nothing is `pending`.

**`pause <name> [--reason TEXT]`** and **`resume <name>`**
A paused repo refuses pushes (answered `200 refused: paused`, so the forge does
not record a lost delivery) and `flipd trigger` (exit `1`), including a push
already queued when the pause landed; `run` and `rollback` still work. Both
commands are idempotent and exit `0`: a second `pause` keeps the first reason
and says `already paused since …`; `resume` on a repo that is not paused says
so. `1` no such repo; `2` usage; `3` service down. The reason is cut to 200
printable characters. `status` shows a `PAUSED` row and `check` exits `6`.

**`trigger <name> [--wait]`**
The webhook as a command: refused on `pending`, skipped when the branch head is
already live, `WATCH` and `IGNORE` honoured, and no `--now` — CI never gets the
override. Without `--wait`, `0` accepted (queued, or coalesced into work already
accepted — stdout says which) and `1` refused (`pending`, an unreadable
`state.json`, or no such repo) or discarded because the service is stopping.
With `--wait` the session holds until the covering attempt settles: `0` for `ok`
or `skipped`, `1` for a refusal, any other outcome, a crash or a shutdown, and
`3` if the connection closed unanswered — a restart mid-wait, where the build
carries on and `flipd log` has it. Made for a forced-command SSH key:
[triggering-over-ssh.md](triggering-over-ssh.md).

**`status [name] [--json]`**
`0` printed; the activity column reads `service down` when the socket is merely
unreachable. `1` no such repo, nothing configured, or a bare `EACCES` when you
are not in the `flipd` group. `2` usage. `--json` prints
`{ "service": "up"|"down", "repos": [...] }`, one object per repo with `name`,
`branch`, `activity` (`running`, `queued`, `idle`, or `null` when the service is
down), `live`, `previous` and `pending` (each `{ release, sha }` or `null`, shas
in full), `last` as recorded, `warnings`, and `error` — set, with the state
fields `null`, for a conf that will not load or a `state.json` that cannot be
read, so a script never loses a repo from the list.

**`history <name> [--limit N] [--json]`**
Newest first, 20 by default: attempt id, trigger, sha, outcome, duration, and
whether that row's release is `live`, `previous` or `pending` now (`pending`
shown first when a release holds two). An attempt not yet closed reads
`running`. `--json` prints the rows with `role` and `duration_s`. Read from
`history.jsonl` and `state.json`, so it works with the service down. `0`
printed; `1` no history; `2` usage.

**`log <name> [attempt] [--follow]`**
`0` printed, or tailing until you stop it. `1` no logs, no log for that attempt
(pruned, or never existed), or a read error. `2` usage, including an attempt that
is not an attempt id.

**`env <name> build|deploy [--set K=V] [--unset K]`**
`0` saved. `1` a bad key or value, an unparseable file, or an editor that exited
non-zero. With neither `--set` nor `--unset` it opens the file in `$EDITOR`
(default `vi`) and re-validates on save.

**`remove <name>`**
`0` the conf file is gone; state, logs and env files are kept, and the command
prints the `rm` lines for all three. `1` no such repo, or it is running or
queued.

flipd never prints a `WEBHOOK_SECRET`, a private key, or any env-file value —
only key names.

## Permissions

`/etc/flipd` is root-owned, so **`add`, `env`, `remove` and `account` need
`sudo`** — the account conf is root-only because it holds a token that can
create webhooks.

`status`, `check`, `run`, `trigger`, `rollback`, `pause`, `resume`, `history` and `log` don't need `sudo`,
but they do need your account in the `flipd` group (see
[install.md](install.md)) — none of the three directories they touch is
world-readable, on purpose: `/etc/flipd/repos` (mode `0750`, `root:flipd` —
`status` and `check` list repos from it), the Unix socket at
`/run/flipd/flipd.sock` (mode `0660`,
`flipd:flipd` — the only way to reach `run`, `trigger`, `rollback`, and
the deploy key `check` needs), and `/var/log/flipd` (mode `0750`, same
owner — `log` reads from it). Without group membership (and not running as
root):

- `check`, `run`, `trigger`, `rollback` and `log` report `service down` from
  the unreachable socket or an unreadable log directory, indistinguishable
  from the service actually being down;
- `status` fails outright with a bare `EACCES: permission denied, scandir
  '/etc/flipd/repos'` (exit `1`), since it cannot even list the
  configured repos.

If you see either of those but `systemctl status flipd` says the
service is fine, it's almost always a missing group, not a dead service.
