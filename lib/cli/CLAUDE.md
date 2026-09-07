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
deploy key), `env` (edits an env file), `remove` (deletes a conf), `account`
(writes an account). `add` is also the one command that talks to a forge's
API: when `/etc/flipd/accounts/<host>.conf` exists for the URL's host it uploads
the key and creates the webhook itself (`lib/forge.mjs`). A later failure
undoes the uploaded key, the local key files it generated, and the conf if it
got as far as being written, but leaves a webhook it created in place — named
in the failure output — because a leftover hook has no secret to leak and the
next `add` finds and reuses it by URL, while a re-uploaded key would be
rejected as a duplicate; otherwise it prints the recipe as before. A URL
carrying a credential in its userinfo is refused before anything is written,
on both paths — the same rule `parseRepo` holds `REPO` to when a conf is read
back (`credentialInUrl` in `lib/config.mjs`). On the forge path, a `ssh_url`
whose host differs from the account's (a forge's own SSH_DOMAIN setting can
do this) is not fetchable with the host key `account add` scanned, so `add`
names it and prints the `ssh-keyscan` command to record it — it never scans
that host itself; a fingerprint has to be compared by a person.

## Testing without a service

Every socket-using command takes an override parameter — `sendOverride`,
`statusOverride` — so tests supply a canned reply instead of standing up a
service. Keep that hook when adding a command; it is why the CLI tests are fast.
`add` takes `forgeOverride` and `account` takes `keyscanOverride` for the same
reason.

## Exit codes are an interface

They are documented in `docs/commands.md` and scripts depend on them.
`check` returning `4` for "behind" is the load-bearing example: `0` up to date,
`4` behind, `5` an unconfirmed `pending` release (outranks `4`: the cron
catch-up in `docs/operating.md` keys on `4`, and must not force-build over a
failed deploy), `1` a failed row, `3` service down. Do not renumber.

## The webhook recipe

`recipe.mjs` renders it; `add` and `check` both print it. It must keep the secret
off argv — into `node` through the environment, into `gh api` through `--input -`
on stdin — and `test/recipe.test.mjs` holds those properties at the source. `add`
refuses to run twice, which is why `check` can print the recipe again once
`PUBLIC_HOST` is known.
