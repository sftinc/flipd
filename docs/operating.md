# Operating flipd

    flipd status
    flipd check app
    flipd log app [--follow]
    flipd run app          # build now, ignoring watch/ignore filters
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
