#!/bin/sh
# install.sh -- set up flipd on this box. Idempotent: every step is skip-if-present.
#
#   sudo /opt/flipd/install.sh [--host deploy.example.com]
#
# --host installs and wires Caddy for that name. The name must already resolve
# to this box. Without --host, everything else happens and the Caddy block is
# printed to paste by hand.
set -eu
# The --host and $HERE checks below rely on `case` glob character-class ranges
# (A-Za-z0-9) meaning exactly the C-locale byte ranges they read as. Ranges
# are locale-collated, and `sudo` preserves LANG/LC_* by default, so under a
# UTF-8 locale a range like a-z can collate in characters like 'é' that are
# not ASCII letters at all -- a guard that does not guard what it says is
# worth nothing the day it matters. Force C for the life of this script.
export LC_ALL=C

HOST=
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a name}"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --host is interpolated verbatim into a Caddyfile server block and into the
# ping URL below; a malformed value would land in a config that root then
# asks systemd to reload. Check its shape before it is used anywhere.
#
# The character-class case check comes first and on its own: glob matching in
# `case` applies to the whole value as one string, with no per-line semantics,
# so it also catches a value that carries an embedded newline (which a
# per-line `grep -E "^...$"` over the same bytes would miss a match for on
# whichever line matched, letting the rest ride along unchecked into a `sed`
# script and a Caddy config). Only once every byte is known to be a hostname
# character does the second check apply the actual hostname shape.
HOST_RE='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
if [ -n "$HOST" ]; then
  case "$HOST" in
    *[!A-Za-z0-9.-]*) echo "install.sh: --host '$HOST' contains a character that is not a letter, digit, '.' or '-'" >&2; exit 1 ;;
  esac
  printf '%s' "$HOST" | grep -qE "$HOST_RE" || { echo "install.sh: --host '$HOST' does not look like a hostname" >&2; exit 1; }
fi

[ "$(id -u)" -eq 0 ] || { echo "install.sh must run as root (use sudo)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
# $HERE is later embedded in a systemd unit's ExecStart (see step 8) and used
# unquoted-adjacent in several shell constructs throughout this script; a
# path containing whitespace, '&', '|', a backslash, or '%' is unsafe in at
# least one of those contexts (word-splitting a systemd ExecStart, or acting
# as a metacharacter to a text-processing tool or to systemd's own specifier
# expansion). Refuse it once, here, rather than downstream where the failure
# mode is a mangled or truncated systemd unit. The guard is deliberately not
# narrower than that: now that the unit is built with awk's ENVIRON (which
# passes bytes through unchanged) instead of a sed replacement string, '+',
# '@', '~', ':' and ',' are all just bytes to it, so a clone at, say,
# /srv/dev+ops/flipd has no reason to be refused.
case "$HERE" in
  *[!A-Za-z0-9/_.+@~:,-]*) echo "install.sh: this clone's path ($HERE) has a character unsafe to embed in a systemd unit; move the clone to a path using only letters, digits, '/', '_', '.', '+', '@', '~', ':', ',', '-'" >&2; exit 1 ;;
esac
say() { printf '%s\n' "$*"; }

# 1. prerequisites
command -v git >/dev/null || { echo "git is required: apt install git" >&2; exit 1; }
command -v node >/dev/null || { echo "node 20 or newer is required" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "node 20 or newer is required, found $(node -v)" >&2; exit 1; }
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is required: apt install openssh-client" >&2; exit 1; }

# 2. user
if ! id flipd >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/flipd --shell /usr/sbin/nologin --user-group flipd
  say "created user flipd"
fi

# 3. trees
install -d -m 0750 -o root -g flipd /etc/flipd /etc/flipd/repos /etc/flipd/env
install -d -m 0750 -o flipd -g flipd /var/lib/flipd /var/lib/flipd/.ssh /var/log/flipd
say "created /etc/flipd  /var/lib/flipd  /var/log/flipd"

# 4. main config
if [ ! -f /etc/flipd/flipd.conf ]; then
  SECRET=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
  ( umask 027; cat > /etc/flipd/flipd.conf <<EOF
LISTEN=127.0.0.1:9000
${HOST:+PUBLIC_HOST=$HOST}
WEBHOOK_SECRET=$SECRET
KEEP=5
LOG_KEEP=50
LOG_MAX_BYTES=52428800
EOF
  )
  sed -i '/^$/d' /etc/flipd/flipd.conf
  say "wrote /etc/flipd/flipd.conf  (LISTEN=127.0.0.1:9000, new WEBHOOK_SECRET)"
