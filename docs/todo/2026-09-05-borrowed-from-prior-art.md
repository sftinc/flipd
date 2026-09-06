# Items to steal from prior art

**Status: todo, 2026-09-05.** Each item is something an existing project already
solved, with the source named. This file is the actionable list; the evidence and
reasoning behind it are in the prior-art research, which was retired from the tree
once the build was done and is read from history:

    git show 3f493f0:docs/superpowers/research/2026-09-05-prior-art.md

Nothing here is implemented. Sizes are estimates against the implementation plan,
retired in the same commit and read the same way:

    git show 3f493f0:docs/superpowers/plans/2026-09-05-remote-deploy.md

---

## Tier 1 · Small, clearly worth doing

### [ ] 1 · Initialise submodules after checkout

**From:** Git-Auto-Deploy, `gitautodeploy/wrappers/git.py`. Its update sequence ends
with `git submodule update --init --recursive` on every pull.

**Why:** the spec and the plan have no answer for submodules anywhere. A repository
using one builds from an empty directory and the failure looks like a broken build
rather than a missing feature.

**Change:** in `lib/run.mjs`, step 3, after `git worktree add` succeeds, run
`git submodule update --init --recursive` in the new release directory. It needs the
same `GIT_SSH_COMMAND` environment as the fetch, since submodules over SSH
authenticate separately.

**Watch for:** a submodule pointing at a second private repository needs its own
access. A deploy key reaches exactly one repository, so this is the case where the
shared machine-user key in `KEY` stops being optional. Say so in the docs rather than
letting someone discover it from a fetch failure.

**Size:** one command plus a test with a source repo that has a submodule.

---

### [ ] 2 · Put the attempt id in the webhook response body

**From:** adnanh/webhook, which exposes `response-message`,
`success-http-response-code` and `include-command-output-in-response` precisely so the
provider's delivery log becomes a debugging channel.

**Why:** GitHub's delivery log shows the response body for every delivery it made. The
current reply is `queued <name>`, which is the same for every push. Returning the
attempt id gives a direct trail from a delivery in the GitHub UI to a log file on the
box, and it costs nothing.

**Change:** allocate nothing new. The queue accepts the entry before the response is
written, so reply `queued <name> <attempt-id>` once the attempt id exists, or
`queued <name>` if the id is only allocated at run start. If the latter, consider
moving id allocation to accept time so the response can carry it.

**Watch for:** the attempt id is allocated by creating the log file exclusively, which
happens at step 0, inside the worker. Carrying it in the response means either
allocating earlier or returning the queue position instead. Decide which; do not
invent a second id.

**Size:** small, but touches the ordering between accept and step 0, so decide it
deliberately.

---

### [ ] 3 · Mask known env-file values in run logs

**From:** GitHub Actions `::add-mask::`, which replaces known secret values in log
output rather than trusting the command not to print them.

**Why:** the spec states flipd cannot stop a BUILD from echoing a secret, and then
keeps fifty run logs per repo. flipd knows exactly the values it injected from the
two env files, so the common accident is preventable: `set -x`, a stray `env`, a
failing `curl` printing its `Authorization` header.

**Change:** in `lib/log.mjs`, replace each known value with `***` as each output chunk
is written.

**Watch for:** skip short or low-entropy values. Masking a value of `true` or a
two-character token corrupts the log for no gain. Masking is best-effort and works per
chunk, so a secret split across a chunk boundary survives; keep the honest sentence in
section 6 of the spec rather than claiming the problem is solved.

**Size:** roughly ten lines and a test.

---

### [ ] 4 · Ignore branch-delete pushes

**From:** GitHub's own push payload, `deleted: true`.

**Why:** `git push --delete` on the watched branch matches on ref and `ssh_url`,
queues a run, and fails the fetch because the branch is gone. A routine action
produces a `fetch failed` outcome and an alarming log line.

