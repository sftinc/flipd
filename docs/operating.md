# Operating flipd

    flipd status
    flipd check app
    flipd log app [--follow]
    flipd run app          # build now, ignoring watch/ignore filters
    flipd trigger app --wait   # build as a webhook would, and wait for the outcome
    flipd rollback app     # back to the last confirmed release
    sudo flipd env app build --set NPM_TOKEN=...

`check` is the one to put in cron: it exits `0` when the deploy is confirmed
and live matches the branch head, and non-zero otherwise, so

    flipd check app || notify-me "app needs a look"

catches both a lost webhook and a deploy nobody noticed had failed. To tell
those apart, use the exit code directly — see `check`'s row in
[commands.md](commands.md): `0` up to date, `4` behind, `5` a `pending` release
that was flipped to but never confirmed, `1` a failed row, `3` service down.

To catch a lost webhook and deploy anyway:

    flipd check app >/dev/null; [ $? -eq 4 ] && flipd run app

`run` is a forced build, so a catch-up ignores `WATCH` and `IGNORE`. It does
not fire on `5`: a `pending` release is a failed deploy waiting to be looked
at, and rebuilding over it unattended is how it never is. `5` outranks `4`,
so a repo that is both behind and pending stays put until someone runs
`flipd rollback` or `flipd run` by hand.

`trigger` is the other way to build: it is the webhook as a command, so it
refuses on `pending` and skips when already live, and it does not need the
`check` guard — `flipd trigger app` alone is a safe catch-up. It exists for
a CI job over SSH, where `--wait` also returns the outcome:
[triggering-over-ssh.md](triggering-over-ssh.md).

## Pushing without deploying

Most days are many pushes and no deploy: work in progress, pushed at the end of
the day because a laptop is not a backup. flipd follows exactly one branch, so
the simplest way to keep those apart is to make the branch it follows one you do
not push to by habit:

    BRANCH=deploy

Then `git push` is a backup — the delivery arrives, `main` matches no repo
config, and the journal says `ignored` before anything is queued — and

    git push origin main:deploy

is a deploy. The first one creates the branch. Nothing else changes: the webhook
stays exactly as it is, because it delivers every push and flipd is what ignores
them, and repo files are re-read on every event, so switching a repo that is
already running is the edit and nothing else. `DEPLOY_BRANCH` becomes `deploy`.

Two neighbours, for when that is not the right shape:

- **No webhook at all.** Do not create one, and nothing you push can reach
  flipd; `flipd trigger app --wait` is then the only way in. The strongest
  guarantee there is, at the cost of needing SSH at deploy time —
  [triggering-over-ssh.md](triggering-over-ssh.md).
- **`WATCH` and `IGNORE`.** When the pushes you want ignored are recognisable by
  path rather than by intent — a README, a docs tree — filter on the path
  instead: [configuration.md](configuration.md).