elif [ -n "$HOST" ]; then
  if grep -q '^PUBLIC_HOST=' /etc/flipd/flipd.conf; then
    sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$HOST|" /etc/flipd/flipd.conf
  else
    printf 'PUBLIC_HOST=%s\n' "$HOST" >> /etc/flipd/flipd.conf
  fi
  say "set PUBLIC_HOST=$HOST in /etc/flipd/flipd.conf"
fi
# Unconditional, on every run, whether the file was just created, just edited
# for --host, or untouched this time: an operator who hand-writes this file
# before the first install (both the README and `add`'s own output point at
# it) leaves it root:root 0600, and a run that only fixed ownership inside the
# "just created" branch above would never repair that -- the service, which
# runs as User=flipd, would then get EACCES and crash-loop forever.
# Same story if a previous run died between the heredoc and this chown/chmod.
chown root:flipd /etc/flipd/flipd.conf
chmod 0640 /etc/flipd/flipd.conf

# 5. GitHub host keys
if [ ! -s /var/lib/flipd/.ssh/known_hosts ]; then
  KEYS=$(curl -fsS https://api.github.com/meta | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      const m=JSON.parse(s); for (const k of m.ssh_keys) console.log("github.com " + k); })') \
    || { echo "could not fetch GitHub host keys from api.github.com/meta; refusing to write an empty known_hosts" >&2; exit 1; }
  # curl and node can both succeed with an empty (or keyless) response; that is
  # not "no ssh_keys", it is "GitHub sent nothing useful", and writing it would
  # leave a non-empty known_hosts (even a single newline satisfies `[ -s ]`
  # above) that this whole block would then skip on every future run, wedging
  # every git fetch on host key verification with no way to retry short of
  # deleting the file by hand.
  [ -n "$KEYS" ] || { echo "api.github.com/meta returned no ssh_keys; refusing to write an empty known_hosts" >&2; exit 1; }
  printf '%s\n' "$KEYS" > /var/lib/flipd/.ssh/known_hosts
  chown flipd:flipd /var/lib/flipd/.ssh/known_hosts; chmod 0644 /var/lib/flipd/.ssh/known_hosts
  say "wrote known_hosts from api.github.com/meta"
fi

# 6. command (before the service starts: systemd execs this file directly,
# so it must already be +x, and a checkout that lost the mode bit must not
# leave the service unstarted only because this ran after it)
ln -sfn "$HERE/bin/flipd" /usr/local/bin/flipd
chmod +x "$HERE/bin/flipd"
say "linked /usr/local/bin/flipd"

# 7. logrotate
# /etc/logrotate.d does not exist on every box (a slim container or a
# minbase image can lack it -- logrotate is only Priority: important, so
# both exclude it by default), and `install` (without -d/-D) does not create
# a missing destination directory; it exits 71. Now that this step runs
# ahead of the service section, that used to be a harmless post-service
# failure and would now be a hard abort before the unit is even written --
# create the directory explicitly first, the same way the Caddy conf.d step
# below does.
install -d -m 0755 /etc/logrotate.d
install -m 0644 "$HERE/flipd.logrotate" /etc/logrotate.d/flipd

# The socket at /run/flipd/flipd.sock and /var/log/flipd
# are group-owned by flipd on purpose (that is the entire access control for
# run/rollback/check, and for log) -- so any admin account other than root
# needs group membership to use flipd without sudo. Both are owned
# flipd:flipd, unlike /etc/flipd/flipd.conf, which is root:flipd so that the
# service can read the secret but not rewrite it. Printed here,
# before both the service-liveness gate and the Caddy section below -- either
# can still abort under `set -e` for reasons that have nothing to do with
# flipd itself (a bad hand-written conf, or a pre-existing Caddyfile
# with a syntax error failing both `reload` and `restart`) -- and an operator
# who never sees this line has no way to tell a permissions problem from a
# dead service the next time `status` says so.
ADMIN_USER="${SUDO_USER:-<your-user>}"
cat <<EOF

so your own login can run 'status', 'check', 'run', 'rollback' and 'log' without sudo:
  sudo usermod -aG flipd $ADMIN_USER
this takes effect on your next login (or run 'newgrp flipd' in the current shell).
EOF

# 8. service
# The shipped unit hardcodes ExecStart=/opt/flipd/bin/flipd so the
# static test's assertion means something concrete; a clone anywhere else must not
# be a hard requirement with no safety value, so when $HERE differs, substitute the
# real path into the installed copy instead and say so, out loud, every time it
# happens -- the installed unit must never silently disagree with the file in the repo.
if [ "$HERE" = /opt/flipd ]; then
  install -m 0644 "$HERE/flipd.service" /etc/systemd/system/flipd.service
else
  # Not sed: $HERE lands in a sed *replacement* string, where '&' re-inserts
  # the whole matched line (silently mangling it, e.g. a clone at /opt/a&b)
  # and a backslash is also special -- and that output was going through a
  # truncating `>` redirect, so a broken replacement left the live unit file
  # at zero bytes with `set -e` aborting before `daemon-reload` ever ran
  # again, and every later run reproducing the same truncation identically.
  # awk's ENVIRON does no replacement-metacharacter or backslash-escape
  # processing (unlike `awk -v`, which does), and writing to a temp file
  # first means a failure here can never truncate the live unit.
  UNIT_TMP=$(mktemp)
  # Not just "rm -f $UNIT_TMP" after the install below: that line is never
  # reached if awk or install fails first, leaking the temp file (nothing
  # secret in it, but still worth cleaning up). A trap runs on any exit.
  trap 'rm -f "$UNIT_TMP"' EXIT
  HERE="$HERE" awk '
    /^ExecStart=/ { print "ExecStart=" ENVIRON["HERE"] "/bin/flipd serve"; next }
    { print }
  ' "$HERE/flipd.service" > "$UNIT_TMP"
  install -m 0644 "$UNIT_TMP" /etc/systemd/system/flipd.service
  say "note: this clone is at $HERE, not /opt/flipd; installed unit's ExecStart was rewritten to $HERE/bin/flipd serve"
fi
systemctl daemon-reload
# systemctl's own progress line ("Created symlink ...") goes to stderr
# already (systemd's log_info(), not stdout), so there is nothing to mute
# here and no redirect is needed: a masked unit, or a box where systemd is
# not PID 1, must abort with systemctl's own diagnostic plus a line of our
# own, not silently under `set -e` with every stream swallowed.
systemctl enable flipd || { echo "systemctl enable flipd failed (see the systemctl output above); is systemd running as PID 1 on this box?" >&2; exit 1; }
fail_started() {
  echo "flipd.service did not stay running; check: journalctl -u flipd" >&2
  exit 1
}
# Always (re)start, not just on first install: `enable` alone does not start a
# unit, and re-running `enable --now` on an already-running unit would be a
# no-op, leaving old code running under a clean-looking transcript after
# `git pull`. `restart`'s own exit status catches an ExecStart systemd cannot
# even launch (a broken path, say); Type=simple means a successful `restart`
# tells us nothing more than "the new process execs", so a bad conf, a
# permissions mistake, or a missing secret can still exit within milliseconds
# under Restart=on-failure/RestartSec=3 -- give it a moment to settle, then
# check for real. Both failure paths land on the same message.
systemctl restart flipd || fail_started
sleep 2
systemctl is-active --quiet flipd || fail_started
say "flipd.service is enabled and running"

# 9. Caddy
# `log` goes to stderr, which the Debian unit sends to journald, so
# `journalctl -u caddy` shows every request to this site with its source IP,
# method, URI and status. That is the only record of a request flipd never
# receives -- a TLS failure, a 404 on the wrong path, a proxy that never
# forwarded -- and on a first install it is how an operator confirms that
# GitHub's ping arrived at all. Not `output file`: the unit's sandbox refuses
# writes under /var/log/caddy even when caddy owns the directory.
# The filter drops X-Hub-Signature-256 from the logged request headers. It is
# an HMAC of the body under WEBHOOK_SECRET, so it is inside the never-print
# rule, and Caddy's default header redaction (Cookie, Authorization) does not
# know it. Without the body the value is not replayable -- except for the
# installer's own ping, whose body is a fixed literal -- but "not exploitable
# today" is not the standard; "never logged" is.
CADDY_BLOCK="${HOST:-deploy.example.com} {
    log {
        output stderr
        format filter {
            wrap json
            fields {
                request>headers>X-Hub-Signature-256 delete
            }
        }
    }
    handle /deploy {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        respond 404
    }
}"
if [ -n "$HOST" ]; then
  if ! command -v caddy >/dev/null; then
    if command -v apt-get >/dev/null; then
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
      # gpg --dearmor -o refuses non-interactively to overwrite an existing file, and
      # `command -v caddy` is not a proxy for "the keyring was written": a first run
      # that wrote the keyring and then hit a network blip at `apt-get update` would
      # otherwise abort here on every later run too, forever, before ever reaching
      # the caddy install, the Caddyfile edit or the ping proof below.
      if [ ! -e /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      fi
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update >/dev/null && apt-get install -y caddy >/dev/null
      say "installed caddy (apt)"
    else
      echo "caddy is not installed and this is not a Debian/Ubuntu box; install it from https://caddyserver.com/docs/install and re-run with --host" >&2
      exit 1
    fi
  fi
  install -d -m 0755 /etc/caddy/conf.d
  printf '%s\n' "$CADDY_BLOCK" > /etc/caddy/conf.d/flipd.caddy
  chmod 0644 /etc/caddy/conf.d/flipd.caddy   # root's umask may be 077; caddy runs as its own user
  say "wrote /etc/caddy/conf.d/flipd.caddy  for $HOST"
  if ! grep -qE '^\s*import\s+(/etc/caddy/)?conf\.d/\*' /etc/caddy/Caddyfile 2>/dev/null; then
    printf '\nimport /etc/caddy/conf.d/*\n' >> /etc/caddy/Caddyfile
    say 'added "import /etc/caddy/conf.d/*" to /etc/caddy/Caddyfile'
  fi
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl reload caddy || systemctl restart caddy
  say "reloaded caddy"
  # Prove the path end to end: a ping signed with this box's secret gets "pong"
  # from flipd and nothing else. (Caddy stamps its own Server header on proxied
  # responses too, so a bare 404 could never tell the two apart.)
  SECRET=$(sed -n 's/^WEBHOOK_SECRET=//p' /etc/flipd/flipd.conf)
  BODY='{"zen":"install check"}'
  # SECRET reaches node through the environment, not argv: an argument would be
  # published for the life of this process in /proc/<pid>/cmdline, readable by
  # any local user with ps. /proc/<pid>/environ is readable only by root.
  SIG=$(printf '%s' "$BODY" | SECRET="$SECRET" node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      console.log("sha256=" + require("crypto").createHmac("sha256", process.env.SECRET).update(s).digest("hex")); })')
  # Caddy accepts connections the instant it is reloaded, but on a first install
  # it has no certificate yet -- it is still finishing an ACME order, and until
  # that lands every TLS handshake, this one included, fails outright. A single
  # fixed pause cannot straddle that: issuance took about four seconds on the
  # first real install, so `sleep 2` reported NOT OK on an install that was in
  # fact perfect and sent the operator to journalctl for a problem that had
  # already resolved itself. A false alarm here is worse than a slow check,
  # because it teaches the operator to disbelieve the one line that is supposed
  # to prove the path end to end.
  #
  # So: retry with a growing gap. The first wait is short enough that a re-run
  # on a warm box -- certificate already on disk -- answers on attempt one and
  # costs 3s, while the widening tail covers a cold ACME order without letting
  # a genuinely broken DNS record hang the install indefinitely. Total ceiling
  # is 50s across five attempts, then it reports failure as before.
  ANSWER=
  WAITED=0
  for DELAY in 3 5 8 13 21; do
    sleep "$DELAY"
    WAITED=$((WAITED + DELAY))
    ANSWER=$(curl -s -m 15 -X POST "https://$HOST/deploy" -H "x-github-event: ping" -H "x-hub-signature-256: $SIG" \
             -H 'content-type: application/json' --data "$BODY" || echo "(no response)")
    # An explicit `if`, not `[ ... ] && break`: under `set -e` a trailing
    # `&&` list that tests false is a failing command at statement level, and
    # would abort the install on the very first not-yet-ready attempt.
    if [ "$ANSWER" = "pong" ]; then break; fi
  done
  if [ "$ANSWER" = "pong" ]; then
    say "POST https://$HOST/deploy (signed ping)  ->  pong   ok (${WAITED}s)"
  else
    say "POST https://$HOST/deploy (signed ping)  ->  '$ANSWER'   NOT OK after ${WAITED}s: check DNS for $HOST, 'journalctl -u caddy', 'journalctl -u flipd'"
  fi
fi

if [ -z "$HOST" ]; then
  cat <<EOF

no --host given, so Caddy was not touched. To terminate TLS, put this in your Caddyfile and reload caddy:
$(printf '%s\n' "$CADDY_BLOCK" | sed 's/^/  /')
or re-run:  sudo $0 --host deploy.example.com
EOF
fi

say ""
say "next: sudo flipd add <git-url>   (a DEPLOY that needs root: see README, Permissions)"
