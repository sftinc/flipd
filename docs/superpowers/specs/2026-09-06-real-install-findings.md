# Gaps found by installing and running flipd on a real server

**Status: opened 2026-09-06.** Every item here was produced by installing flipd on a
live box and using it, not by reading other projects. Each names the install that
surfaced it, so a reader can tell observed evidence from speculation. Most are about
what the running system fails to tell its operator, rather than what it computes
wrongly -- the class of defect a test suite does not reach.

Three sections. **Open** is the backlog, with a checkbox each. **Fixed during the
install** records what was found and corrected on the spot, with the commit. **Not a
defect** records what was investigated and deliberately left alone, so the same
question is not re-run by the next person who notices it.

The install: Ubuntu 26.04 on a 2 GB Hetzner box, 2026-09-06. Node 22.22.1 from the
distribution. `install.sh` run first without `--host`, then again with a public name
resolving directly to the box (Cloudflare DNS, proxy off) and Caddy terminating TLS.
Deploy key and webhook registered by hand in the GitHub UI. The repo under test was
flipd itself, `BUILD=npm test`, `DEPLOY=true`.

The prior-art list is separate: `docs/todo/2026-09-05-borrowed-from-prior-art.md`.

---

## Open

### [x] 1 · Log every post-verification arm of the webhook handler

**From:** this install. The webhook was registered by hand and the obvious next
question -- "did it arrive?" -- could not be answered from the server at all. It had:
GitHub's ping reached flipd and verified correctly, but proving that took a `log` block
added to the Caddy site by hand and a Redeliver from the GitHub UI.

**Why:** `lib/hook.mjs` logs every *rejection* -- oversized body, unreadable body, bad
signature, no matching repo -- and a push that matches a repo logs `webhook ok`
downstream. But six arms return *after the signature has verified* and write nothing:

| Arm | Reply |
|---|---|
| `event === 'ping'` | `200 pong` |
| `event !== 'push'` | `200 ignored` |
| body is not JSON | **`400 not json`** |
| missing `repository.ssh_url` or `ref` | **`400 missing ...`** |
| ref is not `refs/heads/*` (a tag) | `200 ignored` |
| `payload.deleted === true` | `200 ignored` |

The two `400`s are the serious half. Those are genuine failures from a sender who
holds the correct secret, and they leave no server-side record. If GitHub changed its
payload shape, every delivery would show red in GitHub's UI and the server would be
silent about why.

The `ping` arm is the one the operator meets first. Its silence cannot distinguish a
correct secret (accepted, unlogged) from a webhook never saved, a DNS record still
pointing at a proxy, or a proxy that never forwarded. The one case that *is* visible
from the journal is a wrong secret, because that logs a rejection -- so the single
failure the operator can diagnose is the one they are least likely to have.

**Change:** one `journal` call per arm, beside the rejection lines that already exist in
the same function. `from` and `journal` are already in scope there. Log the event
name, the source IP, and for a push the repo and branch -- fields, never the body.

**Watch for:** two things, both the same discipline as the never-print rule.

- The body is attacker-influenced until the HMAC has been checked, so every one of
  these lines must sit *after* `verifySignature`, and none may quote the body. They
  all already do sit after it; keep them there.
- `x-github-event` is a free-form header. It is authenticated by the time these lines
  run, but it is still bytes headed for journald, and a newline in it forges a log line.
  Bound its length and strip control characters before logging it.

The signature header is derived from the secret and must never be logged.

**Size:** six one-line journal calls, one small sanitiser, one test per arm.

**Done:** 03a2572. All six arms plus the pre-existing no-match arm; `cleanForLog` bounds and strips every wire value.

---

### [x] 2 · Say that `install.sh` does not install Node

**From:** this install. `apt-get install nodejs` on Ubuntu does not pull `npm`, so a
`BUILD=npm test` failed with exit 127 and `/bin/sh: 1: npm: not found` on an otherwise
correct install.

**Why:** `install.sh` checks for node and exits with `node 20 or newer is required`, which
is right -- provisioning a runtime is not its job. But the README's install section does
not say a runtime is a prerequisite, so the first thing a new operator meets is a build
failure whose cause is upstream of flipd entirely.

flipd itself behaved correctly throughout: fetch and checkout succeeded, the build
failed, and it did not flip. `current` was absent afterwards, which is the whole point.
The defect is in the documentation, not the machinery.

**Change:** in the README's install section, state the prerequisites `install.sh` already
enforces -- git, node >= 20, ssh-keygen, curl -- and note that on Debian/Ubuntu `npm` is
a separate package from `nodejs`, needed only if a BUILD command uses it.

**Size:** a few lines of README.

**Done:** 06f95fc. The first draft repeated this document's own error and said the installer checks `curl`; it does not, and the text now separates the three it guards from the one it does not.

---

### [x] 3 · Reconsider the sudoers hint printed on every install

