# Serving the repo through Caddy

The recipes in [deploy-recipes.md](deploy-recipes.md) put the release where
something can serve it. This is the other half: the Caddy site block that makes
it reachable from outside. Nothing here runs at deploy time — but
`install.sh --host` already put Caddy on the box for the webhook, and the same
Caddy can serve the app.

## A separate hostname, in its own file

`install.sh --host` writes one file, `/etc/caddy/conf.d/flipd.caddy`, and
appends `import /etc/caddy/conf.d/*` to `/etc/caddy/Caddyfile` if it is not
already there. That import is the whole mechanism: any other file in
`conf.d/` is read on the next reload.

Two things not to do.

Do not add the site to `flipd.caddy`. The next `install.sh --host` overwrites
that file, and the site disappears at the moment an upgrade is the thing being
blamed for something else.

Do not reuse the webhook's hostname. Two site blocks for one address is
`ambiguous site definition`, and Caddy refuses to adapt the config at all.
The failure is quiet in the worst way: `systemctl reload caddy` returns
non-zero and the running server keeps the config it already had, so the
webhook goes on working and nothing looks broken — but nothing else you
changed took effect either, and the next `systemctl restart caddy` or reboot
is where the box comes up with no Caddy, webhook included. Give the site its
own name:

    # /etc/caddy/conf.d/app.caddy
    app.example.com {
        log {
            output stderr
        }
        encode zstd gzip
        reverse_proxy 127.0.0.1:3000
    }

`log` is not required, but it makes `journalctl -u caddy` the record for this
site the same way it already is for `/deploy`, rather than depending on what
the installed Caddy logs by default.

The name must resolve to this box before the reload: Caddy asks for the
certificate on the first request, and ACME validates by connecting back to
whatever the name points at. Then:

    install -m 0644 /dev/stdin /etc/caddy/conf.d/app.caddy   # or an editor, then chmod 0644
    caddy validate --config /etc/caddy/Caddyfile
    systemctl reload caddy

`caddy validate` parses the whole imported set and catches the address
collision above, which is the one mistake that is otherwise invisible until a
restart. It does not prove the site serves anything; the check for that is a
request.

`flipd remove <name>` knows nothing about this file. Removing a repo leaves
its site block behind, still answering, pointed at a directory or a port that
is now empty.

## Reverse proxy to the app

The block above, paired with either systemd recipe — [copied
out](deploy-recipes.md#a-systemd-service-copied-out) or [running as
flipd](deploy-recipes.md#a-systemd-service-that-runs-as-flipd). Caddy does not read the release
at all, so nothing about `/var/lib/flipd`'s ownership matters here. This is the
variant to reach for by default.

Bind the app to loopback (`127.0.0.1:3000`, not `0.0.0.0:3000`) so Caddy is the
only thing that can reach it. A port bound on all interfaces is served
directly, TLS-less and unlogged, to anyone who guesses the number.

The health check at the end of the `DEPLOY` recipe should hit the app's own
port, not the public name. Through Caddy it can pass on a stale certificate,
or on the previous release still holding the port.

## Static files, from the copy

Paired with [A static site](deploy-recipes.md#a-static-site). `root` names the directory that
recipe's `DEPLOY` rsyncs into — the two have to be the same path — and Caddy
serves it as an ordinary directory, never looking at `/var/lib/flipd`:

    app.example.com {
        log {
            output stderr
        }
        root * /var/www/app.example.com
        encode zstd gzip
        file_server
    }

For a single-page app, the router needs every unknown path to return the
shell:

        handle {
            try_files {path} /index.html
            file_server
        }

Put `try_files` behind a `handle` that runs after any `handle /api/*` block, or
a missing API route returns `index.html` with a `200` and the client parses
HTML as JSON.

## Static files, straight from `current`

The copy can be skipped. `root` is resolved per request, so pointing it at the
`current` symlink means the atomic flip is picked up with no reload and no
rsync, and flipd's own prune is the only thing that has to clean up:

    root * /var/lib/flipd/app/current/dist

`DEPLOY` is then just a check that the build landed, as in [Something that
needs no privilege at all](deploy-recipes.md#something-that-needs-no-privilege-at-all).

The cost is a permission change, and it is the reason this is not the default.
Caddy runs as its own user, and every directory in that path is closed to it:
`/var/lib/flipd` is `0750 flipd:flipd` from `install.sh`, and
`/var/lib/flipd/<name>` is `0750 flipd:flipd` from `flipd add`. The `caddy`
user cannot traverse either one.

Granting only what is needed, per repo, with ACLs rather than by loosening the
tree for everyone:

    setfacl -m u:caddy:x /var/lib/flipd
    setfacl -R -m u:caddy:rX -m d:u:caddy:rX /var/lib/flipd/app

The `d:` entries are the load-bearing part. Every build creates a new
`releases/<id>/` directory, and only a default ACL on the parent is inherited
by directories that do not exist yet; a plain recursive `setfacl` grants access
to today's releases and none of tomorrow's, which fails on the first deploy
after it is set up rather than immediately.

What that exposes, and what it does not: the `caddy` user gains read access to
every release of that one repo — including anything the build wrote into the
tree, which is where a bundled `.env` or a baked-in key would be. It does not
gain the deploy key, which `flipd add` writes at mode `0600`, and it does not
gain the env files or the repo conf, which live under `/etc/flipd` and are
`0640 root:flipd`. Whether that trade is worth skipping an rsync depends on
what the build puts in `dist/`.

## The webhook's connection cap is not involved

flipd's listener caps itself at eight concurrent connections
(`server.maxConnections` in `lib/hook.mjs`), because it buffers an unverified
body until the HMAC can be checked. That cap applies to `127.0.0.1:9000` and
nothing else. A `file_server` site reads the filesystem and has no upstream;
a `reverse_proxy` site has a different upstream, and Caddy pools connections
per upstream address. Site traffic cannot consume a webhook slot, and no
amount of it makes a delivery more likely to be dropped.
