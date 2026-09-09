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
  passes when a directive has been moved out of the block it belongs in.

## Before you trust a new test

Run it against the unfixed code and watch it fail. Several assertions in this
suite's history passed against broken implementations, and one asserted something
that could never be true. A test that has never failed has proved nothing.
