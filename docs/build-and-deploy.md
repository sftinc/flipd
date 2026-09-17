# BUILD, STOP and DEPLOY

## The contract

- `DEPLOY` runs as the `flipd` user, under `/bin/sh -c`, with the working
  directory set to `releases/<id>/<ROOT>`: the fresh checkout that `BUILD`
  just passed in. `DEPLOY_RELEASE_DIR` holds the absolute path of the release
  (without `ROOT`).
- By the time it runs, `current` already points at this release. A `DEPLOY`
  that fails leaves `current` pointing at an unconfirmed release, which is
  what `PENDING` in `flipd status` means.
- **The exit code is all flipd believes**, unless `HEALTHCHECK` is set. Zero
  confirms the release: it becomes `live`, the old live becomes `previous`,
  and `ON_SUCCESS` fires.
  Anything else is `deploy failed`: the repo is `PENDING`, pushes and `flipd
  trigger` are refused until `flipd rollback <name>` or `flipd run <name>`
  settles it, and `ON_FAILURE` fires. A warning printed to stderr with exit
  `0` is a success. With `HEALTHCHECK` set, that zero is necessary and no
  longer sufficient: the URL must also answer before the release is confirmed.
- **Rollback runs `DEPLOY` again**, pointed at the old release, with no
  `BUILD`. So the command must work when the release it is handed is older
  than the one currently served, and it must be safe to run twice against the
  same release. It gets the `DEPLOY` and `ROOT` recorded when that release was
  built, not the ones in the conf now, so editing `DEPLOY` affects the next
  build and not a rollback to an old one.
- It has `TIMEOUT` seconds (default 1200) of its own, separate from `BUILD` and `STOP`.
- Everything it prints goes to the attempt log, with env-file values masked.
  Secrets come from `sudo flipd env <name> deploy --set K=V`, never from the
  conf line, which the attempt log quotes in full.
- `/var/lib/flipd/<name>` is mode `0750`, owned `flipd:flipd`. A service
  running as any other user cannot read the release where it sits. Either the
  service runs as `flipd`, or `DEPLOY` copies the release somewhere that user
  can read.
- **Nothing written inside a release directory outlives that release.** The
  next build is a fresh worktree, a rollback points `current` at an older
  one, and prune deletes the directory once it is neither live, previous,
  pending nor among the `KEEP` newest. Anything the served process writes —
  uploads, a SQLite file, a cache — must live outside
  `/var/lib/flipd/<name>/releases/`, and `DEPLOY` is where the symlink or
  copy to that place is made. The copy-out recipes never hit this;
  anything served from `current` does.

## STOP

`STOP` is optional. When set, it runs after `BUILD` has passed and before
`current` is flipped, and on a rollback before the flip, with no `BUILD`.
Its job is to let the process that is serving now finish what it is doing.

- **Exit `0` means the flip may go ahead.** Anything else, including
  `TIMEOUT`, is `stop failed`: nothing is flipped, and `current`, live,
  previous and pending are exactly as they were when the attempt started.
  The built release is kept like any failed attempt, `ON_FAILURE` fires,
  and a push builds again next time. If the attempt started from `PENDING`
  (a `flipd run` or `flipd rollback` is allowed to), it is still `PENDING`.
- **It runs in the release `current` points at**, under that release's
  `ROOT`, so a drain script kept in the repo is the copy that matches the
  process it is stopping. On a first deploy there is no `current`, and it
  runs in the new release instead. `DEPLOY_CURRENT_RELEASE_DIR` and
  `DEPLOY_CURRENT_RELEASE_ID` name that release; `DEPLOY_RELEASE_DIR` and
  the rest name the one the attempt is moving to, as they will for `DEPLOY`
  a moment later. A `current` that points at a release `state.json` no
  longer lists is `stop failed`, with a detail line naming the id, rather
  than guessing where to run.
- **It always runs when set**, first deploy included. Exit `0` when there is
  nothing to stop; `systemctl stop` on an inactive unit already does.
- **Once `STOP` exits `0`, the application is stopped, and stays stopped
  until `DEPLOY` starts it again.** Before this phase existed, the process
  serving now kept serving through anything that happened before `DEPLOY`;
  with `STOP` in the loop, a `DEPLOY` that then fails, or flipd itself being
  killed between the two, is an outage instead. The recovery path still
  works: a rollback runs the target release's `DEPLOY`, which starts the
  application again.
- **flipd never touches the served process.** On `TIMEOUT`, and when the
  service itself is restarted mid-attempt, flipd kills the `STOP` command's
  own process group — `SIGTERM`, then `SIGKILL` ten seconds later — and
  nothing else. A script cut off mid-drain can leave the application drained
  but not stopped, and flipd will not put it back. So a `STOP` script must:
  bound its own wait below `TIMEOUT`; leave the process serving before it
  exits non-zero; trap `SIGTERM` and re-enable within the ten seconds; and
  if it goes through `sudo`, make sure the root helper exits on `SIGTERM`,
  because the `SIGKILL` reaches `sudo` only, and a helper that lingers holds
  the attempt open with it.