**Change:** in `lib/hook.mjs`, reply `200 ignored` when `payload.deleted === true`.

**Size:** one line and a test.

---

### [ ] 5 · Point the package-manager cache at a per-repo directory

**From:** settled CI practice. Do not carry `node_modules` between builds, because
`npm ci` deletes it and restored native modules break across Node versions. Do persist
the package manager's download cache.

**Why:** a fresh worktree per release means every push installs from nothing. On a
small box this is minutes per deploy.

**Change:** add `npm_config_cache` and `XDG_CACHE_HOME` to the BUILD environment table
in section 4, pointing at `/var/lib/flipd/<name>/cache/`. Create the directory
alongside `git/` and `releases/`. Step 7's prune must never treat it as a release
candidate.

**Watch for:** this is an addition to the deliberately small environment table, not a
leak of the ambient environment. It does not weaken that decision, but the table is
the place it has to be written down.

**Size:** two environment entries, one directory, one line in prune's exclusion.

---

## Tier 2 · Worth doing, needs a decision first

### [ ] 6 · `ON_FAILURE` command hook

**From:** Deployer's Slack recipe, ArgoCD and Octopus notification subsystems, and
GitHub Actions `failure()`. Every comparable tool has one; flipd has none.

**Why:** this matters more here than for them. After a failed DEPLOY, `pending` stays
set and webhook runs are refused until someone intervenes. That is the right call, and
it converts an unnoticed failure into an unnoticed and sticky one. Pushes then pile up
doing nothing and the only signal is a capitalised word in `flipd status`.

**Change:** one config key, `ON_FAILURE`, run through `sh -c` with `DEPLOY_NAME`,
`DEPLOY_SHA`, the outcome, and the log path in its environment. The operator writes
their own `curl` or `mail` line, which keeps flipd out of the notification business.

**Decide:** whether it fires on every non-`ok` outcome or only on `deploy failed`. A
skip is not a failure. A `fetch failed` from a deleted branch is noise once item 4
lands, but a real fetch failure is worth knowing about.

**Watch for:** it runs as the `flipd` user with the same small environment, and its
own failure must not change the attempt's recorded outcome.

---

### [ ] 7 · Make `flipd check` exit non-zero when behind

**From:** GitHub's documented redelivery flow, which lists deliveries for the past
three days and can replay failed ones. flipd cannot use those endpoints without a
token, which contradicts the deploy-key-only decision, so this is the half that costs
nothing.

**Why:** the non-goals accept that a push arriving while the service is down is lost,
and name `flipd check` as the habit that catches it. A habit is not a mechanism. An
exit code turns the same command into something cron or the box's health watch can
use, with no new code in the service.

**Change:** `check` already prints the branch head beside the live sha and the word
`behind` when they differ. Exit non-zero in that case.

**Decide:** whether a per-repo `POLL=<seconds>` follows. It closes the whole missed
delivery class, including oversized payloads, for roughly fifteen lines and no
dependency, but it contradicts the stated no-polling non-goal. Either implement it or
rewrite that non-goal to say polling is available and off by default.

---

### [ ] 8 · Match `repository.full_name` as well as `ssh_url`

**From:** the hosted platforms, which key on repository identity rather than a URL
string.

**Why:** a rename or transfer changes `ssh_url`. Git over SSH follows GitHub's
redirect so fetches keep working, but the payload carries the new name and stops
matching. flipd answers `200 ignored` and silently stops deploying.

**Change:** match on `ssh_url` or on the `owner/repo` derived from `REPO` against
`repository.full_name`. Separately, write every ignored push to journald with the
`ssh_url` it carried, so the failure is greppable instead of invisible.

**Note:** `HOOK_HOST` already exists so `status` notices a renamed box. This is the
same instinct applied to the repository side.

---

### [ ] 9 · Build anyway on a zero-change push

**From:** Cloudflare build watch paths, which bypass path matching entirely for pushes
with zero file changes, 3000 or more changed files, or 20 or more commits.

