# lib/ — the service

Read [`run.mjs`](run.mjs) first. It is the controller: everything else exists to
feed it or record what it did. Root guidance is in [../CLAUDE.md](../CLAUDE.md);
the never-print rule and the zero-dependency rule bind every file here.

## Who calls whom

    serve.mjs ──┬── hook.mjs      HTTP :9000, verifies HMAC, matches a repo
                ├── socket.mjs    unix socket, one JSON line per command
                ├── queue.mjs     one worker, so builds never interleave
                └── run.mjs       the phases; calls git.mjs, exec.mjs, state.mjs, log.mjs

`config.mjs` and `paths.mjs` are read by everything, including the CLI.

## The modules

| File | Contract |
|---|---|
| `run.mjs` | `runEntry(ctx, entry)` — one attempt, start to finish. Also `runOnFailure`, prune, and the rollback target rule. |
| `serve.mjs` | `serve({paths, journal})` starts the service; `reconcile()` fixes state left by a crash; `findRepoFor()` matches a push. |
| `hook.mjs` | `createHookServer(...)`, `verifySignature(...)`, `cleanForLog(value, max)`. |
| `queue.mjs` | `createQueue(runner, {onError})` — serialises work, survives a throwing runner. |
| `state.mjs` | `readState`/`writeState` per repo, `StateError`, `emptyState`. Writes via a uniquely-named temp file then rename. |
| `config.mjs` | Parses both config files. `MAIN_KEYS`/`REPO_KEYS` gate what is accepted; an unknown key is an error. |
| `repourl.mjs` | `parseRepoUrl(url)` → `{host, owner, repo, name}` or null; `repoIdentity(url)` — the host/owner/repo string `findRepoFor` matches on. |
| `forge.mjs` | `createForge({kind, api, token})` — five calls against GitHub or the Gitea family over global `fetch`; `ForgeError`. Used by `cli/add.mjs` only. |
| `paths.mjs` | Every path derives from here. `checkName()` is the only guard against `../` in a repo name — never build a repo path by hand. |
| `git.mjs` | Thin wrappers. `gitOk` throws `GitError`; `redactUserinfo` strips credentials from messages. |
| `exec.mjs` | `runCommand` for BUILD/DEPLOY, `groupKiller` for SIGTERM-then-SIGKILL of the whole process group. |
| `log.mjs` | Attempt logs and `events.log`. `appendEvent` **writes raw** by contract — callers sanitise. |
| `check.mjs` | The worker half of `flipd check`; the CLI half is in `cli/`. |
| `glob.mjs`, `owner.mjs` | WATCH/IGNORE matching; chown to the `flipd` user. |

## Things that look wrong and are not

- **`appendEvent` does no escaping.** Deliberate — a mask belongs to one attempt,
  and this is called from the hook handler and from startup where no attempt is
  open. Callers clean their own values. Adding sanitising inside it would double-
  mask attempt text that is already scrubbed.
- **A corrupt `state.json` refuses rather than resetting.** See the root file.
- **The webhook answers `200` for things that are not successes** (`ignored`,
  a refused pending push). GitHub records a 500 as a failed delivery and will not
  retry it, so a 500 loses the push. Only signature failures get 401. The one
  `503` is `stopping`: the service is shutting down and the push was discarded,
  which is a failed delivery, not a judged one.
- **`run.mjs` is 450 lines.** It is one sequence with one failure model; splitting
  it by phase would spread the state machine across files. Leave it whole.
- **The hook reads `x-github-event` and `x-hub-signature-256` for every forge.**
  Forgejo, Gitea and Gogs send those GitHub names beside their own, with the
  same `sha256=` prefix. Renaming them to `X-Forgejo-*` would break GitHub and
  gain nothing.

## Adding a phase or changing the order

The `phase` variable classifies unexpected errors, `step()`/`done()` write the
attempt log, and `state.pending` is set only inside `flip()`. Any new phase needs
all three, plus a decision about whether a failure in it leaves the live release
intact — which is the property `test/run.test.mjs` exists to pin. STOP (2026-09)
is the worked example: `phase = 'stop'`, `step('stop')`/`done('stop')`, and a
failure that leaves live intact because it lands before `flip()`.