- **`flipd run <name> --now` and `flipd rollback <name> --now` skip it** for
  that one attempt and say so in the log. That is the way out when a process
  will not finish and the work is not worth waiting for. Neither a push nor a
  `flipd trigger` ever skips it — there is no `--now` on either door.
- It uses the deploy env file and `TIMEOUT` on its own clock, and is not
  recorded per release: the conf's current `STOP` addresses the process
  running now, and an edit applies to the next attempt. A deploy env file
  that fails to parse fails `STOP` the way it fails `DEPLOY`, with the
  outcome `stop failed`.

## HEALTHCHECK

`HEALTHCHECK` is optional, and it is the answer to the one thing an exit code
cannot tell you: whether the application is actually up. `sudo systemctl
restart app.service` exits `0` when the unit was accepted, not when the app
started serving, so a release that crashes on boot is confirmed live by a
zero that was never about the app at all.

    HEALTHCHECK=http://127.0.0.1:3000/health

When set, flipd requests that URL after `DEPLOY` exits `0` and before the
release is confirmed.

- **Only `2xx` passes.** A refused connection, a timeout and a `5xx` all mean
  the same thing — it has not finished starting — and are retried. A `3xx` is
  reported as the status it is rather than followed: a health endpoint that
  has started redirecting is a fact about the app, not a route to chase.
- **The loop is fixed, and there is no second key for it.** The first request
  goes out immediately, then one a second until a `2xx` answers or the budget
  runs out. The budget is 30 seconds, or `TIMEOUT` when that is shorter, so no
  phase can outlast the repo's own limit. Each request gets 3 seconds.
- **Giving up is `health failed`.** `current` is already flipped by then, so
  the release stays `pending` and unconfirmed — the same state a failed
  `DEPLOY` leaves, because it is the same situation: something is serving that
  has not been proved. Pushes and `flipd trigger` are refused until `flipd
  rollback <name>` or `flipd run <name>` settles it, and `ON_FAILURE` fires
  with `DEPLOY_OUTCOME=health failed`.
- **It runs on rollback too**, like `STOP`, because a rollback is a deploy and
  confirming one without checking is the thing this key exists to prevent. If
  the release you rolled back to does not answer either, the rollback ends
  `health failed` and leaves `pending` set — which is worth knowing, because
  the alternative is being told the rollback worked while the site is down.
- **`flipd cancel` still works during the wait.** A health check is a read, so
  stopping one makes nothing worse, and an attempt is only past the point of
  cancelling once the check has passed. A service **shutdown** during the wait
  is different: the attempt ends `interrupted` with the release still
  `pending`, and the next push is refused until someone settles it. That is
  deliberate — `DEPLOY` exited `0` but nothing ever proved the app answered,
  and a release flipd could not verify must not be confirmed by a restart of
  flipd itself. Restarting the service during a deploy has always been able to
  leave a repo `pending`; `HEALTHCHECK` widens the window it can happen in, so
  wait for `flipd status` to be idle before restarting the service.
- **It must be a full URL.** flipd runs nothing and knows no port, so there is
  nothing for a bare `/health` to be relative to; a value that is not an
  `http://` or `https://` URL is refused when the conf is read, as is one
  carrying `user:password@` or `token@`.
- **It replaces the `curl` loop in `DEPLOY`, not the thinking behind it.** If
  the check needs something other than an HTTP request — a TCP port, a
  `pg_isready` — that still belongs at the end of `DEPLOY`, which is where it
  has always lived.

An endpoint that returns `200` as long as the process is running is worth more
than one that checks nothing, and much less than one that touches whatever the
app needs to actually work — the database handle, the queue connection. The
check is only as good as what the endpoint asserts.

## What BUILD, STOP and DEPLOY see

All three run as the `flipd` user under `/bin/sh -c`, in `releases/<id>/<ROOT>`,
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
| `DEPLOY_CURRENT_RELEASE_DIR` | `STOP` only: absolute path of the release `current` points at, or empty on a first deploy |
| `DEPLOY_CURRENT_RELEASE_ID` | `STOP` only: that release's id, or empty |
| `DEPLOY_ATTEMPT_ID` | the attempt id, which names the log file |
| `DEPLOY_OUTCOME` | `ON_FAILURE` and `ON_SUCCESS` only: `ok`, or `fetch failed`, `checkout failed`, `build failed`, `stop failed`, `deploy failed`, `health failed`, `interrupted` or `cancelled` |
| `DEPLOY_LOG` | `ON_FAILURE` and `ON_SUCCESS` only: path of the attempt log |
| `DEPLOY_RECOVERED` | `ON_SUCCESS` only: `yes` when the attempt before this one failed, `no` otherwise — including a repo's first deploy |

Then every line of the phase's env file, set with
`sudo flipd env <name> build|deploy --set K=V`. flipd's own variables win: an
env file cannot replace `PATH` or `HOME` or set any `DEPLOY_*` name, and a
line that tries is one warning in the attempt log. Both env files are read
once when the attempt opens, and every value of eight characters or more is
masked wherever the attempt's output is written, so a secret a build prints
does not reach a log.

## A DEPLOY command that needs root

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
