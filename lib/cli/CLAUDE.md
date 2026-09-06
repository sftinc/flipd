# lib/cli/ — the subcommands

One file per subcommand, named for the command. `bin/flipd` validates the name
against its `COMMANDS` array and dynamic-imports the matching file, so **adding a
command means editing that array too**. Root guidance: [../../CLAUDE.md](../../CLAUDE.md).

## The shape every command follows

```js
export default async function (args, { paths: p, stdout, stderr, /* …Override */ }) {
  // usage error → 2, failure → 1, success → 0
}
```

Nothing here writes to `process.stdout` directly, and nothing calls `process.exit`
— `bin/flipd` owns both. Streams arrive as parameters so tests can capture them.

## Almost nothing happens here

Commands that touch a repo send a JSON message over the Unix socket and let the
service do the work (`sendCommand` in `../socket.mjs`). Only the service can read
a deploy key or touch a clone without racing a build. `check.mjs` here prints rows;
`../check.mjs` computes them.

The exceptions write config, not state: `add` (writes a repo conf, generates a
deploy key), `env` (edits an env file), `remove` (deletes a conf).

## Testing without a service

Every socket-using command takes an override parameter — `sendOverride`,
`statusOverride` — so tests supply a canned reply instead of standing up a
service. Keep that hook when adding a command; it is why the CLI tests are fast.

## Exit codes are an interface

They are documented in the README's Commands table and scripts depend on them.
`check` returning `4` for "behind" is the load-bearing example: `0` up to date,
`4` behind or unconfirmed, `1` a failed row, `3` service down. Do not renumber.

## The webhook recipe

`recipe.mjs` renders it; `add` and `check` both print it. It must keep the secret
off argv — into `node` through the environment, into `gh api` through `--input -`
on stdin — and `test/recipe.test.mjs` holds those properties at the source. `add`
refuses to run twice, which is why `check` can print the recipe again once
`PUBLIC_HOST` is known.
