# flipd

Build-on-push for a box you own. Push to a branch; the server fetches, builds,
flips a symlink, and runs your deploy command. One file per repo, one webhook,
no npm dependencies.

Design: the specification was retired from the tree once the build was done,
and is read from history:

    git show 3f493f0:docs/superpowers/specs/2026-09-05-remote-deploy-design.md

## What flipd does not do

- **Poll.** It reacts to pushes. `check`'s exit code is the hook for a
  schedule, and cron is the schedule — see [Every day](#every-day).
- **Post commit statuses.** It holds a deploy key and no API token, by
  decision, and a deploy key cannot write a status. `ON_FAILURE` is the
  substitute: the only signal is the one you wire up.
- **Notify on its own.** Beyond running `ON_FAILURE`, nothing.

## Tests

    npm test
