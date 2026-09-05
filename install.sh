#!/bin/sh
# install.sh -- set up remote-deploy on this box. Idempotent: every step is skip-if-present.
#
#   sudo /opt/remote-deploy/install.sh [--host deploy.example.com]
#
# --host installs and wires Caddy for that name. The name must already resolve
# to this box. Without --host, everything else happens and the Caddy block is
# printed to paste by hand.
set -eu

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
HOST_RE='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
if [ -n "$HOST" ] && ! printf '%s' "$HOST" | grep -qE "$HOST_RE"; then
  echo "install.sh: --host '$HOST' does not look like a hostname" >&2
  exit 1
fi

[ "$(id -u)" -eq 0 ] || { echo "install.sh must run as root (use sudo)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
say() { printf '%s\n' "$*"; }

# 1. prerequisites
command -v git >/dev/null || { echo "git is required: apt install git" >&2; exit 1; }
command -v node >/dev/null || { echo "node 20 or newer is required" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "node 20 or newer is required, found $(node -v)" >&2; exit 1; }
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is required: apt install openssh-client" >&2; exit 1; }

# 2. user
if ! id remote-deploy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/remote-deploy --shell /usr/sbin/nologin --user-group remote-deploy
  say "created user remote-deploy"
fi

# 3. trees
install -d -m 0750 -o root -g remote-deploy /etc/remote-deploy /etc/remote-deploy/repos /etc/remote-deploy/env
install -d -m 0750 -o remote-deploy -g remote-deploy /var/lib/remote-deploy /var/lib/remote-deploy/.ssh /var/log/remote-deploy
say "created /etc/remote-deploy  /var/lib/remote-deploy  /var/log/remote-deploy"

# 4. main config
if [ ! -f /etc/remote-deploy/remote-deploy.conf ]; then
  SECRET=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
  ( umask 027; cat > /etc/remote-deploy/remote-deploy.conf <<EOF
LISTEN=127.0.0.1:9000
${HOST:+PUBLIC_HOST=$HOST}
WEBHOOK_SECRET=$SECRET
KEEP=5
LOG_KEEP=50
LOG_MAX_BYTES=52428800
EOF
  )
  sed -i '/^$/d' /etc/remote-deploy/remote-deploy.conf
  chown root:remote-deploy /etc/remote-deploy/remote-deploy.conf; chmod 0640 /etc/remote-deploy/remote-deploy.conf
  say "wrote /etc/remote-deploy/remote-deploy.conf  (LISTEN=127.0.0.1:9000, new WEBHOOK_SECRET)"
elif [ -n "$HOST" ]; then
  if grep -q '^PUBLIC_HOST=' /etc/remote-deploy/remote-deploy.conf; then
    sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$HOST|" /etc/remote-deploy/remote-deploy.conf
  else
    printf 'PUBLIC_HOST=%s\n' "$HOST" >> /etc/remote-deploy/remote-deploy.conf
  fi
  say "set PUBLIC_HOST=$HOST in /etc/remote-deploy/remote-deploy.conf"
fi

# 5. GitHub host keys
if [ ! -s /var/lib/remote-deploy/.ssh/known_hosts ]; then
  KEYS=$(curl -fsS https://api.github.com/meta | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      const m=JSON.parse(s); for (const k of m.ssh_keys) console.log("github.com " + k); })') \
    || { echo "could not fetch GitHub host keys from api.github.com/meta; refusing to write an empty known_hosts" >&2; exit 1; }
  printf '%s\n' "$KEYS" > /var/lib/remote-deploy/.ssh/known_hosts
  chown remote-deploy:remote-deploy /var/lib/remote-deploy/.ssh/known_hosts; chmod 0644 /var/lib/remote-deploy/.ssh/known_hosts
  say "wrote known_hosts from api.github.com/meta"
fi

# 6. service
install -m 0644 "$HERE/remote-deploy.service" /etc/systemd/system/remote-deploy.service
systemctl daemon-reload
systemctl enable --now remote-deploy >/dev/null 2>&1 || systemctl restart remote-deploy
say "enabled remote-deploy.service"

# 7. command
ln -sfn "$HERE/bin/remote-deploy" /usr/local/bin/remote-deploy
chmod +x "$HERE/bin/remote-deploy"
say "linked /usr/local/bin/remote-deploy"

# 8. logrotate
install -m 0644 "$HERE/remote-deploy.logrotate" /etc/logrotate.d/remote-deploy

# 9. Caddy
CADDY_BLOCK="${HOST:-deploy.example.com} {
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
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update >/dev/null && apt-get install -y caddy >/dev/null
      say "installed caddy (apt)"
    else
      echo "caddy is not installed and this is not a Debian/Ubuntu box; install it from https://caddyserver.com/docs/install and re-run with --host" >&2
      exit 1
    fi
  fi
  install -d -m 0755 /etc/caddy/conf.d
  printf '%s\n' "$CADDY_BLOCK" > /etc/caddy/conf.d/remote-deploy.caddy
  chmod 0644 /etc/caddy/conf.d/remote-deploy.caddy   # root's umask may be 077; caddy runs as its own user
  say "wrote /etc/caddy/conf.d/remote-deploy.caddy  for $HOST"
  if ! grep -qE '^\s*import\s+(/etc/caddy/)?conf\.d/\*' /etc/caddy/Caddyfile 2>/dev/null; then
    printf '\nimport /etc/caddy/conf.d/*\n' >> /etc/caddy/Caddyfile
    say 'added "import /etc/caddy/conf.d/*" to /etc/caddy/Caddyfile'
  fi
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl reload caddy || systemctl restart caddy
  say "reloaded caddy"
  # Prove the path end to end: a ping signed with this box's secret gets "pong"
  # from remote-deploy and nothing else. (Caddy stamps its own Server header on proxied
  # responses too, so a bare 404 could never tell the two apart.)
  sleep 2
  SECRET=$(sed -n 's/^WEBHOOK_SECRET=//p' /etc/remote-deploy/remote-deploy.conf)
  BODY='{"zen":"install check"}'
  # SECRET reaches node through the environment, not argv: an argument would be
  # published for the life of this process in /proc/<pid>/cmdline, readable by
  # any local user with ps. /proc/<pid>/environ is readable only by root.
  SIG=$(printf '%s' "$BODY" | SECRET="$SECRET" node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      console.log("sha256=" + require("crypto").createHmac("sha256", process.env.SECRET).update(s).digest("hex")); })')
  ANSWER=$(curl -s -m 15 -X POST "https://$HOST/deploy" -H "x-github-event: ping" -H "x-hub-signature-256: $SIG" \
           -H 'content-type: application/json' --data "$BODY" || echo "(no response)")
  if [ "$ANSWER" = "pong" ]; then
    say "POST https://$HOST/deploy (signed ping)  ->  pong   ok"
  else
    say "POST https://$HOST/deploy (signed ping)  ->  '$ANSWER'   NOT OK: check DNS for $HOST, 'journalctl -u caddy', 'journalctl -u remote-deploy'"
  fi
fi

cat <<EOF

sudoers, for a DEPLOY command that needs root (one script, no password):
  echo 'remote-deploy ALL=(root) NOPASSWD: /usr/local/bin/<your-adopt-script>' > /etc/sudoers.d/remote-deploy
  chmod 0440 /etc/sudoers.d/remote-deploy
EOF
if [ -z "$HOST" ]; then
  cat <<EOF

no --host given, so Caddy was not touched. To terminate TLS, put this in your Caddyfile and reload caddy:
$(printf '%s\n' "$CADDY_BLOCK" | sed 's/^/  /')
or re-run:  sudo $0 --host deploy.example.com
EOF
fi

# The socket and /run/remote-deploy are root:remote-deploy, mode 0660/0750, on
# purpose (that is the entire access control for run/rollback/check, and so
# is /var/log/remote-deploy for log) -- so any admin account other than root
# needs group membership to use remote-deploy without sudo.
ADMIN_USER="${SUDO_USER:-<your-user>}"
cat <<EOF

so your own login can run 'status', 'check', 'run', 'rollback' and 'log' without sudo:
  sudo usermod -aG remote-deploy $ADMIN_USER
this takes effect on your next login (or run 'newgrp remote-deploy' in the current shell).
EOF

say ""
say "next: sudo remote-deploy add <git-url>"
