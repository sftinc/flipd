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

## Then

Every key the conf file accepts is in
[The repo file](configuration.md#the-repo-file); worked `DEPLOY` commands are in
[deploy-recipes.md](deploy-recipes.md).
