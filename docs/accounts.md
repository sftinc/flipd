# Accounts

An account lets `add` configure GitHub, Forgejo or Gitea for you. It is
one access token per host, used only while `add` runs, stored root-only in
`/etc/flipd/accounts/<host>.conf`. The service never reads it, and repos already
added keep working if it is revoked. Save the token in a file with your
editor (not with `echo`, which puts it in your shell history), then:

    sudo flipd account add forge.example.com --kind forgejo < token-file
    sudo flipd account add github.com --kind github < github-token-file
    rm token-file github-token-file
    flipd account list                          # host, kind, api, token: set

The token is read from stdin and nowhere else, so it never appears in `ps` or
in shell history. What it needs:

| Forge | Token | Permissions |
|---|---|---|
| GitHub | fine-grained personal access token, repository access limited to the repos flipd will add | *Metadata: read*, *Administration: write* (deploy keys live there), *Webhooks: write* |
| Forgejo, Gitea | access token (Settings > Applications) of a user who administers those repos | `write:repository` |

*Administration: write* is broad, which is why the token is used once, stored
root-only, and worth revoking after the last `add`; nothing already set up
depends on it. Forgejo and Gitea tokens are user-wide, so use a machine user
where you can.

For a Forgejo or Gitea host, `account add` also records the host's SSH key in
`/var/lib/flipd/.ssh/known_hosts` and prints its fingerprints. Compare them
with the ones the forge publishes before adding a repo. If SSH is not on
port 22 there, pass `--ssh-port`; the key is recorded under `[host]:port`,
which is how the `ssh://` URLs such a forge renders look it up. The API base
defaults to `https://api.github.com` for GitHub and `https://<host>/api/v1`
otherwise; `--api` overrides it and must be `https://`.

The key `account add` records is for the host in the URL — the forge's web
and API host. Forgejo and Gitea have a separate `SSH_DOMAIN` setting, so a
repository's `ssh_url` can name a different one; when it does, `add` names
that host and prints the `ssh-keyscan` command to record it, and its
fingerprint needs the same comparison before the first build.

`flipd account remove <host>` deletes the account. Repos on that host go back
to the manual `add` flow; nothing already added changes.

Forgejo's **Test delivery** button sends a real push for the repository's
head, not a ping, so pressing it starts a build.