**Why:** an empty commit is a common way to force a redeploy, and the `WATCH` filter
would skip it.

**Change:** in step 2, skip the filter when the diff is empty. Consider the large
changeset valve too.

**Note:** flipd's filter is already better than the hosted tools, because it diffs
against the live sha rather than the previous build of the branch, so a watched change
is never lost by being skipped once. Keep that. This is only the escape hatch.

---

## Tier 3 · Write it down, no code

### [ ] 10 · Record the reverse-proxy caveat for source-IP filtering

**From:** adnanh/webhook's documentation, which states plainly that IP whitelist rules
check the proxy's address rather than the client's.

**Why:** flipd sits behind Caddy by default. If source-IP filtering is ever added,
it must read `X-Forwarded-For` and trust it only from the proxy. Recording the trap now
costs a sentence.

### [ ] 11 · State the commit-status non-goal

**From:** Coolify, which posts pending then success or failure back to the commit.

**Why:** flipd cannot, because it holds a deploy key and no API token, by an explicit
decision. That is fine and currently unstated, so it reads as an oversight. Add it to
the non-goals with the reason, and point at item 6 as the substitute.

### [ ] 12 · State that nothing in a release directory survives

**From:** Capistrano's `shared/` with `linked_dirs` and `linked_files`, which exist for
exactly this reason.

**Why:** each build gets a fresh worktree and nothing persists. Anything the deployed
app writes inside its own directory is destroyed by the next deploy or silently
reverted by a rollback. This never bites the aliasroute pattern, where DEPLOY copies
out to `/opt`, and it bites as data loss for anything running from `current`.

**Change:** a stated rule in the spec. A `LINK=` key is the eventual Capistrano-shaped
answer if it turns out to be needed; do not build it before there is a case.

### [ ] 13 · Fix the shared-key documentation

**Why:** a GitHub deploy key attaches to exactly one repository and a second attempt
fails with "Key is already in use". The `KEY` row already says machine-user key and is
correct. The decisions table says "an optional shared key", and `flipd add` always
prints `gh repo deploy-key add`, which walks the operator into that error.

**Change:** make `add` detect a configured shared `KEY` and print the machine-user
instruction instead. State the one-repository-per-deploy-key constraint in the config
table. Item 1 makes this more likely to come up, not less.

---

## Not on this list

Two items in the research document are corrections rather than borrowings, and both
are reproduced there with evidence. They belong ahead of everything above:

- The spec's step 1 fetch leaves the built commit unreachable and git will delete it.
  The plan is already correct; the spec text is the trap.
- The webhook body cap is set below GitHub's documented payload size, so a large push
  is rejected and never deployed.

## Deliberately not stolen

- adnanh/webhook's trigger-rule engine. Boolean composition over matchers is the best
  idea in either project, and it is a general tool solving a general problem. flipd
  matches on signature, repository and branch, and that is the whole requirement.
  Revisit only if a real need appears, such as ignoring pushes from a bot.
- Git-Auto-Deploy's `git fetch` plus `git reset --hard` update sequence. Correct for a
  working-directory model, and made irrelevant by building into a fresh worktree.

## Already right, confirmed by prior art

No action. Recorded so these do not get relitigated.

- The coalescing queue. Git-Auto-Deploy independently arrived at the same semantics
  with two file locks named running and waiting: if running is held, take waiting; if
  waiting is also held, drop the request. That is the run-again-after flag. Two designs
  reaching the same answer separately is the strongest evidence available that it is
  right.
- Timeouts on BUILD and DEPLOY. adnanh/webhook has none anywhere in its source, so a
  hung build hangs forever.
- The serialised worker. adnanh/webhook dispatches a goroutine per request with no
  mutex, so a burst of pushes runs overlapping deploys.
- The doorbell property. Both projects feed payload contents into the commands they
  run. flipd takes the sha from its own fetch.
