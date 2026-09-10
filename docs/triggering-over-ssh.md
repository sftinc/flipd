# Triggering over SSH

**Who this is for:** a box with no port 80 or 443 open, no public hostname,
no TLS and no Caddy — but SSH, which nearly every box has. Also anyone who
wants their CI job to go red when a deploy fails, which a webhook can never
tell it.

flipd has two doors into the same queue. The webhook is HTTP: the forge
POSTs to `https://<PUBLIC_HOST>/deploy` and flipd answers before the build
starts. The SSH door is a forced command: a CI job logs in with a key that
can do exactly one thing, `flipd trigger <name> --wait`, and the session
stays open until the deploy has an outcome. Both doors put the same work on
the same queue, and a repo can use either or both.

    flipd trigger <name>            # accept and return, like the webhook
    flipd trigger <name> --wait     # hold the session; exit with the outcome

## What the trigger does

It is the webhook without a payload. Everything the webhook does, it does:

- **Refused while `pending`** — a release that was flipped to and never
  confirmed blocks it, as it blocks a push. `flipd rollback` or `flipd run`
  by a person is the way out. See [operating.md](operating.md).
- **Skipped when already live** — the branch head is what is deployed, so
  nothing is rebuilt. That is a success.
- **`WATCH` and `IGNORE` honoured** — that filter is a git diff between the
  live release and the fetched head, not something read off a payload.
- **`STOP` always runs.** There is no `--now`; that is `run`'s override, and
  the whole point of this verb is that CI never gets the override.
- **Coalesces** with a webhook, or another trigger, for the same repo. A
  trigger that arrives mid-build is folded into one catch-up rerun, labelled
  `coalesced` in the attempt log and `events.log`.
- **`ON_FAILURE` fires** the same way.