**From:** this install, observed but not acted on.

**Why:** `install.sh` prints a ready-to-paste line granting the `flipd` user passwordless
root for a named script. It is correctly scoped to one path and clearly labelled, but it
is printed on every run, including runs where nothing needs root -- so the most
security-sensitive suggestion in the tool is also the most repeated, which is how a
paste-ready line stops being read.

**Change:** print it only when a repo config actually references `sudo` in DEPLOY, or
move it to the README and reference it by name from the install output.

**Watch for:** this is a judgement call, not a defect -- the current behaviour is
defensible and the line is not wrong. Decide before changing it.

**Size:** one conditional, or a documentation move.

**Done:** 075a46b. Decided: moved to the README rather than made conditional — at install time there are normally no repo configs, so the conditional would print nothing on a first install anyway.

---

### [x] 4 · The webhook recipe is printed once and cannot be re-printed

**From:** this install, in the order a first-time operator would naturally take it:
`flipd add` first, `install.sh --host` afterwards. `add` printed the webhook recipe
with a `<PUBLIC_HOST>` placeholder, because no host was known yet. Once the host was
set, nothing could print the recipe again with the real name.

**Why:** the recipe -- Payload URL, where the secret lives, the `gh api` pipeline that
keeps the secret out of argv -- lives in `lib/cli/add.mjs` and nowhere else. `add`
refuses to run twice (`already exists`, `add.mjs:54`), and `check` never mentions the
webhook. So the one piece of output an operator most needs to copy is shown exactly
once, and if the install is done in this order it is shown with the wrong host.

`add` is not wrong to print the placeholder: it interpolates `PUBLIC_HOST` when it is
known (`add.mjs:67`) and cannot know what it has not been told. The gap is that there
is no second chance.

**Change:** have `flipd check <name>` print the recipe as its last section, using the
current `PUBLIC_HOST`. `check` is already the "is this repo wired?" command, already
reads the main conf, and is the natural thing to run after `--host`. Alternative: a
`flipd hook <name>` subcommand that prints only the recipe. `check` is preferred
because it adds no surface.

**Watch for:** the recipe reads the secret through the environment in a `gh` pipeline.
Keep that shape; do not let a convenience rewrite print the value.

**Size:** move the recipe text into a shared helper, call it from both commands, one

**Done:** fad055a. Extracted to `lib/cli/recipe.mjs`; `check` prints it with the current `PUBLIC_HOST`.
test that `check` prints it with the real host.

---

### [x] 5 · The shipped Caddy block has no access log

**From:** this install. With the shipped block, a delivery from GitHub that flipd
accepted left no trace at either layer: flipd was silent (item 1) and Caddy's access
logging is off by default. Proving that the ping had arrived meant editing
`/etc/caddy/conf.d/flipd.caddy` by hand to add a `log` directive, and that edit is
overwritten by the next `install.sh --host` run.

**Why:** the site block is the only place that sees the raw request -- source IP, method,
URI, status -- before flipd's own handling. Item 1 fixes flipd's side, but a request
that never reaches flipd (a Caddy misconfiguration, a TLS failure, a 404 on the wrong
path) is visible only here. For a single endpoint that receives a handful of requests a
day, there is no volume argument against logging every one.

**Change:** in `install.sh`, add to the generated site block:

    log {
        output stderr
    }

Journald, not a file. The obvious `output file /var/log/caddy/...` fails under the
Debian unit's sandboxing with `permission denied` even when the directory is owned by
`caddy` -- observed on this install -- and journald is where `journalctl -u caddy`
already looks.

**Watch for:** the `log` directive is per-site, so it captures `/deploy` and the 404
catch-all only, not other sites on the same Caddy. Say so in the README's Caddy note.

**Size:** three lines in the heredoc, one line in `test/install.test.mjs`.

**Done:** b09404f, 51189be. The log turned out to record request headers including `X-Hub-Signature-256` — the header item 1 exists to keep out of logs — so the second commit filters it. Verified on the box: signed ping returns pong, request logged, signature absent, other headers present.

---

## Fixed during the install

**The signed-ping race in `install.sh`.** After `reloaded caddy`, the installer sent
its verification ping after a fixed `sleep 2`. On a first install Caddy has no
certificate yet -- the ACME order was still in flight and landed about four seconds
after the reload -- so the ping's TLS handshake failed and the installer reported
`NOT OK` on an install that was in fact perfect. The identical signed ping run a minute
later returned `pong`. Replaced with five attempts at growing gaps (3, 5, 8, 13, 21
seconds): a warm box answers on the first and costs 3s, a cold order is covered by the
second or third, a real failure reports after 50s and says how long it waited. Verified
on the box: `pong ok (3s)` on re-run. Commit `aaaedb8`.

