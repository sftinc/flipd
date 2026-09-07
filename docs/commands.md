# Commands

| Command | Sudo / group needed | Exit codes |
|---|---|---|
| `flipd serve` | run by systemd as `flipd` | runs until `SIGTERM`/`SIGINT` |
| `flipd add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]` | sudo | `0` written; `1` a name/value/config problem, or, with an account, the forge refused a call (the uploaded deploy key and its local files are undone; a webhook this run already created is left in place on the forge and named in the output); `2` usage |
| `flipd account add <host> --kind github\|forgejo\|gitea [--api URL] [--ssh-port N] < token-file` / `account list` / `account remove <host>` | sudo | `0` done; `1` bad host/kind/token, the account already exists or does not, or the host key could not be scanned; `2` usage |
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

## Permissions

`/etc/flipd` is root-owned, so **`add`, `env`, `remove` and `account` need
`sudo`** — the account conf is root-only because it holds a token that can
create webhooks.

`status`, `check`, `run`, `rollback` and `log` don't need `sudo`, but they do
need your account in the `flipd` group (see [install.md](install.md)) — none
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
