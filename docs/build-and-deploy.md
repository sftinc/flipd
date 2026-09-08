# BUILD, STOP and DEPLOY

## The contract

- `DEPLOY` runs as the `flipd` user, under `/bin/sh -c`, with the working
  directory set to `releases/<id>/<ROOT>`: the fresh checkout that `BUILD`
  just passed in. `DEPLOY_RELEASE_DIR` holds the absolute path of the release
  (without `ROOT`).
- By the time it runs, `current` already points at this release. A `DEPLOY`
  that fails leaves `current` pointing at an unconfirmed release, which is
  what `PENDING` in `flipd status` means.
- **The exit code is all flipd believes.** Zero confirms the release: it
  becomes `live`, the old live becomes `previous`. Anything else is
  `deploy failed`: the repo is `PENDING`, webhook-triggered runs are refused
  until `flipd rollback <name>` or `flipd run <name>` settles it, and
  `ON_FAILURE` fires. A warning printed to stderr with exit `0` is a success.
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
  will not finish and the work is not worth waiting for. A webhook push never
  skips it.
- It uses the deploy env file and `TIMEOUT` on its own clock, and is not
  recorded per release: the conf's current `STOP` addresses the process
  running now, and an edit applies to the next attempt. A deploy env file
  that fails to parse fails `STOP` the way it fails `DEPLOY`, with the
  outcome `stop failed`.

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
| `DEPLOY_OUTCOME` | `ON_FAILURE` only: `fetch failed`, `checkout failed`, `build failed`, `stop failed`, `deploy failed` or `interrupted` |
| `DEPLOY_LOG` | `ON_FAILURE` only: path of the attempt log |

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
