# DEPLOY recipes

flipd fetches, builds, and flips `/var/lib/flipd/<name>/current` to the new
release. It writes nowhere else. Making that release the thing being served is
`DEPLOY`'s job, and this file is a set of `DEPLOY` commands that do it, one per
kind of thing served. The contract every recipe runs under comes first; each
recipe then shows only what differs.

The reference for every conf key and every variable is in the README under
[The repo file](../README.md#the-repo-file) and
[What BUILD and DEPLOY see](../README.md#what-build-and-deploy-see).

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

## Getting root

Most recipes need one privileged step: restart a unit, or write into a
directory `flipd` does not own. The README's
[A DEPLOY command that needs root](../README.md#a-deploy-command-that-needs-root)
gives the rule: passwordless `sudo` for one root-owned script, nothing else.

sudo resets the environment by default, so `DEPLOY_RELEASE_DIR` and the rest
do **not** reach a script run through it. Two ways round that; the first is
simpler.

Pass what the script needs as arguments:

    DEPLOY=sudo /usr/local/bin/app-adopt "$DEPLOY_RELEASE_DIR" "$DEPLOY_SHA"

Or keep the variables, by adding a `Defaults` line to the sudoers file:

    Defaults:flipd env_keep += "DEPLOY_NAME DEPLOY_SHA DEPLOY_PREVIOUS_SHA DEPLOY_RELEASE_DIR DEPLOY_RELEASE_ID DEPLOY_ATTEMPT_ID"
    flipd ALL=(root) NOPASSWD: /usr/local/bin/app-adopt

A sudoers rule that names a command with no arguments allows any arguments,
which is fine here because the script is root-owned and decides for itself
what to do with them. When the privileged step is a single command, name it
in the rule instead of writing a script:

    flipd ALL=(root) NOPASSWD: /bin/systemctl restart app.service

## A systemd service, copied out

The release is copied to a directory the service user can read, the unit is
restarted, and a health check proves it came up. This is the recipe to start
from when the app runs as its own user.

    DEPLOY=sudo /usr/local/bin/app-adopt "$DEPLOY_RELEASE_DIR"

`/usr/local/bin/app-adopt`, `root:root`, mode `0755`:

    #!/bin/sh
    set -eu
    rel="$1"
    [ -d "$rel" ] || { echo "no such release: $rel" >&2; exit 1; }

    # Stage beside the live tree, then swap: the service never sees a half
    # copy, and the swap is one rename.
    rsync -a --delete "$rel/" /srv/app.next/
    chown -R app:app /srv/app.next
    [ -d /srv/app ] && mv -T /srv/app /srv/app.prev || true
    mv -T /srv/app.next /srv/app
    rm -rf /srv/app.prev

    systemctl restart app.service

    # Wait for it, and fail if it does not answer: a restart that crashes
    # immediately would otherwise exit 0 and be recorded as confirmed.
    for i in 1 2 3 4 5 6 7 8 9 10; do
      curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null 2>&1 && exit 0
      sleep 1
    done
    echo "app did not answer on :3000 within 10s" >&2
    exit 1

On rollback the same script runs with the previous release's path, so the
copy and restart put the old code back. Use `ROOT` in the `rsync` source if
the app lives in a subdirectory: `"$rel/mta/"`.

## A systemd service that runs as flipd

If the service runs as the `flipd` user, it can read the release in place and
nothing needs copying. Point the unit at `current`, and `DEPLOY` is just the
restart and the check.

    [Service]
    User=flipd
    Group=flipd
    WorkingDirectory=/var/lib/flipd/app/current
    ExecStart=/usr/bin/node server.mjs
    Restart=on-failure

`WorkingDirectory` is resolved when the unit starts, so each restart picks up
whatever `current` points at now. The conf line:

    DEPLOY=sudo systemctl restart app.service && sleep 2 && curl -fsS -m 5 http://127.0.0.1:3000/health >/dev/null

with the sudoers rule scoped to that one `systemctl` invocation, as in
[Getting root](#getting-root). No script, no root-owned file to maintain.

The trade is that the app's user is also the one holding every repo's deploy
key and env files. Fine for one app on a box you own; not for an app that
runs untrusted input.

## A static site

Nothing to restart. The build produced a directory of files, and `DEPLOY`
puts them where the web server's root is. If that directory is writable by
`flipd` (owned by `flipd`, or group `flipd` with mode `2775`), no `sudo` is
needed at all:

    BUILD=npm ci && npm run build
    DEPLOY=rsync -a --delete dist/ /var/www/example.com/

`rsync --delete` mirrors the release, so a rollback removes files the newer
release added. Caddy and nginx serve the new files on the next request; no
reload.

For a swap with no half-copied moment when the site is large, keep the web
root a symlink, copy each release into its own directory, and repoint:

    DEPLOY=rsync -a dist/ "/var/www/releases/$DEPLOY_RELEASE_ID/" && ln -sfn "/var/www/releases/$DEPLOY_RELEASE_ID" /var/www/example.com.tmp && mv -T /var/www/example.com.tmp /var/www/example.com

`ln -sfn` onto a temporary name and then `mv -T` over the real one is one
atomic rename, so no request sees a missing root. Rollback re-runs this with
the old release id and the old copy is still there. The copies accumulate;
flipd prunes only its own `releases/`, so add a line to remove
`/var/www/releases/*` older than a few days, or accept the disk use. At that
length the command belongs in a script under `/usr/local/bin`, which needs no
`sudo` if `flipd` owns everything it touches.

## A process manager owned by flipd

`pm2`, `forever` and the like keep their daemon per user. When the daemon
runs as `flipd`, `DEPLOY` needs no privilege:

    DEPLOY=pm2 reload app --update-env || pm2 start server.mjs --name app

`pm2 reload` restarts from the process's recorded working directory, which was
the release directory of the *first* start. Pass the path explicitly so each
release is picked up:

    DEPLOY=pm2 delete app >/dev/null 2>&1; pm2 start "$DEPLOY_RELEASE_DIR/server.mjs" --name app && sleep 2 && curl -fsS -m 5 http://127.0.0.1:3000/health >/dev/null

The `pm2` daemon must outlive the attempt. flipd kills the whole process
group of a `DEPLOY` that times out, so a daemon started *by* `DEPLOY` dies with
it. Start the daemon once, by hand or from a systemd unit for the `flipd`
user, before the first deploy.

## Docker Compose

`BUILD` builds the image so a broken Dockerfile fails before the flip;
`DEPLOY` recreates the container from it.

    BUILD=docker compose build
    DEPLOY=docker compose up -d --no-build && sleep 3 && curl -fsS -m 5 http://127.0.0.1:8080/health >/dev/null

This needs `flipd` in the `docker` group, which is root-equivalent: anyone
who can run `docker` can mount `/` into a container. It is the same trust as
the sudo rule, granted a different way. `compose` derives the project name
from the directory, and every release is a different directory, so pin it in
`compose.yaml` (`name: app`) or every deploy starts a second copy instead of
replacing the first.

## Something that needs no privilege at all

When the served thing is read straight from `current` by a process that is
already running as `flipd` and re-reads on its own (a worker that scans the
directory, a cron job, a `node --watch`), `DEPLOY` can be a bare check:

    DEPLOY=test -f "$DEPLOY_RELEASE_DIR/package.json"

`DEPLOY` is a required key, so `DEPLOY=true` is the minimum. The conf `add`
writes has it commented out as a placeholder, and `flipd check` fails with
`DEPLOY is required` until it is filled in.

## Health checks

Every recipe above ends by asking the service whether it is up. That line is
the one to keep. A restart that succeeds and a process that crashes a second
later are indistinguishable to `systemctl restart`, and both exit `0`. Without
the check, flipd confirms a release that is not serving, `flipd status` shows
it green, and nothing notices until a person does.

- Use `-f` so an HTTP error is a non-zero exit, `-m` for a per-request cap,
  and a loop with a bound, so a slow start is not a failure but a dead one is.
- Check something the new code answers, not a front proxy that returns `200`
  from cache.
- Keep the whole thing under `TIMEOUT`. A check that can wait longer than the
  cap is killed by it, and the outcome is the same `deploy failed`.

## Notifying on failure

`ON_FAILURE` runs after any outcome other than `ok` and `skipped`, so it fires
for a failed fetch (a revoked key), a failed build, a failed deploy, and a
build cut off by a restart. It gets the deploy environment plus
`DEPLOY_OUTCOME` and `DEPLOY_LOG`, has 60 seconds, and its own result changes
nothing.

    ON_FAILURE=curl -fsS -m 10 -d "$DEPLOY_NAME: $DEPLOY_OUTCOME at ${DEPLOY_SHA:-?}  see $DEPLOY_LOG" https://ntfy.sh/<topic>

A Slack incoming webhook wants JSON:

    ON_FAILURE=curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"text\":\"$DEPLOY_NAME: $DEPLOY_OUTCOME ($DEPLOY_SHA)\"}" "$SLACK_URL"

with `SLACK_URL` set by `sudo flipd env app deploy --set SLACK_URL=...`, so
it is masked in the logs rather than quoted in the conf. `DEPLOY_SHA` is
empty when the fetch itself failed, and `DEPLOY_RELEASE_ID` is empty when no
checkout happened (`DEPLOY_RELEASE_DIR` then names the `releases/` directory
itself), so quote them.

## Trying a DEPLOY

Edit the conf, then:

    flipd run app
    flipd log app --follow

`run` bypasses `WATCH`, so it builds even with nothing new. If the deploy
fails, `flipd status app` shows `PENDING` and the log ends with the rollback
line. `flipd rollback app` runs the previous release's `DEPLOY`, which is the
one that already worked. Fix the conf, then `flipd run app` again.

If the rollback target's `DEPLOY` is the broken one too (the very first
release, or two bad deploys in a row), fix whatever the command touches by
hand, then `flipd run app`: a run that confirms clears `PENDING` just as a
rollback does.
