# Adding a repo

With an account for the host (see [accounts.md](accounts.md)), one command does
the whole setup:

    sudo flipd add https://forge.example.com/team/app --root .
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

`add` generates a read-only deploy key and uploads it, creates the push
webhook with the right URL and secret, and writes `REPO` exactly as the forge
renders it. Without an account for that host, `add` prints the two steps
for you to do instead:

    sudo flipd add git@github.com:you/app.git --root .
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints). If you set --host after
    # this, `flipd check app` prints the webhook recipe again with the real host.
    sudo vi /etc/flipd/repos/app.conf        # BUILD and DEPLOY
    flipd check app

Every key the file accepts is in [The repo file](configuration.md#the-repo-file); worked
`DEPLOY` commands are in [deploy-recipes.md](deploy-recipes.md).
