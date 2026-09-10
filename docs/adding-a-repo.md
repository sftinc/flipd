# Adding a repo

One command sets the repo up locally and prints the two things the forge needs
from you:

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints). If you set --host after
    # this, `flipd check app` prints the webhook recipe again with the real host.
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

`add` generates a read-only deploy key, writes the repo conf, and prints the key
to add on the forge along with the webhook to create — Payload URL, where the
secret is, and a `gh api` pipeline if you would rather not click through a form.
On a box with no `PUBLIC_HOST` there is no webhook to create, and `add` prints
the SSH trigger recipe instead — see [triggering-over-ssh.md](triggering-over-ssh.md).

## With an account, `add` does both steps for you

Give flipd an [account](accounts.md) for the host — one access token, used only
while `add` runs — and there is nothing to paste:

    sudo flipd add https://forge.example.com/team/app --root .
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

`add` uploads the deploy key itself, creates the push webhook with the right URL
and secret, and writes `REPO` exactly as the forge renders it — which matters,
because that is the spelling every push will arrive with.

It is worth setting up when:

- **You are adding more than one repo.** The token is per host, so it covers
  every repo on that forge, and the setup cost is paid once.
- **The forge is Forgejo or Gitea.** `account add` also records the host's SSH
  key in `known_hosts` and prints its fingerprints to compare. Without an
  account that is a manual `ssh-keyscan` step before the first build can fetch.

For a single repo on GitHub it is usually the long way round: creating a
fine-grained token scoped to *Metadata: read*, *Administration: write* and
*Webhooks: write* is more work than pasting a key once. Scopes and the rest are
in [accounts.md](accounts.md).

## Several projects in one repository

A monorepo holding a site and an admin console is two repo files with the same
`REPO`, one per thing you deploy:

    sudo flipd add git@github.com:you/mono.git --name www     --root www
    sudo flipd add git@github.com:you/mono.git --name console --root console

The name is the unit of everything else — its own releases, `current`, state,
env files, logs and key — so `www` rolls back while `console` stays put, and
one being `pending` never blocks the other. `ROOT` is the directory `BUILD`,
`STOP` and `DEPLOY` run in.

**One webhook covers them all.** It is created on the repository, not on the
repo file, and a push to it reaches every repo file naming that repository and
that `BRANCH`. Running `add` a second time finds the webhook already there and
reuses it — do not create a second one: GitHub refuses a duplicate URL, and
Forgejo accepts it and then delivers every push twice. `flipd check www` lists
the repo files that share the webhook with it.

**Each project decides for itself whether to build**, with `WATCH` and
`IGNORE`:

    # www.conf
    ROOT=www
    WATCH=www/** packages/shared/**

    # console.conf
    ROOT=console
    WATCH=console/** packages/shared/**

A push touching only `www/` builds `www` and is `skipped` for `console`; a push
touching `packages/shared/` builds both. The globs match from the repository
root, not from `ROOT`. The filter is a diff between the live release and the
fetched head rather than a reading of the push, so a project skipped for six
pushes still builds the moment one of its own files changes — with everything
those six pushes contained.

**They build one after another, never at once.** flipd runs one build at a
time, in repo-file name order, so `console` goes live a build later than `www`.
That is the trade for a box that runs the builds itself: two `npm` builds at
once is how a small VPS runs out of memory. Nothing switches the two projects
over together — each flips when its own `DEPLOY` confirms — so a change that
must land in both at the same instant is not something a monorepo gives you
here.

**Over SSH each project is its own trigger.** `flipd trigger` takes a name, not
a repository, so a box with no `PUBLIC_HOST` runs both from one forced command:

    command="/opt/flipd/bin/flipd trigger www --wait && /opt/flipd/bin/flipd trigger console --wait",restrict ssh-ed25519 AAAA...

One key, one CI step, and `WATCH` still decides which of them actually builds.
See [triggering-over-ssh.md](triggering-over-ssh.md).

## Then

Every key the conf file accepts is in
[The repo file](configuration.md#the-repo-file); worked `DEPLOY` commands are in
[deploy-recipes.md](deploy-recipes.md).
