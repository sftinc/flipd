# test/ — the suite

`node --test`, no framework, no mocks. Root guidance: [../CLAUDE.md](../CLAUDE.md).

    npm test                                  # all of it
    node --test test/run.test.mjs             # one file
    node --test --test-name-pattern="flip"    # by name

## Real things, not doubles

`helpers.mjs` gives you the real environment:

| Helper | What you get |
|---|---|
| `makePrefix()` | A temp tree with `FLIPD_PREFIX` semantics — every path under it, so nothing touches the real `/etc` or `/var` |
| `makeSourceRepo()` | An actual git repo with `.commit({file: contents})`, so fetch, worktree and sha logic run for real |
| `writeMain(p, extra, { publicHost })` | The server conf, with `WEBHOOK_SECRET=testsecret` and `PUBLIC_HOST=deploy.example.com` by default (that key is the HTTP switch — pass `{ publicHost: null }` for a conf with no listener) |
| `writeRepoConf(p, name, kv)` | A repo conf |

Tests start real HTTP servers and real Unix sockets on ephemeral ports. Anything
that spawns a service must `await svc.close()` in a `finally`.

## What a test here is for

Assert the *property*, not the implementation. Two examples worth copying:

- Log-injection tests assert that payload text **cannot become a line** — every
  `events.log` line still starts with a timestamp, no journal line contains a
  newline. They do not assert the text disappears: a log that hides what was sent
  is worse than one that shows it neutralised.
- `install.test.mjs` reads `install.sh` as text and asserts against it. **Never
  execute it** (root-only, no undo). When asserting structure, check nesting and
  not ordering — `spanOf()` exists because "between `log {` and `handle`" also
  passes when a directive has been moved out of the block it belongs in. One
  test goes a step further without crossing the line: it extracts the body of
  `read_secret()` — the function `install.sh` reads `WEBHOOK_SECRET` through —
  and runs *that* against a temp conf file it creates itself. That exercises the
  reader's own behaviour (last assignment wins, whitespace on either side is
  separator rather than value) without ever invoking `install.sh`; the installer
  stays unexecuted, only a few words of shell it happens to contain are.
  `recipe.test.mjs` does the same to the recipe's own copy of that pipeline,
  which is what keeps the two from drifting apart. Neither strips more than the
  trailing newline from the output — a `.trim()` there would pass against a
  reader that leaves whitespace on the value, which is the bug they exist for.

## Before you trust a new test

Run it against the unfixed code and watch it fail. Several assertions in this
suite's history passed against broken implementations, and one asserted something
that could never be true. A test that has never failed has proved nothing.

## Reporting a run

A block of test output presented as a paste must be a paste. Redirect the run to
a file and quote from that file; never retype output from memory, and never
reconstruct a failure you saw earlier — a reconstructed GREEN block and a
hand-typed stack frame both reached a report during the SSH-trigger work, and
both were wrong in ways that took a reviewer re-running the suite to catch. The
code was fine each time, which is the point: the reader of a report cannot tell
a remembered pass from a real one, so a reviewer who trusts it stops re-running
anything. If the output is gone, run it again — it takes 26 seconds.
