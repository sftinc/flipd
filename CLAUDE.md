# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

flipd turns a push into fetch → build → stop → flip → deploy on a server you own.
Single file per module, Node 20+, ESM, **zero npm dependencies** — keep it that way.

## Map

Each directory has its own CLAUDE.md with the detail for that layer. Read the one
for the layer you are changing; this file is the overview and the rules that bind
everywhere.

| Directory | What lives there |
|---|---|
| [`lib/`](lib/CLAUDE.md) | The service: hook listener, queue, the run controller, state, git, logging |
| [`lib/cli/`](lib/cli/CLAUDE.md) | One file per subcommand, all talking to the service over a Unix socket |
| `/etc/flipd/accounts/` | Accounts (`KIND`, `API`, `TOKEN`), one per host, `0600 root`. Only `add` and `account list` read them; the service never does. |
| [`test/`](test/CLAUDE.md) | `node:test`, real git repos and real sockets — no mocking framework |
| `bin/flipd` | Arg parsing, usage text, dynamic import of `lib/cli/<cmd>.mjs`. Adding a command means editing `COMMANDS` here. |
| `install.sh` | Root-only installer. See the rule below — **never run it.** |
| `flipd.service` | The systemd unit the installer writes to `/etc/systemd/system/`. `KillMode=mixed` is load-bearing: `SIGTERM` reaches flipd only, so `run.mjs` kills the build's own process group and records `interrupted` rather than being killed alongside it. `RuntimeDirectory=flipd` is what creates `/run/flipd` for the CLI socket. |
| `flipd.logrotate` | The `/etc/logrotate.d/flipd` policy for every repo's `events.log` — monthly, twelve kept. `create 0640 flipd flipd` is the line that keeps the service able to append after a rotation. |
| `docs/` | One file per reader question — the agent entry point, install, adding a repo, accounts, configuration, build-and-deploy, commands, operating, layout, deploy recipes, serving with Caddy. Indexed by the README, which is the only index. Tracked; nothing scratch goes here. |
| `todo/` | Deferred items, one per file. Yours, git-ignored. See [`todo/CLAUDE.md`](todo/CLAUDE.md). |
| `SERVER.md` | Any box this repo runs on: address, access, hostnames. Git-ignored — **this repo is public.** Absent means no box is set up. |
| `SERVER.example.md` | The shape `SERVER.md` follows, and what [`docs/agent.md`](docs/agent.md) hands an agent for an operator's own box. Tracked, so it carries placeholders and rules and never a real address. |
| `.superpowers/` | Superpowers' own output — `specs/`, `plans/`, `sdd/`. Git-ignored, and the tool prunes it. |

## Commands

    npm test                                  # the whole suite
    node --test test/run.test.mjs             # one file
    node --test --test-name-pattern="flip"    # tests matching a name
    sh -n install.sh                          # the only safe check on the installer

## Rules that override convenience

**Never print a secret.** flipd never prints `WEBHOOK_SECRET`, a forge
`TOKEN`, a private key, or an env-file value — key names only. This binds
journald, the attempt log, `events.log`, stdout, and generated help text
equally. Values of 8+ characters from env files are masked in attempt output
(`MASK_MIN` in `lib/log.mjs`), and anything that came off the wire goes
through `cleanForLog` (`lib/hook.mjs`) before it reaches a log — a newline in
a payload field otherwise forges a log line.
A URL that came from repo content rather than from `REPO` goes through
`redactUserinfo` before it reaches the attempt log — `.gitmodules` is
writable by anyone who can push, and `REPO`'s own refusal of userinfo does
not cover it.

**Never execute `install.sh`.** It runs as root: creates users, writes `/etc`,
installs a systemd unit and Caddy. There is no undo. It is verified statically
only — `sh -n` plus text assertions in `test/install.test.mjs`. A test that runs
it is a defect. That binds an agent working **in this repo**, which is what this
file governs. An agent installing flipd on an operator's own server is a
different act against a different machine; its instructions are
[`docs/agent.md`](docs/agent.md), and running the installer there,
behind that file's confirmation gate, is the job rather than a violation.

