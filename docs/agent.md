# flipd for a coding agent

## Who this is for

You are a coding agent working for the operator — usually sitting in **the
application repository they want deployed**, working against **their server**
over SSH. This file is the whole job: setting flipd up there, keeping it
running, and fixing it when it stops.

You are not working on flipd's own source. If you are, stop reading this and
read [`CLAUDE.md`](../CLAUDE.md) in the flipd repository instead; its rules are
written for that job and some of them are the opposite of these. In particular
it forbids running `install.sh`, because there is no undo and a development
clone is not the place to find that out. Here, running it on the operator's
server is the task — under the gate in [Ask before these](#ask-before-these).

Everything you do happens against a machine you have not seen. Read
[layout.md](layout.md) before you write anything to it.

## What flipd is, in one paragraph

flipd runs as a service on one box. A push to a watched branch arrives as a
webhook; flipd fetches, checks out a fresh worktree, runs `BUILD` in it, then
flips `current` — a symlink swapped with `rename()`, so it is atomic — and runs
`DEPLOY`. `DEPLOY`'s exit code is the whole verdict: zero confirms the release,
anything else leaves it `pending`, which blocks the next webhook build until a
human settles it. One conf file per repo in `/etc/flipd/repos/<name>.conf`.
Full model: [build-and-deploy.md](build-and-deploy.md).

## What you can do here

| The job | What it involves | Where |
|---|---|---|
| Set flipd up on a fresh box | Install, add the repo, write `BUILD` and `DEPLOY`, verify. Two steps that cannot be undone. | [Set it up on a fresh box](#set-it-up-on-a-fresh-box) |
| Work out a `BUILD` and a `DEPLOY` | Read their app, propose both, show them before you use them. | [Work out a `BUILD` and a `DEPLOY`](#work-out-a-build-and-a-deploy) |
| Add a repo to a box that already runs flipd | No installer. A deploy key and a webhook, then the two commands. | [Add a repo to a box that already runs flipd](#add-a-repo-to-a-box-that-already-runs-flipd) |
| Change a build or deploy command | One conf file, re-read on the next event. No restart. | [Change `BUILD` or `DEPLOY`](#change-build-or-deploy) |
| Find out whether it is working | `check`, `status`, `log`. Nothing here writes. | [Verify](#verify) |
| Work out why a push did not deploy | Caddy's journal, the attempt log, an exit code. Also safe. | [When it goes wrong](#when-it-goes-wrong) |
| Settle a failed deploy, or go back a release | A `pending` release refuses every webhook build until someone settles it. | [Settle a failed deploy, or roll back on purpose](#settle-a-failed-deploy-or-roll-back-on-purpose) |
| Upgrade flipd | `git pull` and restart — only while nothing is building. | [Upgrade flipd](#upgrade-flipd) |
| Rotate a forge token | The token never reaches you, this time either. | [Rotate or remove a forge token](#rotate-or-remove-a-forge-token) |
| Change a secret the build or deploy uses | `flipd env`, never the conf line. | [Change a secret the build or deploy uses](#change-a-secret-the-build-or-deploy-uses) |
| Stop deploying a repo | The config goes; state, logs, and the forge's webhook and key stay. | [Stop deploying a repo](#stop-deploying-a-repo) |

**Ask the operator which of these they want. Do not assume.** "Help me with
flipd" usually means the first row — and the first row is the one with the
irreversible steps in it, so it is the worst one to guess at. If they have not
said, ask, and offer them this list. Then read the next section: it tells you
what is actually on the box, which narrows the answer faster than more
questions will.

## Where you are

Four things worth knowing before you plan anything. None of them writes:

    ls /opt/flipd                 # is flipd installed at all
    systemctl is-active flipd     # is the service up
    flipd status                  # every repo it knows: live, pending, running
    flipd check <name>            # 0 up to date, 4 behind, 5 pending, 1 broken, 3 service down

What they tell you:

- **No `/opt/flipd`** — nothing is set up. That is [Set it up on a fresh
  box](#set-it-up-on-a-fresh-box), and it starts by establishing five things
  with the operator.
- **Installed, but `status` does not list their repo** — the box is ready and
  the job is [Add a repo](#add-a-repo-to-a-box-that-already-runs-flipd). Do not
  re-run the installer.
- **`status` lists their repo** — it is already working, or was. The job is one
  of the rest of the table.
- **`check` exits `5`** — a release was flipped to and `DEPLOY` never confirmed
  it. **Settle that before anything else**, whatever they asked you for: while
  it stands, no push to that repo will build.
- **`status` fails with `EACCES ... scandir '/etc/flipd/repos'`, or `check` says
  `service down` while `systemctl` says the service is active** — that is a
  missing `flipd` group membership for the account you are on, not a dead
  service. See [commands.md](commands.md#permissions).

## Write down what you learn about the box

The first part of any job is finding out things that are in neither this file
nor their repository: the address, the SSH user, which key, the public hostname,
what else the box runs, which of its quirks cost you twenty minutes. Write them
down as you go, in the operator's repository, in `SERVER.md`. The next session —
yours or another agent's — reads that instead of working out [where you
are](#where-you-are) from nothing again.

Three things about that file, in this order:

1. **Ask the operator first.** It is their repository, and this creates a file
   in it.
2. **Add `SERVER.md` to `.gitignore` before you create it**, never after.
   Between writing it and ignoring it there is a window where a `git add -A`
   commits a server's address, and a repository's history does not forget.

       grep -qx 'SERVER.md' .gitignore || printf 'SERVER.md\n' >> .gitignore

3. **No secrets in it.** [Rules you must not break](#rules-you-must-not-break)
   binds this file exactly as it binds a log: the key's path, never the key; the
   name of the file a secret lives in, never the value.

The shape to follow — one block per box, and what belongs under each heading —
is [SERVER.example.md](../SERVER.example.md).

## Ask before these

Do not run any of these without the operator agreeing in that turn. Say what it
will do and what cannot be undone, then wait.

- `install.sh` — runs as root, creates a system user, writes `/etc`, installs a
  systemd unit and Caddy. There is no undo.
- `flipd account add` — writes a forge token to the box.
- `flipd add` — uploads a deploy key and creates a webhook on their forge.
  Removing the repo from flipd does not remove either.
- Anything writing `/etc/sudoers.d/` — a wrong line here can lock out `sudo` or
  grant root to whoever can edit a script.

## Rules you must not break

These bind every job in the table, not just setup.

- **Never let the forge token reach you.** Do not ask the operator to paste it
  into this conversation, and never put it on a command line or in an `echo` —
  that puts it in the transcript, in shell history, and in `ps` where any user
  on the box can read it. Have the operator create the file on the box
  themselves with an editor, run
  `sudo flipd account add <host> --kind <kind> < token-file`, then delete it.
  You never see the value.
- **Never print a secret.** Not `WEBHOOK_SECRET` from `/etc/flipd/flipd.conf`,
  not a private key, not an env-file value. flipd itself prints key names only,
  and so should you. If you need the secret to sign a test request, use it in a
  shell variable without echoing it.
- **Secrets go in env files, not the conf.** `sudo flipd env <name> build --set
  K=V`. Values of eight characters or more are masked in attempt logs.
- **Do not commit anything to the operator's repository** without asking. Most
  of this work happens on the server, not in the checkout you are sitting in.
- **Do not build over a `pending` release.** If `check` exits `5`, a deploy
  failed and was never confirmed. Read the log and tell the operator; do not
  run `flipd run` to make the symptom go away.

## The jobs

### Set it up on a fresh box

Establish these first. Ask the operator; do not guess any of them:

- **The server** — hostname or IP, the SSH user, and which key. Confirm you can
  reach it and whether you have root or passwordless `sudo`.
- **A public hostname for the webhook**, and whether DNS already points it at
  that box. `install.sh --host` installs Caddy and gets a TLS certificate for
  that name; if the name does not resolve to the box yet, the ACME challenge
  fails. Check with `dig +short <name>` before you run anything.
- **The branch** to deploy. Default is `main`.
- **The forge** — GitHub, Forgejo or Gitea — and whether they want to give flipd
  an account so that setup is automatic. Without one, `add` prints a deploy key
  and a webhook for them to paste in by hand, which works fine.
- **What serves the app** once it is built, and what has to happen for a new
  release to take effect: a systemd unit to restart, files to copy into a web
  root, a container to recreate, or nothing at all.

Then the run order. Each step says whether it can be undone.

1. **Check prerequisites** (safe). `git`, `node` 20 or newer, `ssh-keygen`,
   `curl` on the box. See [install.md](install.md), which also lists everything
   the installer does to the box, step by step.
2. **Clone and install** (**not reversible — gate**).

       git clone https://github.com/sftinc/flipd.git /opt/flipd
       sudo /opt/flipd/install.sh --host deploy.example.com

   Creates the `flipd` user, writes `/etc/flipd`, installs a systemd unit and
   Caddy, and verifies the webhook path with a signed ping. Without `--host`
   everything else still happens and the Caddy block is printed to paste.
3. **Add the operator to the group** (reversible). The installer prints
   `sudo usermod -aG flipd <you>`. Run it, then start a fresh login shell — the
   group is what lets `status`, `check`, `run`, `rollback` and `log` work
   without `sudo`.
4. **Add a forge account** (**gate** — see the token rule above), if they want
   automatic setup. **Ask; do not assume they need one.** For a single repo,
   creating a scoped token is usually more work than pasting a deploy key once,
   and step 5 prints everything needed for that. An account pays for itself from
   the second repo onward, and on Forgejo or Gitea it also records the host's
   SSH key, which otherwise has to be done by hand:

       sudo flipd account add <host> --kind github|forgejo|gitea < token-file

   Then `flipd account list` to confirm. Scopes are in
   [accounts.md](accounts.md): GitHub needs *Metadata: read*,
   *Administration: write* and *Webhooks: write*; Forgejo and Gitea need
   `write:repository`. For a Forgejo or Gitea host this also records the host's
   SSH key and prints its fingerprints — **show them to the operator and have
   them compare against what the forge publishes** before the first build.
5. **Add the repo** (**not reversible from the box — gate**).

       sudo flipd add <git-url> --root .

   With an account this generates a deploy key, uploads it, and creates the
   webhook. Without one it prints both for the operator to paste. Note the
   webhook and the key now exist on their forge; `flipd remove` does not delete
   them.
6. **Write `BUILD` and `DEPLOY`** (reversible) into
   `/etc/flipd/repos/<name>.conf` — the next section is how you work out what
   they should say.
7. **Verify** (safe) — [Verify](#verify).

### Work out a `BUILD` and a `DEPLOY`

This is a job in its own right, and it is the same job whether you are setting
the repo up or changing it a month later.

You are in their repository. Use it. Look at `package.json` scripts and which
lockfile is present, a `Dockerfile` or `compose.yaml`, a `Makefile`, `go.mod`,
`pyproject.toml`, any existing CI workflow (it usually already contains the
build command), and where the build output lands.

Then propose a `BUILD` and a `DEPLOY` and **show them to the operator before you
use them.** Worked examples for every common shape are in
[deploy-recipes.md](deploy-recipes.md) — read it rather than inventing a
`DEPLOY`, because two constraints catch out anything written from first
principles:

- **`DEPLOY` runs as the `flipd` user, and `/var/lib/flipd/<name>` is mode
  `0750` owned `flipd:flipd`.** A service running as any other user cannot read
  the release where it sits. Either that service runs as `flipd`, or `DEPLOY`
  copies the release somewhere it can read.
- **Nothing written inside a release directory outlives that release.** The next
  build is a fresh worktree and old releases are pruned. Uploads, a SQLite file,
  a cache — anything the running app writes must live outside
  `/var/lib/flipd/<name>/releases/`, and `DEPLOY` is where you make the symlink
  or the copy.

If `DEPLOY` needs root — restarting a system unit, say — do not hand `flipd`
broad `sudo`. The rule, and the exact sudoers line, is in
[build-and-deploy.md](build-and-deploy.md#a-deploy-command-that-needs-root).
Every key the conf file accepts is in
[configuration.md](configuration.md#the-repo-file). Secrets do **not** go on the
`DEPLOY` line — the attempt log quotes it in full. Use
`sudo flipd env <name> deploy --set K=V`.

### Add a repo to a box that already runs flipd

Do not re-run `install.sh`; the box is already set up. Only steps 4-7 above
apply: an account if this is a new forge (an existing one covers every repo on
that host), then `flipd add`, then `BUILD` and `DEPLOY`, then verify. `flipd
add` is still a gate — it creates a deploy key and a webhook on the forge.

### Change `BUILD` or `DEPLOY`

Edit `/etc/flipd/repos/<name>.conf`. It is re-read on every event, so no restart
is needed, and `flipd run <name>` builds immediately to test it — `run` bypasses
`WATCH` and `IGNORE`. The two constraints in [Work out a `BUILD` and a
`DEPLOY`](#work-out-a-build-and-a-deploy) still apply to whatever you write.

Two things that catch people out:

- **A rollback does not use the edited command.** It re-runs the `DEPLOY` and
  `ROOT` recorded with *that* release, so fixing `DEPLOY` fixes the next build
  and not a rollback to an older release.
- **The server file is not like the repo file.** `/etc/flipd/flipd.conf` is read
  once at startup, so a change there needs `sudo systemctl restart flipd` — with
  the same idle check as an upgrade.

### Settle a failed deploy, or roll back on purpose

    flipd rollback <name>
    flipd log <name> --follow

Re-runs the previous confirmed release's `DEPLOY` with no `BUILD`, and clears a
`pending`. This is the correct way to settle a failed deploy. Do **not** use
`flipd run` for that — it builds the new code over an unconfirmed flip, which
buries the failure instead of resolving it. Read the attempt log before you
roll back, and tell the operator what it said: a `pending` is a deploy that
went wrong, and clearing it without knowing why only postpones the next one.

### Upgrade flipd

    flipd status                                  # every repo must be idle first
    git -C /opt/flipd pull && sudo systemctl restart flipd
    systemctl is-active flipd && flipd status

**Check `status` before you restart, every time.** A restart kills whatever is
mid-build: the running command dies, its attempt is recorded `interrupted`, and
the in-memory queue is lost — a push that was waiting is simply gone, and the
forge will not resend it. If anything is running or queued, wait.

### Rotate or remove a forge token

    sudo flipd account remove <host>
    sudo flipd account add <host> --kind <kind> < token-file

The token rule from [Rules you must not break](#rules-you-must-not-break)
applies again in full: the operator writes the new file on the box, you redirect
it and delete it, you never see the value. Nothing already added breaks while
there is no account — repos keep building with the deploy keys they already
have, because the token is only ever used while `add` runs.

### Change a secret the build or deploy uses

    sudo flipd env <name> build --set K=V
    sudo flipd env <name> deploy --unset K

With neither flag it opens the file in `$EDITOR` and re-validates on save.
Values of eight characters or more are masked wherever attempt output is
written. These never belong on the `DEPLOY` conf line, which the attempt log
quotes in full.

### Stop deploying a repo

    sudo flipd remove <name>

Removes `/etc/flipd/repos/<name>.conf`, and with it flipd's reaction to that
repo's pushes. It refuses while that repo is running or queued. State, logs and
env files are kept, and the command prints the `rm` lines for all three if the
operator wants them gone — decide that with them, not for them.

The deploy key and the webhook stay on the forge; flipd never deletes either.
Say so: the webhook keeps firing at a `/deploy` that no longer matches a repo,
which is harmless — it is noted in `journalctl -u flipd` and ignored — but it is
theirs to clean up.

### What a restart or a reboot does

The unit is enabled and `Restart=on-failure`, so flipd comes back on its own
after a crash or a reboot. At startup it reconciles: an attempt that was
in-flight is recorded as `interrupted`, release directories no state knows about
are removed, and an unconfirmed `pending` is reported in the journal. **A
`pending` survives a restart and still refuses webhook builds** — a reboot does
not clear one, so settle it with a rollback.

### Set up monitoring

Put `check` in cron before you finish; it is what catches a lost webhook or a
deploy nobody noticed had failed:

    flipd check <name> || notify-me "<name> needs a look"

To deploy automatically after a missed webhook, key on `4` specifically and
never on `5`:

    flipd check <name> >/dev/null; [ $? -eq 4 ] && flipd run <name>

`5` outranks `4`, so a repo that is both behind and pending stays put until a
human looks at it. That is deliberate. See [operating.md](operating.md).

## Verify

Whatever the job was, this is how you find out it worked. In this order; stop at
the first one that fails and read the log.

    flipd check <name>      # 0 up to date, 4 behind, 5 pending, 1 broken, 3 service down
    flipd status
    flipd run <name>        # build now, on demand
    flipd log <name> --follow

`check` also prints the webhook recipe with the current public host, so it is
how you confirm the Payload URL the operator should see on their forge. After a
first setup, have them push a real commit and confirm a build starts — a webhook
that was never created looks exactly like one that works until someone pushes.

## When it goes wrong

- **The push never arrives.** `journalctl -u caddy` on the box — the site block
  logs every request to `/deploy` with the signature header filtered out. If
  nothing is there, the delivery never reached the box; check the forge's own
  delivery log and that DNS points at this machine.
- **`status` fails with a bare `EACCES: permission denied, scandir
  '/etc/flipd/repos'`**, or `check`/`run`/`log` say `service down` while
  `systemctl status flipd` says it is fine. That is a missing `flipd` group
  membership, not a dead service. See
  [commands.md](commands.md#permissions).
- **`check` exits `5`.** A release was flipped to and `DEPLOY` never confirmed
  it. Webhook builds are refused until it is settled with `flipd rollback` or a
  deliberate `flipd run`. Read the attempt log first.
- **`checkout failed` on a repo with submodules.** A deploy key works for one
  repository only. A repo whose submodule is a second private repository needs
  `--key` with a machine user's key that can read both.
- **Anything else** — `journalctl -u flipd` and
  `/var/log/flipd/<name>/events.log`, one line per attempt.

## Where to read more

| File | Answers |
|---|---|
| [install.md](install.md) | requirements, what `install.sh` does to the box step by step, `--host`, upgrading |
| [adding-a-repo.md](adding-a-repo.md) | the `add` walkthrough, with and without an account |
| [accounts.md](accounts.md) | forge tokens, the scopes each forge needs, host keys |
| [configuration.md](configuration.md) | every key in the repo file and the server file |
| [build-and-deploy.md](build-and-deploy.md) | the contract `BUILD` and `DEPLOY` run under, and the environment they see |
| [deploy-recipes.md](deploy-recipes.md) | worked `DEPLOY` commands, one per kind of thing served |
| [commands.md](commands.md) | flags, exit codes, which need `sudo`, and the `flipd` group |
| [operating.md](operating.md) | day to day, `check` in cron, what `pending` means |
| [layout.md](layout.md) | every path flipd writes, and the modes on them |
| [serving-with-caddy.md](serving-with-caddy.md) | the site block that makes the app reachable |
