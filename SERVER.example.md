# SERVER.example.md

The shape for `SERVER.md`: what is true about a box flipd runs on — this
repository's own test box, or an operator's server you were pointed at. Copy the
block below and fill it in. This file is tracked, so it holds placeholders and
rules and nothing else; a real address never appears in it.

## `SERVER.md` is never tracked

Add it to `.gitignore` **before** you create it, not after. Between writing the
file and ignoring it there is a window where a `git add -A` or an obliging
commit takes a server's address public, and a repository's history does not
forget. This repository already ignores it; any other repository is yours to
check:

    grep -qx 'SERVER.md' .gitignore || printf 'SERVER.md\n' >> .gitignore

If the repository belongs to someone else, ask them before you create the file
at all. It is their tree.

## What goes in it

An address, an SSH user, the *path* to the key, hostnames, ports, what serves
what, and any quirk that cost you an hour once — everything you would otherwise
have to rediscover by logging in and looking around.

**Not one secret.** Not a private key, not a forge token, not `WEBHOOK_SECRET`,
not an env-file value. Name the key's path, never its contents; name the file a
secret lives in, never the value. Git-ignored is still a file on a laptop, in a
backup, and in whatever indexes that directory — the ignore rule protects it
from one mistake, not from every one.

## The block

One per box. A second box is a second copy of this, not a second file.

    ## <what you would call this box out loud>

    ### What it is

    What the box is for, what it runs, and anything true of it that is not true
    of a fresh server: what else lives on it, who else has access, whether flipd
    deploys the same repository the service itself runs from — two checkouts,
    where upgrading the service is a separate act from deploying it and no
    deploy does it for you.

    ### Access

        ssh -i <path to key> <user>@<address>

    Whether there is an `~/.ssh/config` entry or the key has to be passed every
    time. Root, `sudo`, or neither. Then the two or three commands you always
    run first on this box.

    ### The public endpoint

    The webhook URL, what terminates TLS, where it proxies to, where DNS is
    hosted, and any setting there that has to stay as it is. Then the
    end-to-end check for this box: confirm a change behaviourally, not by
    reading config — a validator proves syntax, not that a field path matched.
    A signed ping is the check that proves the whole path and starts no build.

    ### Posture, as of <date>

    What you checked and what you found: SSH authentication methods, firewall,
    fail2ban, which ports are open. Date it, because it is a claim about a
    moment and not about the box. A box you have not checked says so, rather
    than saying nothing.

    ### Quirks

    Whatever surprised you, and what to do about it — the one-off with no home
    in the four sections above. Optional, and the only one that is: leave the
    heading out when nothing is left over rather than carrying it empty. Most
    of what feels like a quirk belongs in Access or The public endpoint, which
    is why a well-behaved box often has none.