**Zero dependencies.** No `npm install`, no lockfile, no runtime packages.

**The listener sits behind a proxy.** In the default install `remoteAddress`
on `:9000` is Caddy, never the client (`LISTEN` can bind elsewhere, and then
it is the client). Any source-address check must read `X-Forwarded-For` and
trust it only when the connection itself came from loopback; trusting it
from anywhere lets any client claim GitHub's address. There is no such
check today — the HMAC is the authentication — and adding one means
deciding who maintains the allowed ranges, which is the part that does
not have a good answer.

**`docs/` is for readers; scratch lives elsewhere.** Superpowers defaults its
output to `docs/superpowers/`; here that is overridden. Specs go to
`.superpowers/specs/YYYY-MM-DD-<topic>-design.md`, plans to
`.superpowers/plans/YYYY-MM-DD-<feature-name>.md`, and the SDD workspace stays
under `.superpowers/sdd/`. Parked work goes in `todo/`. Only `docs/` is
tracked, so anything written into the other two is invisible to a clone —
which is the point: they are working state, not the record.

## Architecture

One process (`flipd serve`, run by systemd) owns everything mutable. It listens on
two sockets and funnels both into a single-worker queue, so no two builds for the
same repo can ever interleave:

    GitHub push ──HTTPS──> Caddy ──> :9000 /deploy ──┐
                                                     ├──> queue (one worker) ──> runEntry()
    flipd <cmd> ──unix socket──> /run/flipd/flipd.sock┘

- **`lib/hook.mjs`** verifies the HMAC before parsing anything, then hands a
  matched repo to the queue. Everything after `verifySignature` journals.
- **`lib/serve.mjs`** wires it together, reconciles state at startup, and matches a
  push to a repo config by identity — host, owner and repo, so case and the
  scp-versus-`ssh://`-with-port spelling do not matter. A repository renamed on
  its forge is matched by its numeric id instead, scoped to the same host when
  both hosts are known.
- **`lib/run.mjs`** is the controller and the file to read first. Phases are
  `fetch → checkout → build → stop → flip → deploy`; a failure before `flip` leaves the
  live release untouched.

**The flip is the heart of it.** `current` is a symlink swapped by `rename()` over
a temp link, so it is atomic. A release becomes `pending` at flip time and only
becomes `live` when `DEPLOY` exits 0. A `pending` that never confirmed blocks the
next webhook build — the operator must `flipd rollback` or `flipd run` — because
silently building over an unconfirmed flip is how a broken deploy gets buried.

**State** (`lib/state.mjs`) is one `state.json` per repo holding `live`,
`previous`, `pending`, `github_id` and the releases map. An unreadable one is a
typed `StateError`, never degraded to an empty state: empty means "no releases",
which would make the next prune delete everything.

## Servers

Any box this repo is exercised on — a test server, a staging box, whatever you
have — is described in `SERVER.md` in the root, which is git-ignored because
**this repository is public.** Its address, access details, hostnames and quirks
go there and never into a tracked file; they were in this file until 2026-09-07.
One `##` block per box, in the shape of
[`SERVER.example.md`](SERVER.example.md) — which is tracked, and is also what
[`docs/agent.md`](docs/agent.md) points an agent at for an operator's server.

**If `SERVER.md` is not present, no box is set up.** Do not infer one, do not go
looking for an address in the git history, and do not create one without being
asked. Everything in this repo can be developed and tested locally — `npm test`
needs no server, and `install.sh` is verified statically (see the rule above).

Two things hold for any box running flipd, and are worth knowing before you
touch one:

- **The service and a deployment are different checkouts.** `/opt/flipd` is the
  running service; each repo flipd deploys lives under `/var/lib/flipd/<name>/`.
  If a box deploys flipd with flipd, those are two copies of this repository,
  and upgrading the service is `git -C /opt/flipd pull && systemctl restart
  flipd` — which no deploy does for you, and which needs `flipd status` idle
  first, or the restart kills a running build and drops the queue.
- **Confirm a change behaviourally, not by reading config.** `caddy validate`
  proves syntax, not that a field path matched.