**A wrong ownership in a safety comment.** The comment above the group-membership
advice in `install.sh` said the socket and `/var/log/flipd` are `root:flipd`. Both are
`flipd:flipd`; `root:flipd` is `/etc/flipd/flipd.conf`, which is where the claim had
drifted from. The security argument around it -- group `flipd` gates access -- was
already right; only the stated owner was wrong. Corrected, and both ownerships are now
named with the reason they differ. Commit `1101b85`.

---

## Not a defect

Each of these was noticed, looked into, and left alone on purpose. The reason is
recorded so it is not looked into again.

**`install.sh` restarts the service on every run.** MainPID changed on a re-run that
touched nothing. This is deliberate and the comment above the restart says why: a
re-run after `git pull` is the upgrade path, `enable --now` on a running unit is a
no-op, and skipping the restart would leave old code running under a clean transcript.
A guard on "did the unit file change" would break exactly that, since the unit almost
never changes and `lib/` changes constantly. An in-flight build interrupted by the
restart is handled by design -- `KillMode=mixed`, recorded as `interrupted`,
`RestartSec=3`. You cannot deploy new flipd code without restarting flipd.

**`flipd status` exits 1 when no repos are configured.** It prints `no repos
configured` to stderr and returns 1 (`lib/cli/status.mjs:42`). Defensible: a status
report with nothing to report is a condition a script may want to detect, and it is
distinct from the 0 of "here are your repos". Left as is.

**`flipd add` printed `<PUBLIC_HOST>`.** Correct given the order: `add` ran before
`--host`, and it interpolates the real host when one is known. The actual gap is that
nothing can print it again afterwards -- item 4.

**`npm` was missing.** `apt-get install nodejs` on Ubuntu does not include `npm`; they
are separate packages. This is distribution packaging, not flipd, and flipd's response
to the resulting exit 127 was exactly right: build failed, no flip, truthful log. The
documentation side is item 2.

**Caddy refused two reloads while the access log was being added.** Both operator
error, not Caddy's. A
backup written as `flipd.caddy.bak` *inside* `/etc/caddy/conf.d/` is picked up by the
`import /etc/caddy/conf.d/*` glob and defines the site twice (`ambiguous site
definition`). And `output file /var/log/caddy/...` is refused by the Debian unit's
sandbox. Caddy kept serving the previous config through both, so the endpoint never
went down. Worth one line in the README's Caddy note: everything in `conf.d/` is
imported, so do not leave backups there.

---

### [x] 6 · Two post-verification sinks still take raw wire values

**From:** the whole-branch review of the fixes for items 1–5, 2026-09-06.
Not observed failing on the box; found by reading the code beside the change
item 1 made.

**Why:** item 1 introduced `cleanForLog` in `lib/hook.mjs` and routed every
value the webhook handler journals through it. Two sinks one file over were
outside that item's scope and still write raw wire values: `lib/serve.mjs`
journals `now ${sshUrl}` on the renamed-repository path, and writes
`${info.sha} ${info.pusher}` into `events.log`, where `pusher` is whatever
GitHub relays from the payload — arbitrary text under an authenticated
signature. A newline in either forges a log line, which is exactly the hazard
item 1 closed in the handler.

**Change:** route both through `cleanForLog` (export is already there). Cap
`pusher` short; a GitHub login is at most 39 characters.

**Watch for:** `events.log` is read back by `flipd status` and `flipd log`;
confirm nothing parses those two fields positionally in a way a `?`
replacement would break. It should not — they are display fields — but check
before assuming.

**Size:** two call sites, one test each.

---

### [x] 7 · The Caddy-filter test checks position, not nesting

**From:** the scoped re-review of the fix for item 5, 2026-09-06.

**Why:** `test/install.test.mjs` asserts the signature-filter line sits between
`log {` and `handle /deploy` and calls that "inside the log block". It is not the
same thing: the re-reviewer showed by simulation that moving the filter out of
`log {}` to sit beside it -- still before `handle /deploy` -- passes the
assertion. The shipped block nests correctly, so nothing is wrong today; the
test would simply not notice if that changed.

**Change:** assert the nesting rather than the ordering. The block is plain
text in a shell heredoc, so this means either a small brace-depth scan of the
extracted block, or matching the `log { ... }` span and requiring the delete
line inside it.

**Watch for:** `install.sh` is never executed by the suite, so this test is the
only automated guard on the generated Caddyfile. Do not weaken the other
assertions in the same test while strengthening this one.

**Size:** one helper in the test, no production change.

**Done:** both in a661deb. Item 6 found a third sink the item had not named --
the rename path journals *and* writes events.log, both taking the pushed
ssh_url -- so all three were cleaned; cleaning one of a pair is the trap. The
test asserts line integrity rather than the absence of the injected text,
because a log that hides what was sent is worse than one that shows it
neutralised. Item 7's spanOf() was checked against the sibling form it exists
to catch: moving the filter out of the log block fails the new assertion and
passed the old one.
