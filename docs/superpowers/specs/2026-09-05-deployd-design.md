# deployd — build-on-push for a box you own

**Status: design, 2026-09-05.** Approved section by section in conversation before
this file was written. Nothing is implemented. Owner: Winston.

## 1 · What it is

A single small service that makes a server behave like the "Builds" screen of a
Cloudflare Worker or a Render service: connect a GitHub repository, name a branch, a
root directory, a build command and a deploy command, and every push to that branch
builds and deploys on the server itself.

One box can hold many repositories. Each gets its own config file, its own deploy key,
its own checkout, its own releases, its own logs. The service is one file of Node with
no npm dependencies, installed once per server.

### Decisions already made

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Where the build runs | On the target server itself | GitHub Actions publishing artifacts (a workflow file per repo, and Actions in the path of every deploy); a container per build (Docker on a mail server) |
| What wakes it up | A GitHub webhook | Polling (up to a minute of latency); a self-hosted Actions runner (GitHub's control plane executing on the box, and the heaviest install) |
| How it clones | A read-only deploy key per repo, with an optional shared key | A personal access token (an account credential on the box, and it expires); a GitHub App (JWT minting for a tool meant to stay tiny) |
| Config format | `KEY=value` files | JSON (unpleasant to hand-edit); TOML or YAML (a parser dependency) |
| Webhook path | `/deploy` | `/deployed` reads as a status endpoint |
| Listener exposure | Loopback by default, Caddy in front for TLS | Plain HTTP on all interfaces (payloads and deliveries visible to anyone on the path); TLS inside deployd (certificate handling in a one-file tool) |
| Post-deploy check | None; a DEPLOY command ends with its own health check | A separate VERIFY key (names a pattern DEPLOY can already express, adds a config line) |
| Secrets for commands | Two env files per repo, build and deploy, found by name | One shared file (a deploy credential would sit in the environment of every `npm ci` install script, though the split is hygiene, not a barrier: see section 3) |
| Disk-space check | None | A MIN_FREE refusal (the box's own health watch owns disk, and deployd's own usage is now bounded) |
| Run-log retention | Newest fifty per repo, each capped in bytes | Keep forever by default (unbounded disk on a small box) |
| Run identity | An attempt id per execution, a release id per directory | The sha alone (a forced run at the live sha would replace the directory `current` points at); one id for both (a rollback or a fetch failure has no directory to name) |

**This retires a rule in `aliasroute/mta/deploy/deploy.sh`.** That script says
"nothing is built on the box — there is no npm there, on purpose." Building on the box
is the whole point here, so when aliasroute adopts deployd that comment and the
laptop-side flow it describes are replaced, not left standing beside a contradiction.

### Non-goals for the first version

- No web UI. The CLI and the log files are the interface.
- No TLS termination and no source-IP filtering in deployd. The listener binds to
  loopback by default and Caddy in front does TLS; `install.sh` prints the four-line
  Caddyfile. Anyone who wants the port exposed directly sets `LISTEN` to an
  interface address and accepts that push payloads travel in clear and that
  deliveries can be dropped or replayed by anyone on the path (harmless, by the
  doorbell property in section 5, but visible). GitHub's hook IP ranges change, so
  a source-IP firewall rule is a habit rather than a one-time step.
- No polling fallback. GitHub delivers a webhook once and does not retry on its own,
  and deployd's queue is in memory, so a push that lands while the service is down is
  lost. Recovery is `deployd run <name>`, and `deployd check <name>`, which prints
  the branch head beside the live sha, is the habit that catches it.
- No isolation between repos on one box. Every BUILD and DEPLOY runs as the same
  user, so any repo's build can read any other repo's deploy key and release
  directory. **A box is one trust domain.** Repos that must not trust each other go
  on different boxes.
- No automatic retry of a failed fetch, build or deploy.
- No per-branch preview environments. One branch per config file. A second branch is a
  second config file with a different name.
- No parallel builds. One run at a time on the whole box.

## 2 · On-disk layout

Three trees, so that config is the only thing ever hand-edited, and wiping state never
takes a log with it.

```
/etc/deployd/
  deployd.conf                    # LISTEN, WEBHOOK_SECRET, KEEP, LOG_KEEP, LOG_MAX_BYTES
  repos/
    <name>.conf                   # one per repo; the filename is the repo's name
  env/
    <name>.build  <name>.deploy   # optional secrets for BUILD and for DEPLOY

/var/lib/deployd/<name>/
  key  key.pub                    # the deploy key, generated by `deployd add`
  git/                            # a bare clone; created by `check` or the first run
  releases/<release-id>/          # a fresh worktree per build; the build happens here
  current -> releases/<release-id>  # flipped only after the build passes
  state.json                      # the present: live, previous, pending, last run

/var/log/deployd/<name>/
  events.log                      # one line per event, never pruned by deployd
  <attempt-id>.log                # one file per attempt, complete build and deploy output

/run/deployd.sock                 # the CLI's line to the running service
```

`<name>` is derived from the repository URL (`git@github.com:sftinc/aliasroute.git`
becomes `aliasroute`) unless `--name` is given, and must match
`^[a-z0-9][a-z0-9._-]{0,63}$`; `add` refuses anything else.

**Two ids, because two things need names.** An *attempt* is any execution the
worker performs: a webhook run, a manual run, a rollback, and also a run that ends
in a skip or a fetch failure. A *release* is a directory a successful checkout
produced. Every attempt has a log; only some attempts make a release.

- `<attempt-id>` is the UTC second the attempt started, `2026-09-05T08-14-02Z`,
  with `-2`, `-3` and so on appended when that second is already taken. It is
  allocated by creating the log file exclusively, so two attempts can never share
  one, however fast they follow each other.
- `<release-id>` is `<attempt-id>-<short sha>`, for example
  `2026-09-05T08-14-02Z-5ac3c5a`: the attempt that built it plus what it built.
  Strip the sha and you have the log that built it. The full 40-character sha lives
  in `state.json` beside each release id.

A second build of the same sha therefore gets a second directory, and never
replaces one that `current`, `previous` or a queued rollback points at.

`/etc/deployd` and everything under it is owned `root:deployd`, mode `0750` for
directories and `0640` for files: the service can read config, and nothing running
as `deployd`, which includes every BUILD, can rewrite it.

## 3 · Configuration

### `/etc/deployd/deployd.conf`

```
LISTEN=127.0.0.1:9000
WEBHOOK_SECRET=<generated by install.sh>
KEEP=5
LOG_KEEP=50
LOG_MAX_BYTES=52428800
```

Read once at `deployd serve` start. Changing it means restarting the service.

| Key | Default | Meaning |
|---|---|---|
| `LISTEN` | `127.0.0.1:9000` | Address and port for the webhook listener. Loopback, because Caddy sits in front |
| `WEBHOOK_SECRET` | none, required | The one secret every repo's GitHub webhook is configured with |
| `KEEP` | `5` | Release directories kept per repo, beyond the live and previous ones |
| `LOG_KEEP` | `50` | Run log files kept per repo; `0` means keep all |
| `LOG_MAX_BYTES` | `52428800` (50 MiB) | Cap per run log. Past it, command output is discarded, one `[output truncated at 50 MiB]` line is written, and the command keeps running |

### `/etc/deployd/repos/<name>.conf`

```
REPO=git@github.com:sftinc/aliasroute.git
BRANCH=main
ROOT=mta
BUILD=npm ci && npm test && node deploy/build.mjs
DEPLOY=sudo /usr/local/bin/aliasroute-adopt
WATCH=mta/** packages/**
IGNORE=**/*.md docs/**
BUILD_ENV_FILE=/etc/deployd/env/aliasroute.build
DEPLOY_ENV_FILE=/etc/deployd/env/aliasroute.deploy
KEY=/etc/deployd/machine.key
TIMEOUT=1200
```

Re-read from the directory on every event, so adding or editing a repo needs no
restart. A file that fails to parse is logged to journald and skipped; the other
repos are unaffected.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `REPO` | yes | | SSH clone URL. Matched against the webhook payload's `repository.ssh_url`. Also compared with the bare clone's `origin` on every check and run; a mismatch refuses until `deployd check <name> --set-remote` repoints it |
| `BRANCH` | no | `main` | The one branch that triggers a run |
| `ROOT` | no | `.` | Directory, relative to the repo root, that BUILD and DEPLOY run in. Must be relative with no `..` component |
| `BUILD` | yes | | Run through `sh -c` in `releases/<release-id>/<ROOT>` |
| `DEPLOY` | yes | | Run through `sh -c` in the same directory, after the flip |
| `WATCH` | no | everything | Space-separated globs; a push builds only if a changed file matches one |
| `IGNORE` | no | nothing | Space-separated globs; a changed file matching one does not count |
| `BUILD_ENV_FILE` | no | `/etc/deployd/env/<name>.build` if it exists | A `KEY=value` file whose entries are added to BUILD's environment only |
| `DEPLOY_ENV_FILE` | no | `/etc/deployd/env/<name>.deploy` if it exists | A `KEY=value` file whose entries are added to DEPLOY's environment only |
| `KEY` | no | `/var/lib/deployd/<name>/key` | Private key for the fetch. Set to share one machine-user key across repos |
| `TIMEOUT` | no | `1200` | Seconds allowed for BUILD, and separately for DEPLOY |

### The config parser

`KEY=value`, one per line. Leading and trailing whitespace stripped from both sides.
Lines that are blank or start with `#` are ignored. The value is everything after the
first `=`, taken literally: no quoting, no escaping, no variable expansion. A value
containing `&&` or `$` reaches `sh -c` exactly as typed. Unknown keys are an error,
so a typo like `BUILD_CMD` is caught rather than silently defaulted.

### Env files: secrets for the commands, not for the app

```
/etc/deployd/env/
  <name>.build      # added to BUILD's environment
  <name>.deploy     # added to DEPLOY's environment
```

Same `KEY=value` format, same parser. Found by name, so the ordinary case needs no
config key; `BUILD_ENV_FILE` and `DEPLOY_ENV_FILE` exist for pointing somewhere
else. Owned `root:deployd`, mode `0640`: root writes them, the service reads them.
`sudo deployd env <name> build|deploy` (section 7) creates and edits them with that
ownership so nobody has to remember the path or the mode.

They are split so that a deploy credential is not sitting in the environment of
every dependency's install script during `npm ci`. That is hygiene, not a barrier:
the paragraph below says why. With the split, a private-registry token goes in
`.build` and a `wrangler` token goes in `.deploy`, and neither command has the
other's in its environment.

These files feed the build and deploy *commands*. The application that gets
deployed keeps reading its own configuration the way it does today, for aliasroute
the unit's `EnvironmentFile` under `/etc/aliasroute`; deployd never touches that.

**The limit, stated.** Whatever the `deployd` user can read, every BUILD on the box
can read, because they are the same user. Both env files are therefore visible to
every repo's build. A secret that must be invisible to builds goes where the
aliasroute example already puts it: the DEPLOY command is a sudo'd script, and that
script reads its secret from a root-only path.

### Glob matching

`WATCH` and `IGNORE` patterns are matched against paths relative to the repository
root, not to `ROOT`. `*` matches any run of characters except `/`. `**` matches any
run of characters including `/`. `?` matches one character except `/`. Anything else
is literal. A pattern matches a path only in full. The matcher is a short conversion
to a regular expression; there is no dependency.

## 4 · The run

### The queue

One worker, one queue. An entry is typed: `{kind, name, target}` where `kind` is
`webhook`, `manual` or `rollback`, and `target` is set only for a rollback.

- A **webhook** entry is dropped if a webhook or manual entry for that name is
  already queued *behind every queued rollback for that name*; otherwise it is
  appended. So a push that arrives while a rollback is queued still runs, after the
  rollback, rather than being swallowed by it. If that repo is currently running, a
  "run again after" flag is set on it instead; when the run finishes, one webhook
  entry is queued. Three pushes during a build produce one follow-up run.
- A **manual** entry is dropped if a manual entry for that name is already queued.
  It is never coalesced into a webhook entry, because the two do different things.
- A **rollback** entry is always appended. Its target release is resolved when the
  command is accepted, not when it runs, so a push that lands in between cannot
  change what the rollback flips to, and the target is protected from prune for as
  long as the entry is queued. If there is nothing to roll back to, the command is
  refused at accept time.

There is no priority. Entries run in the order they were accepted.

### State

`state.json` per repo is the present, not a log. It exists so that rollback always
has a truthful target, and so that a crash between a flip and its confirmation is
visible at startup.

```json
{
  "live":     "<release-id whose DEPLOY last succeeded, or null>",
  "previous": "<the live before that, or null>",
  "pending":  "<release-id flipped to but not yet confirmed, or null>",
  "releases": {
    "<release-id>": { "sha": "<40 hex>", "root": "<ROOT>", "deploy": "<DEPLOY>",
                      "built": "<ISO-time>" }
  },
  "last": {
    "attempt": "<attempt-id>",
    "trigger": "webhook | manual | rollback",
    "sha":     "<40 hex, or null when the fetch failed>",
    "release": "<release-id this attempt built or flipped to, or null>",
    "outcome": "ok | build failed | deploy failed | fetch failed | checkout failed | skipped | interrupted",
    "started": "<ISO-time>", "finished": "<ISO-time>", "log": "<absolute path>"
  }
}
```

`live` means *confirmed*: a release whose DEPLOY command exited zero. `current` on
disk can point somewhere else, and when it does, `pending` says where. The
`releases` map records the ROOT and DEPLOY each release was built with, so a
rollback runs the recipe that release was made with rather than whatever the config
says today. Prune removes entries whose directories are gone.

The file is rewritten by writing `state.json.tmp` and renaming over, so a crash
mid-write never leaves a half-truth for the CLI to read.

### Steps

Each step names what a failure leaves behind. A failure at any step ends the run,
writes the outcome to `state.json` and `events.log`, and closes the run log with the
command to type next. **Step 7 runs after every outcome**, including a failure or a
skip, so a string of broken commits cannot fill the disk with release directories.

0. **Open.** An attempt id is allocated by creating the log file exclusively, and
   the header is written. Any stale `current.tmp` left by a crash is removed.

1. **Fetch.** If `git/` does not exist, `git clone --bare` creates it. If it exists,
   its `origin` URL is compared with `REPO`; a mismatch ends the attempt with
   `fetch failed: REPO changed, run deployd check <name> --set-remote`, because
   silently fetching a different repository into a clone full of another one is
   how the wrong bytes get built. Then
   `git fetch origin <BRANCH>` in the bare clone, over SSH with the configured key,
   `IdentitiesOnly=yes`, and a `known_hosts` file holding GitHub's published host
   keys that `install.sh` wrote. The branch head sha is read from the fetch output
   and must be 40 hex characters. *Failure:* nothing on disk changes. Logged as
   `fetch failed`.

2. **Compare.** If the sha equals the sha of the `live` release and the run was not
   forced, stop: `skipped <sha>: already live`. Otherwise, if `WATCH` or `IGNORE` is
   set and there is a live release, run `git diff --name-only <live sha>..<sha>`
   and apply the filter. If no changed file matches, stop: `skipped <sha>: nothing
   changed under <WATCH>`. A forced run ignores both checks. A repo with no live
   release always builds. Comparing against the *live* sha rather than the last
   pushed sha means a change under a watched path is never lost by being skipped
   once; two-dot diff compares trees and does not care whether one sha descends from
   the other, so a force-push or rebase does not confuse it.

3. **Checkout.** The release id is `<attempt-id>-<short sha>`. `git worktree add
   --detach releases/<release-id> <sha>` from the bare clone. A worktree rather than an archive so that a build
   script asking git for the current sha still gets an answer. The directory is new
   by construction, so nothing is removed to make room for it. The release is added
   to `state.releases`. *Failure:* logged as `checkout failed`; nothing else changes.

4. **Build.** `sh -c "$BUILD"` in `releases/<release-id>/<ROOT>`, stdout and stderr
   streamed to the run log, killed at `TIMEOUT` seconds. *Failure:* the release
   directory stays for inspection, `current` is untouched, outcome `build failed`.
   The live service never noticed.

5. **Flip.** `state.pending` is set to `<release-id>` and written to disk *first*.
   Then a temporary symlink `current.tmp -> releases/<release-id>` is created and
   renamed over `current`, so there is no instant at which `current` is absent.
   `live` and `previous` do not move yet.

6. **Deploy.** `sh -c "$DEPLOY"` in the same directory, same streaming, same
   timeout. *Success:* `previous` takes the old `live`, `live` takes `<release-id>`,
   `pending` is cleared, outcome `ok`. *Failure:* `current` stays pointed at the new
   release because the build was good, `live` and `previous` are unchanged,
   `pending` stays set, outcome `deploy failed`, and the last line of the run log is
   `deployd rollback <name>`. This is the one failure that can leave a service
   half-adopted, so it is the loudest: it is the only outcome `deployd status`
   prints in capitals, and while `pending` is set, webhook-triggered runs for that
   repo are refused with an `events.log` line until a rollback or a manual run
   settles it. deployd believes only the exit code; a DEPLOY that prints a warning
   and exits zero is a success.

7. **Prune.** Release directories are listed newest-first. `live`, `previous`,
   `pending`, and the target of any queued rollback are never candidates. Of the rest, the newest `KEEP` are kept and the
   remainder removed with `git worktree remove --force` followed by `rm -rf` of
   anything left, and their `state.releases` entries dropped. Failed-build
   directories are ordinary candidates. Then run logs beyond `LOG_KEEP` are deleted,
   oldest first.

8. **Close.** The log gets its summary line; `events.log` gets `finished
   <attempt-id> <outcome> <duration> <logfile>`; `state.last` is written. Every
   attempt closes this way, including a skip and a fetch failure, so every attempt
   has a log with whatever git or the commands said.

### Rollback

`deployd rollback <name>` resolves its target when accepted: if `pending` is set the
target is `live` (undo the deploy that did not confirm); otherwise the target is
`previous`. It queues an attempt whose steps are 0, 5 and 6, using the target's
stored `root` and `deploy`. Its log is named by its own attempt id and its header
names the target release.

The state update on success is written in terms of the target, not of the role the
target held when the command was accepted, because a run may have completed in
between: `previous` takes whatever `live` is *at execution time* unless that equals
the target, `live` takes the target, `pending` is cleared. Nothing is fetched or
built. If the target is null when accepted, the command refuses and says so; the
target's directory cannot go missing afterwards because prune protects it.

### Killing a command

BUILD and DEPLOY are spawned in their own process group. On timeout, or when the
service receives SIGTERM, the whole group gets SIGTERM, ten seconds of grace, then
SIGKILL, and deployd waits for the child to close before writing the outcome. A
run killed by service shutdown is recorded as `interrupted`.

### Startup

`deployd serve` reads every repo's `state.json`. A non-null `pending` means the
service died between the flip and the confirmation. It is logged to journald and to
that repo's `events.log` as `interrupted <release-id>`, `state.last.outcome` is set
to `interrupted` if it was not already final, and the repo is treated exactly as
after a `deploy failed`: `current` is left where it is, and webhook runs are refused
until a rollback or a manual run settles it. A stale `current.tmp` is removed.

### Environment for BUILD and DEPLOY

Deliberately small. Nothing from the service's own environment leaks through.

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/var/lib/deployd` |
| `DEPLOY_REPO` | the `REPO` value |
| `DEPLOY_BRANCH` | the `BRANCH` value |
| `DEPLOY_SHA` | the sha of the release being built, or on rollback, flipped to |
| `DEPLOY_PREVIOUS_SHA` | the sha of the release that was `live` when this attempt started, or empty |
| `DEPLOY_RELEASE_DIR` | absolute path of `releases/<release-id>` |
| `DEPLOY_RELEASE_ID` | the release id |
| `DEPLOY_ATTEMPT_ID` | the attempt id: on rollback, the rollback's own, not the one that built the release |
| `DEPLOY_NAME` | the repo's `<name>` |

Plus, for BUILD, every entry of its build env file, and for DEPLOY, every entry of
its deploy env file. The run log header lists the key names each command received,
never the values.

### Who it runs as

The service, the fetch, the build and the deploy all run as the `deployd` user. Never
root, so that an `npm ci` pulling an unvetted package never executes with root. A
`DEPLOY` command that must restart a unit or write under `/etc` does so with `sudo`,
and `install.sh` prints the shape of the sudoers line to add: one script, no
password, for the `deployd` user only. The `aliasroute-adopt` example above is that
pattern.

## 5 · The webhook

### The one property everything rests on

The payload is a doorbell, not data. deployd reads two fields from it: which
repository and which branch. The sha that is built comes from deployd's own `git
fetch`, never from the payload. A forged, replayed or tampered webhook can at most
cause a fetch and a build of the real branch head, which is idempotent.

### Listener

One HTTP listener on `LISTEN`, loopback by default, with Caddy in front:

```
deploy.example.com {
    handle /deploy {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        respond 404
    }
}
```

The two `handle` blocks matter: Caddy orders directives by type rather than by
position, and a bare `respond` sorts ahead of `reverse_proxy`, so the shorter form
with both at top level answers every webhook with a 404.

Caddy obtains and renews the certificate on its own, and the webhook URL in GitHub
is `https://deploy.example.com/deploy`. deployd itself speaks plain HTTP and never
sees a certificate. One path, `/deploy`, accepting `POST` only. Anything else is a
404 with an empty body.

### Handling a request

1. The body is read raw, capped at 1 MiB. Over the cap: 413, logged, dropped.
2. `X-Hub-Signature-256` must be present and equal to `sha256=` followed by the
   hex HMAC-SHA256 of the raw body under `WEBHOOK_SECRET`, compared in constant time.
   Missing or wrong: 401, one journald line with the source address, nothing else.
3. `X-GitHub-Event: ping` → 200 `pong`, so the "test delivery" button shows green.
4. `X-GitHub-Event: push` → the JSON body is parsed; `repository.ssh_url` and `ref`
   are read. Every repo config is loaded fresh. A config whose `REPO` equals
   `ssh_url` and whose `BRANCH` equals `ref` with `refs/heads/` stripped is a match.
   A match is queued and answered 202 `queued <name>` immediately; GitHub gives up
   after ten seconds, so the response never waits on a run. No match: 200 `ignored`,
   so a webhook pointed at the wrong server is a log line rather than an error storm.
   A body that is not JSON or lacks those fields: 400.
5. Any other event: 200 `ignored`.

Every accepted push is written to the matching repo's `events.log` as
`webhook <sha-from-payload> <pusher>`; the sha is recorded for the reader's benefit
only and is never used.

### One secret per box

Every repo's GitHub webhook is configured with the same `WEBHOOK_SECRET`. Per-repo
secrets would be one more thing to paste per repo, and the doorbell property means a
shared secret does not widen what an attacker can do.

## 6 · Logging

Three places, each with one job.

**One file per attempt.** `/var/log/deployd/<name>/<attempt-id>.log`, for example
`2026-09-05T08-14-02Z.log`. Plain text, append-only, written as the run happens so a `tail -f` shows a build in
progress. Contents, in order:

- a header: name, repo, branch, trigger (`webhook`, `manual`, `rollback`), start
  time, and once known: sha, previous sha, release id, and the key names loaded
  from each env file
- a timestamped line at the start and end of each step
- the complete stdout and stderr of BUILD and of DEPLOY, interleaved as produced,
  never summarised, and truncated only past `LOG_MAX_BYTES` with a marker line
- a summary: outcome, exit codes, duration
- on failure, the exact command to type next

**One index per repo.** `/var/log/deployd/<name>/events.log`. One line per event:
`<ISO-time> <event> <details>`. Events: `webhook`, `queued`, `started`, `finished`,
`skipped`, `fetch-failed`, `refused`, `interrupted`, `rollback`. Every line about an
attempt names its log file; a skip or a fetch failure has a short one holding what
git said. Never pruned by deployd; `install.sh` drops a logrotate rule that rotates it monthly and keeps
twelve.

**The service talks to journald.** Startup, port bound, each config loaded or
rejected, each webhook rejected with source address and reason, socket commands
received, anything that is about deployd rather than about a repo.

**State is not a log.** `state.json` is described in section 4. It holds the
present and nothing else.

**Secrets.** deployd never prints `WEBHOOK_SECRET`, any private key, or the values
in an env file. It cannot stop a BUILD command from echoing something it should
not; that is the command's responsibility, as in any CI.

## 7 · The CLI

One executable, `deployd`. `serve` is the long-running service; everything else is a
short command.

| Command | Needs the service? | What it does |
|---|---|---|
| `deployd serve` | is the service | Reads `deployd.conf`, binds the listener and the socket, runs the queue |
| `deployd add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C]` | no | Writes `repos/<name>.conf` (unset values as commented placeholders), generates the key, prints the next steps |
| `deployd check <name> [--set-remote]` | no | Parses the config, confirms the key exists, creates the bare clone if missing, and compares the clone's `origin` with `REPO` (refuses on mismatch; `--set-remote` repoints it). Runs `git ls-remote` against `REPO` with the key and prints the branch head sha beside the live sha, with `behind` when they differ. No fetch into the shared clone, so it cannot race a run in progress. No build |
| `deployd run <name>` | yes | Queues a forced run: no same-sha check, no watch filter. Builds into a new release directory even if the sha is already live |
| `deployd rollback <name>` | yes | Resolves the target now and queues a rollback |
| `deployd status [name]` | no | One row per repo: branch, live sha, last outcome and time, queued or running. `PENDING <release-id>` in capitals when a flip is unconfirmed |
| `deployd log <name> [--follow]` | no | Prints the latest run log, or tails the one in progress |
| `deployd env <name> build\|deploy [--set K=V] [--unset K]` | no | Creates the env file if missing (`root:deployd`, `0640`) and opens it in `$EDITOR`, or edits one line with `--set`/`--unset`. Re-parses on save and re-opens on a malformed line. Prints the key names, never the values |
| `deployd remove <name>` | no | Refuses if the service reports that name queued or running; otherwise deletes the config file only and prints the `rm` lines for state and logs |

### What `deployd add` prints

1. The public key, and `gh repo deploy-key add /var/lib/deployd/<name>/key.pub
   -R <owner>/<repo> --title <hostname>` for those with the GitHub CLI.
2. The webhook settings: URL `https://<host>/deploy`, content type
   `application/json`, the secret, event "just the push event", and the equivalent
   `gh api repos/<owner>/<repo>/hooks` command.
3. "Edit `/etc/deployd/repos/<name>.conf`, then run `deployd check <name>`."

### The socket

`/run/deployd.sock`, a Unix socket owned by `deployd:deployd`, mode `0660`. The CLI
sends one JSON line, `{"cmd":"run","name":"aliasroute"}` or
`{"cmd":"rollback","name":"aliasroute"}`, and reads one JSON line back,
`{"ok":true,"queued":true}` or `{"ok":false,"error":"..."}`. Only `run` and
`rollback` use it, because they must go through the queue rather than race a build
already in progress. `status` and `log` read files and work when the service is down;
`status` reports queued-or-running by asking the socket and prints `service down`
if it cannot.

### Permissions

`/etc/deployd` is root-owned, so `add`, `remove` and `env` are run with sudo. `add` creates
the key under `/var/lib/deployd/<name>/` and chowns it to `deployd`, mode `0600`.
Everything else works for any user in the `deployd` group.

## 8 · Install

`git clone` this repository to `/opt/deployd`, then `sudo /opt/deployd/install.sh`.
It:

1. Checks for `node` (20 or newer) and `git`; refuses with a plain message otherwise.
2. Creates the `deployd` system user and group, home `/var/lib/deployd`.
3. Creates the three trees: `/etc/deployd`, `repos/` and `env/` owned
   `root:deployd` mode `0750`; `/var/lib/deployd` and `/var/log/deployd` owned
   `deployd:deployd`.
4. Writes `/etc/deployd/deployd.conf`, `root:deployd` mode `0640`, with a generated
   `WEBHOOK_SECRET` if the file does not exist. Never overwrites an existing one.
5. Writes `/var/lib/deployd/.ssh/known_hosts` from GitHub's published host keys
   (fetched from `https://api.github.com/meta`; refuses if unreachable rather than
   writing an empty file).
6. Installs `deployd.service` (`User=deployd`, `ExecStart=/opt/deployd/bin/deployd
   serve`, `RuntimeDirectory=deployd`, restart on failure) and enables it.
7. Symlinks `/usr/local/bin/deployd` to `/opt/deployd/bin/deployd`.
8. Writes `/etc/logrotate.d/deployd`: `events.log` monthly, keep twelve, compress.
9. Prints the sudoers pattern for deploy commands and the Caddyfile block from
   section 5, with a note that Caddy is a separate install.

Re-running it is safe: every step is skip-if-present.

Upgrading deployd is `git pull` in `/opt/deployd` and `systemctl restart deployd`.
On SIGTERM the service kills the command in progress, records the attempt's outcome
as `interrupted` in its log and in `state.json`, leaves `pending` set if the flip had
happened, and exits. The queue is in memory and is lost. Restart when
`deployd status` shows nothing running.

## 9 · Code shape

```
bin/deployd            # the entry point: parses argv, dispatches to a subcommand
lib/config.mjs         # KEY=value parser; loads deployd.conf and repos/*.conf
lib/glob.mjs           # WATCH/IGNORE pattern → RegExp
lib/state.mjs          # read and atomically write state.json
lib/log.mjs            # run-log and events.log writers
lib/git.mjs            # fetch, rev-parse, diff, worktree add/remove, over the deploy key
lib/run.mjs            # the eight steps, and rollback
lib/queue.mjs          # the deduplicating single-worker queue
lib/hook.mjs           # the HTTP listener and HMAC check
lib/socket.mjs         # the Unix socket server and client
lib/cli/*.mjs          # one file per subcommand
install.sh
deployd.service
```

Each module has one job and can be tested alone: the parser with strings, the glob
with paths, the queue with fake runs, the HMAC check with a known body and secret,
the run steps against a throwaway bare repo created in a temp directory.

## 10 · Testing

Node's built-in test runner, no dependencies, `node --test`.

- **Unit.** Config parser edge cases (blank lines, comments, `=` in values, unknown
  keys). Glob matcher against a table of patterns and paths. Queue dedup and
  run-again-after. HMAC verification with GitHub's documented example. State
  round-trip and atomicity (a crash between write and rename leaves the old file).
- **Integration.** A temp directory holding a bare repo with two commits, a config
  pointing at it over a `file://` URL (the fetch code takes the URL from config, so
  no SSH is needed in tests), and a BUILD and DEPLOY that write marker files. Assert
  the release directory, the `current` target, `state.json`, and the run log after:
  a first run; a same-sha push; a push touching only an ignored path; a failing
  BUILD; a failing DEPLOY followed by a push (the push is refused, `live` and
  `previous` are unchanged); a rollback after each of those; a forced run at the
  live sha (a second directory, `current` moves, the first survives as
  `previous`); two forced runs of the same sha inside one second (two directories,
  two logs, distinct ids); a push that arrives while a rollback is queued (both
  run, in order); a rollback accepted before a webhook run completes (the state
  update is in terms of the target, and `previous` is the release that was live at
  execution); a prune past `KEEP` after a run of failures, with a queued rollback's
  target surviving; a `pending` left in state at startup, with a stale
  `current.tmp` beside it; a `REPO` edit after the clone exists (refused, then
  accepted after `--set-remote`); output past `LOG_MAX_BYTES`.
- **Webhook.** Start the listener on an ephemeral port and post a signed push
  payload, an unsigned one, a ping, and a push for an unknown repo. Assert the
  status codes and what got queued.

Nothing in the test suite touches GitHub, `/etc`, or `/var`.

## 11 · Adopting it in aliasroute

Out of scope for this spec's implementation, recorded so the shape is not lost.

- `mta/deploy/deploy.sh` becomes two things: the parts that run on the box move into
  an `aliasroute-adopt` script invoked as the `DEPLOY` command with sudo (copy
  `dist/` to `/opt/aliasroute/$DEPLOY_RELEASE_ID` rather than to a sha-named
  directory, because a forced rebuild of the live sha must not overwrite the
  directory the units are running from; install units, `daemon-reload`, flip
  `/opt/aliasroute/current`, prune `/opt/aliasroute` as the script does today,
  optional restart, report drift); the laptop-side bundling becomes the `BUILD`
  command. deployd reads only the exit code, so `aliasroute-adopt` must exit
  non-zero whenever it did not leave the box in the state it claims. Today's script
  exits zero on drift without `--restart` by design; that remains fine only if
  "flipped but not restarted" is the state it claims.
- `env-gate.sh` and `preflight.sh` keep their jobs; the gate runs at the top of
  `aliasroute-adopt` so a deploy that should not proceed still does not.
- The "no npm on the box" comment is replaced with a pointer to this design.