**One trigger is one repo file.** It is given a name, not a repository, so a
monorepo deploying several projects ([Several projects in one
repository](adding-a-repo.md#several-projects-in-one-repository)) needs one
trigger each — which is one forced command, not one key each:

    command="/opt/flipd/bin/flipd trigger www --wait && /opt/flipd/bin/flipd trigger console --wait",restrict ssh-ed25519 AAAA...

They run in the order written, one after another, and the job goes red if
either fails. `WATCH` still decides which of them actually builds: the filter
is a diff against each project's live release, not a reading of a payload, so
this is the same decision the webhook door makes. The webhook door, given a
push, does the fan-out itself.

What it lacks is the push payload. It always builds the conf's `BRANCH`. The
workflow's `on: push: branches:` is the branch filter; a job triggered from a
branch the conf does not name deploys the conf's branch, not the pusher's.
A rename on the forge is still matched by id once a webhook run has recorded
it — a trigger does not learn it.

The per-attempt log line names the trigger — `trigger=ssh` for this door,
`trigger=webhook` for the other, `trigger=coalesced` for the catch-up rerun —
and `events.log` gets a matching `started` line for all three. `ssh` and
`webhook` also get a `queued` line when the request first arrives;
`coalesced` does not, because the queue enqueues that rerun itself, with
nothing outside it asking to be logged.

## Exit codes

Without `--wait`, the webhook's status codes in another form:

| Exit | Meaning | Webhook equivalent |
|---|---|---|
| `0` | accepted: queued, or coalesced into work already accepted | `202` |
| `1` | refused (`pending`, unreadable `state.json`, or no such repo) or discarded (service stopping) | `200` refused, `503` |
| `2` | usage | — |
| `3` | service down or unreachable | — |

With `--wait`, the session holds until the covering attempt settles, then:

| Exit | Outcome |
|---|---|
| `0` | `ok`, or `skipped` (already live, or nothing under `WATCH` changed) |
| `1` | `fetch failed`, `checkout failed`, `build failed`, `stop failed`, `deploy failed`, `interrupted`, `config failed`, or `refused`; or the trigger was refused before it was even queued; or the service crashed on the attempt; or the service was stopping |
| `3` | the connection closed with no answer: the service restarted or died mid-wait |

`skipped` is `0` on purpose: CI must not go red because nothing needed
deploying. A `3` during a service restart is a lost *answer*, not a lost
build — the build finishes on the box, and `flipd log <name>` has the
outcome. (A running attempt gets its real outcome if it ends within the
service's ~20s shutdown drain; a longer one reads as `3`.)

## Setting it up

flipd does none of this for you. The keypair, the login user and the
`authorized_keys` line are box administration, done the way any other SSH
access is done; flipd only prints these steps with the repo name filled in
(`flipd add` and `flipd check` do, on a box with no `PUBLIC_HOST`).

**1. Make the keypair on your own machine, not on the box.**

    ssh-keygen -t ed25519 -f flipd-<name> -N ''

The private half (`flipd-<name>`) is going to GitHub; the public half
(`flipd-<name>.pub`) is going to the box. Neither ever needs to be on the
other.

**2. A login user on the box, in group `flipd`.**

Use a dedicated account, not your own:

    sudo useradd --system -m -s /bin/sh -G flipd flipd-ci

No password is set, so the account stays locked to everything but the key.
Group `flipd` is what lets it reach the socket; the forced command in the
next step is what stops it doing anything else. Adding an *existing* login
user to the group works too, but read [Security](#security) first — the
group grants more than the socket.

**3. The key, with a forced command.**

On the box, create `.ssh` for the new account and build the
`authorized_keys` line from the public half — nothing about a public key is
secret, so it is fine to move around in the open:

    sudo -u flipd-ci mkdir -m 700 /home/flipd-ci/.ssh

Then, with `flipd-<name>.pub` from step 1 available on the box (paste it in,
or `scp` it there — again, it is public):

    printf 'command="/opt/flipd/bin/flipd trigger <name> --wait",restrict %s\n' \
      "$(cat flipd-<name>.pub)" | sudo tee -a /home/flipd-ci/.ssh/authorized_keys
    sudo chown flipd-ci /home/flipd-ci/.ssh/authorized_keys
    sudo chmod 600 /home/flipd-ci/.ssh/authorized_keys

That produces one line shaped like:

    command="/opt/flipd/bin/flipd trigger <name> --wait",restrict ssh-ed25519 AAAA... flipd-<name>

`command=` means sshd runs that and only that, whatever the client asked
for. `restrict` turns off port forwarding, agent forwarding, X11 and the
pty. The key is worth exactly one thing. If the clone is not at
`/opt/flipd`, use its real path — `flipd add` and `flipd check` print the
right one.

**4. The private half into the repository's Actions secrets.**

    gh secret set FLIPD_SSH_KEY -R <owner>/<repo> < flipd-<name>

Straight from the file: it never goes on a command line or a screen.

**5. The box's host key into a repository variable, so the runner can pin it.**

On your own machine:

    ssh-keyscan -t ed25519 box.example.com 2>/dev/null

Compare the key it prints with the box's own — on the box,
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` shows the fingerprint —
then store the full `ssh-keyscan` line:

    ssh-keyscan -t ed25519 box.example.com 2>/dev/null | gh variable set FLIPD_KNOWN_HOSTS -R <owner>/<repo>

**6. Delete the private key from your machine.** GitHub has the only copy
it needs; nothing else does.

## The workflow

No third-party actions: the runner writes two files and runs `ssh`.

```yaml
name: deploy
on:
  push:
    branches: [main]      # the branch filter: a trigger has no payload
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30   # see below
    steps:
      - name: trigger flipd
        env:
          KEY: ${{ secrets.FLIPD_SSH_KEY }}
          KNOWN_HOSTS: ${{ vars.FLIPD_KNOWN_HOSTS }}
        run: |
          umask 077
          printf '%s\n' "$KEY" > key
          printf '%s\n' "$KNOWN_HOSTS" > known_hosts
          ssh -i key -o UserKnownHostsFile=known_hosts \
              -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
              flipd-ci@box.example.com
```

Notes on that:

- **No command argument.** The forced command ignores one anyway, and a
  workflow that names the command reads as if it chose it. What runs is what
  the `authorized_keys` line says.
- **`umask 077`** makes both files `0600`, which `ssh` requires of the key.
- **`UserKnownHostsFile`** with the pinned key is how the runner knows it is
  talking to your box. `StrictHostKeyChecking=no` is not shown here and
  should not be used.
- **`ServerAlive*`** keeps a long build's session from being dropped by
  something in between; **`ConnectTimeout`** fails fast if the box is
  unreachable.
- **`timeout-minutes`** is a ceiling with margin, not a sum. An attempt is
  not just `TIMEOUT` three times over: each git call has its own limit, prune
  runs per release, and a failed attempt spends up to a minute in
  `ON_FAILURE` before the answer comes back. Pick something comfortably above
  your longest real deploy. If it expires, the answer is lost and the build
  is not — it continues on the box, and `flipd log <name>` has the outcome.
  Without it a job that loses its box runs to the runner's six-hour ceiling.

## Both at once

A repo can have a webhook *and* a key. Both put the same entry on the same
queue, and two that arrive for the same repo coalesce into one build. Nothing
to configure: `PUBLIC_HOST` set is a webhook door, an `authorized_keys` line
is an SSH door, and having both is just having both.

## Turning the webhook off

`PUBLIC_HOST` is the switch. Comment it out in `/etc/flipd/flipd.conf` and
restart flipd (`flipd status` idle first, as for any restart). The service
starts no listener, `WEBHOOK_SECRET` becomes optional, and the journal says
`webhook listener off: PUBLIC_HOST is not set`. While it is off, the forge's
deliveries fail visibly — with `install.sh`'s own Caddy block (`handle
/deploy { reverse_proxy 127.0.0.1:9000 }`), that means proxying to a port
nobody is listening on, a 502 — and the forge records them; uncomment,
restart, and redeliver from the forge's webhook page to catch up. A
hand-rolled front end may fail differently; the point is that a delivery
made while the listener is off is never silently lost. `flipd check <name>`
says
`webhook  configured off (PUBLIC_HOST not set)` and where the webhook
pointed, so nothing is forgotten.

A box that never had `--host` never had a listener; `install.sh` without
`--host` is the SSH-only install.

## Security

- **Group `flipd` is the whole access; `command=` plus `restrict` is the
  whole restriction — and they bind one key, not the account.** The group
  also reads `/etc/flipd/flipd.conf` (which holds `WEBHOOK_SECRET`) and every
  deploy env file `flipd env` writes — every app secret on the box. An
  existing login user added to the group reaches all of that through their
  other keys, their password, or a session they already hold. That is why
  the dedicated account above is the default. A key on a group-`flipd` user
  *without* `command=` can `run` and `rollback` every repo on the box.
- **The key is the authentication**, the same posture the HMAC has on the
  webhook door. The runner's source addresses are GitHub's whole range, so
  there is nothing useful to firewall by; there is nothing useful to firewall
  the webhook by either.
- **Pin the host key.** Step 5 above; the workflow never disables checking.
- **flipd never sees the private half.** It is made on your machine, sent
  to GitHub from the file, and deleted. Nothing new for the never-print rule
  to guard.
