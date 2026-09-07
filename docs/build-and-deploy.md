# BUILD and DEPLOY

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
- It has `TIMEOUT` seconds (default 1200) of its own, separate from `BUILD`.
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

## What BUILD and DEPLOY see

Both run as the `flipd` user under `/bin/sh -c`, in `releases/<id>/<ROOT>`,
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
| `DEPLOY_ATTEMPT_ID` | the attempt id, which names the log file |
| `DEPLOY_OUTCOME` | `ON_FAILURE` only: `fetch failed`, `checkout failed`, `build failed`, `deploy failed` or `interrupted` |
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
