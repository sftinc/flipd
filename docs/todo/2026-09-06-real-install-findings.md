# Gaps found by installing and running flipd on a real server

**Status: todo, opened 2026-09-06.** Every item here was produced by installing flipd
on a live box and using it, not by reading other projects. Each names the install that
surfaced it, so a reader can tell observed evidence from speculation. Most are about
what the running system fails to tell its operator, rather than what it computes
wrongly -- the class of defect a test suite does not reach.

The prior-art list is separate: `docs/todo/2026-09-05-borrowed-from-prior-art.md`.

---

### [ ] 1 · Log an accepted webhook delivery

**From:** the first real install, 2026-09-06 — Ubuntu 26.04, public name behind Caddy
terminating TLS, webhook registered by hand in the GitHub UI. The obvious next question,
"did it arrive?", could not be answered from the server at all.

**Why:** `lib/hook.mjs` replies `200 pong` to a ping and `200 ignored` to a non-push
event, and neither writes a journal line. Rejections are logged; accepted deliveries are
not. So the operator wiring up a webhook for the first time — the one moment when the
answer matters most, and the only moment when the wiring is unproven — sees an empty
journal whether the delivery succeeded or never left GitHub. Caddy's access log is off in
the shipped config, so there is no record at that layer either. On this box the ping had
in fact arrived and verified correctly; proving it took a `log` block added to the Caddy
site by hand and a Redeliver from the GitHub UI.

Note what the silence cannot distinguish: a correct secret (accepted, unlogged) from a
webhook never saved, a DNS record still pointing at a proxy, or a proxy that never
forwarded. The one case that *is* visible is a wrong secret, because that logs a
rejection — so the single failure the operator can diagnose from the journal is the one
they are least likely to have.

**Change:** in `lib/hook.mjs`, journal one line for an accepted delivery, alongside the
existing rejection line: the event name, the source IP, and for a push the repo and
branch. A push that matches a repo already logs downstream, so keep this to the arms that
currently pass silently — `ping`, and the `ignored` non-push arm.

**Watch for:** the never-print rule. The signature header is derived from the secret and
must never be logged, and the payload is attacker-influenced until the HMAC has been
checked — so log after verification, and log fields, not the body. The source IP is safe
and is what makes the line worth having: it is the field that confirms a delivery came
from GitHub's published hooks range rather than from somewhere else.

**Size:** one journal call, one test per arm.

---

### [ ] 2 · Say that `install.sh` does not install Node

**From:** the same install. `apt-get install nodejs` on Ubuntu does not pull `npm`, so a
`BUILD=npm test` failed with exit 127 and `/bin/sh: 1: npm: not found` on an otherwise
correct install.

**Why:** `install.sh` checks for node and exits with `node 20 or newer is required`, which
is right — provisioning a runtime is not its job. But the README's install section does not
say a runtime is a prerequisite, so the first thing a new operator meets is a build failure
whose cause is upstream of flipd entirely.

flipd itself behaved correctly throughout: fetch and checkout succeeded, the build failed,
and it did not flip. `current` was absent afterwards, which is the whole point. The defect
is in the documentation, not the machinery.

**Change:** in the README's install section, state the prerequisites `install.sh` already
enforces — git, node ≥ 20, ssh-keygen, curl — and note that on Debian/Ubuntu `npm` is a
separate package from `nodejs`, needed only if a BUILD command uses it.

**Size:** a few lines of README.

---

### [ ] 3 · Reconsider the sudoers hint printed on every install

**From:** the same install, observed but not acted on.

**Why:** `install.sh` prints a ready-to-paste line granting the `flipd` user passwordless
root for a named script. It is correctly scoped to one path and clearly labelled, but it is
printed on every run, including runs where nothing needs root — so the most security-
sensitive suggestion in the tool is also the most repeated, which is how a paste-ready line
stops being read.

**Change:** print it only when a repo config actually references `sudo` in DEPLOY, or move
it to the README and reference it by name from the install output.

**Watch for:** this is a judgement call, not a defect — the current behaviour is defensible
and the line is not wrong. Decide before changing it.

**Size:** one conditional, or a documentation move.
