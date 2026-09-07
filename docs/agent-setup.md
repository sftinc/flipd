# Setting flipd up with an agent

## Who this is for

You are a coding agent working in **the operator's application repository** —
the app they want built and deployed — and your job is to set flipd up on
**their server** so that pushing to a branch deploys it.

You are not working on flipd's own source. If you are, stop reading this and
read [`CLAUDE.md`](../CLAUDE.md) in the flipd repository instead; its rules are
written for that job and some of them are the opposite of these. In particular
it forbids running `install.sh`, because there is no undo and a development
clone is not a place to find that out. Here, running it on the operator's
server is the task — under the gate in "Ask before these" below.

Everything you do here happens over SSH against a machine you have not seen.
Read [layout.md](layout.md) before you write anything to it.

## What flipd is, in one paragraph

flipd runs as a service on one box. A push to a watched branch arrives as a
webhook; flipd fetches, checks out a fresh worktree, runs `BUILD` in it, then
flips `current` — a symlink swapped with `rename()`, so it is atomic — and runs
`DEPLOY`. `DEPLOY`'s exit code is the whole verdict: zero confirms the release,
anything else leaves it `pending`, which blocks the next webhook build until a
human settles it. One conf file per repo in `/etc/flipd/repos/<name>.conf`.
Full model: [build-and-deploy.md](build-and-deploy.md).

## Establish these before touching anything

Ask the operator. Do not guess any of them:

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

## Read the app before you propose anything

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

## The run order

Each step says whether it can be undone.

1. **Check prerequisites** (safe). `git`, `node` 20 or newer, `ssh-keygen`,
   `curl` on the box. See [install.md](install.md).
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
4. **Add a forge account** (**gate** — see the token rule below), if they want
   automatic setup:

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
   `/etc/flipd/repos/<name>.conf`. Every key it accepts is in
   [configuration.md](configuration.md#the-repo-file). The file is re-read on
   every event, so no restart is needed. Secrets do **not** go on the `DEPLOY`
   line — the attempt log quotes it in full. Use
   `sudo flipd env <name> deploy --set K=V`.
7. **Verify** (safe) — next section.

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

## Verify

In this order. Stop at the first one that fails and read the log.

    flipd check <name>      # 0 up to date, 4 behind, 5 pending, 1 broken, 3 service down
    flipd status
    flipd run <name>        # first build, on demand
    flipd log <name> --follow

`check` also prints the webhook recipe with the current public host, so it is
how you confirm the Payload URL the operator should see on their forge. Then
have them push a real commit and confirm a build starts. Put `check` in cron
before you finish — that is what catches a lost webhook later:

    flipd check <name> || notify-me "<name> needs a look"

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

[install.md](install.md) · [adding-a-repo.md](adding-a-repo.md) ·
[accounts.md](accounts.md) · [configuration.md](configuration.md) ·
[build-and-deploy.md](build-and-deploy.md) · [commands.md](commands.md) ·
[operating.md](operating.md) · [layout.md](layout.md) ·
[deploy-recipes.md](deploy-recipes.md) ·
[serving-with-caddy.md](serving-with-caddy.md)
