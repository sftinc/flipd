import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('install.sh parses under sh -n and its first real step is the root check', async () => {
  await run('sh', ['-n', 'install.sh']);
  // Static only: never execute the installer from the test suite (it would run for real as root).
  const text = await fs.readFile('install.sh', 'utf8');
  const firstAction = text.split('\n').findIndex((l) => /^\s*(useradd|install |mkdir|cat >|ln |systemctl|apt-get|curl|chown |chmod |sed -i|printf[^\n]*>{1,2} *\/)/.test(l));
  const rootCheck = text.split('\n').findIndex((l) => /id -u.*-eq 0/.test(l));
  assert.ok(rootCheck >= 0 && rootCheck < firstAction, 'root check precedes any action');
  assert.match(text, /\( *umask 027/, 'umask is scoped to a subshell');
  assert.match(text, /x-github-event: ping/i, 'the path proof is a signed ping');
  // The signed-ping proof must never pass the webhook secret as a command-line
  // argument: that publishes it in /proc/<pid>/cmdline for any local user to
  // read with ps. It must go through the environment instead. The anti-pattern
  // is a node -e invocation's closing quote immediately followed by "$SECRET"
  // as a trailing argv token -- exactly the brief's original vulnerable line;
  // note the regex must match the code's actual `.digest("hex")` (quoted),
  // not an unquoted `hex` that could never appear and so could never fail.
  assert.doesNotMatch(text, /\)'\s*"\$SECRET"\)/, 'no node -e invocation receives $SECRET as a trailing argv token');
  const secretLineIndex = text.split('\n').findIndex((l) => /process\.argv\[1\]/.test(l) && /SECRET|secret/.test(l));
  assert.equal(secretLineIndex, -1, 'the HMAC script never reads the secret from argv');
  assert.match(text, /SECRET="\$SECRET"/, 'the secret reaches node through the environment');
  assert.match(text, /process\.env\.SECRET/, 'the HMAC script reads the secret from the environment');
  // The unit's socket directory is root:remote-deploy only (by design, not a
  // bug) -- an ordinary admin account needs group membership to use status,
  // check, run and rollback. The installer must say so as a named step.
  assert.match(text, /usermod -aG remote-deploy/, 'installer prints the group-membership next step');
  // --host is interpolated into a Caddyfile block and a URL with no quoting
  // at all; it must be checked against a hostname shape before use. Anchored
  // on `case "$HOST" in`, which only the host-shape check can satisfy --
  // unlike a bare `grep -qE`, which also matches the unrelated Caddyfile
  // `import conf.d/*` probe later in the file and would pass even if the
  // entire HOST_RE block were deleted.
  assert.match(text, /case "\$HOST" in/, 'installer validates --host against a hostname shape via a case glob');
  // A `case` glob matches the whole string as one unit, so it (unlike a
  // per-line `grep -E "^...$"`) also rejects a value that smuggles a newline:
  // a value with an embedded newline can satisfy an anchored per-line grep on
  // whichever line matches, letting the rest of the string ride along
  // unchecked into a `sed` script and a Caddy config.
  assert.match(text, /\[!A-Za-z0-9\.-\]/, 'the case glob rejects any character outside a hostname, including a smuggled newline');
  // $HERE gets embedded in a systemd unit's ExecStart (see the next test) and
  // used throughout the script; it needs its own character-class guard, in
  // the same style, distinguishable from HOST's (this one allows '/' and '_'
  // for a real filesystem path, and forbids the same dangerous set: whitespace,
  // '&', '|', backslash).
  assert.match(text, /case "\$HERE" in/, 'installer validates $HERE against a safe character set via a case glob');
  assert.match(text, /\[!A-Za-z0-9\/_\.-\]/, 'the $HERE glob rejects whitespace, &, |, and backslash');
});

test('install.sh: an existing conf is always reconciled to root:remote-deploy 0640', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const lines = text.split('\n');
  // Must be unconditional -- not indented inside the "file did not exist yet"
  // branch -- or an operator's hand-written conf (root:root 0600, as both the
  // README and `add`'s own output leave someone to create by hand) never gets
  // fixed by a re-run, and the service (User=remote-deploy) gets EACCES and
  // crash-loops under Restart=on-failure forever.
  const chownLine = lines.findIndex((l) => /^chown root:remote-deploy \/etc\/remote-deploy\/remote-deploy\.conf$/.test(l));
  const chmodLine = lines.findIndex((l) => /^chmod 0640 \/etc\/remote-deploy\/remote-deploy\.conf$/.test(l));
  assert.ok(chownLine >= 0, 'chown runs at top level, not nested inside the create-branch');
  assert.ok(chmodLine >= 0, 'chmod runs at top level, not nested inside the create-branch');
  // And it must run after both the create and the --host-rewrite branches, so
  // it applies regardless of which one ran (or neither).
  const ifBranch = lines.findIndex((l) => /^if \[ ! -f \/etc\/remote-deploy\/remote-deploy\.conf \]; then$/.test(l));
  assert.ok(ifBranch >= 0 && ifBranch < chownLine && ifBranch < chmodLine);
});

test('install.sh: the service is verified to still be running, not just successfully (re)started', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // Type=simple means `restart`/`enable --now` return the instant the process
  // execs; a bad conf, EACCES, or a missing secret all crash within
  // milliseconds under Restart=on-failure, indistinguishable from a healthy
  // start unless something checks again after a settle.
  assert.match(text, /systemctl is-active --quiet remote-deploy/, 'installer checks the service is actually active after (re)starting it');
  // Anchored on the exact startup-liveness message, not a bare
  // "journalctl -u remote-deploy" search: that string also appears in the
  // unrelated Caddy ping diagnostic later in the file, so a regression that
  // deleted the startup hint specifically (while leaving the Caddy one)
  // would otherwise still pass.
  assert.match(text, /did not stay running; check: journalctl -u remote-deploy/, 'a failed startup names the log to check, specifically in the startup-liveness message');
  // Every run restarts, not just the first: `enable --now` is a no-op on an
  // already-enabled, already-running unit, so a re-run after `git pull` must
  // not leave old code running under a clean transcript.
  assert.match(text, /^systemctl restart remote-deploy \|\| fail_started$/m, 'every run restarts the service, not just the first, and a failed restart itself is caught');
  assert.match(text, /^systemctl is-active --quiet remote-deploy \|\| fail_started$/m, 'a restart that "succeeds" but does not stay up is caught by the same path');
});

test('install.sh: systemctl enable and restart failures are surfaced, not swallowed by set -e with no output', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // A masked unit, or a box where systemd is not PID 1, must not exit the
  // script silently: stderr must stay visible (only stdout's "Created
  // symlink ..." chatter is muted) and a failure must print our own message
  // before exiting, the way the liveness check does.
  assert.doesNotMatch(text, /systemctl enable remote-deploy >\/dev\/null 2>&1/, 'systemctl enable no longer swallows stderr');
  assert.match(text, /systemctl enable remote-deploy >\/dev\/null \|\| \{ echo/, 'a failed systemctl enable prints its own diagnostic and exits, rather than aborting silently under set -e');
  // `restart` itself can fail outright (e.g. a broken ExecStart path) before
  // ever reaching the is-active settle-check below it; both failure paths
  // must land on the same journalctl hint.
  assert.match(text, /fail_started\(\) \{/, 'a shared helper prints the journalctl hint for both restart-failed and stayed-down cases');
});

test('install.sh: the installed unit points at this clone, wherever it lives, without a truncating write in the failure path', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  assert.match(text, /"ExecStart=" ENVIRON\["HERE"\] "\/bin\/remote-deploy serve"/, 'installer substitutes $HERE into the unit when the clone is not at /opt/remote-deploy');
  assert.match(text, /HERE" = \/opt\/remote-deploy/, 'installer only uses the shipped unit file verbatim when the clone actually is at /opt/remote-deploy');
  // Not sed: $HERE lands in a sed *replacement* string, where '&' and a
  // backslash are metacharacters -- '&' re-inserts the whole matched line
  // (mangling it) and a broken replacement script would abort mid-write.
  // awk's ENVIRON does no such processing (unlike `awk -v`, which does).
  assert.match(text, /ENVIRON\["HERE"\]/, 'the unit substitution reads $HERE via awk ENVIRON, immune to replacement-string metacharacters');
  assert.doesNotMatch(text, /sed ["'][^"']*ExecStart/, 'ExecStart substitution does not go through sed');
  // The substituted unit must never be written via a truncating redirect
  // straight to the live path: a mid-write failure there would leave
  // /etc/systemd/system/remote-deploy.service at zero bytes, with set -e
  // aborting before daemon-reload runs again -- reproduced on every later
  // run. It must be built in a temp file and moved into place with `install`.
  assert.doesNotMatch(text, />\s*\/etc\/systemd\/system\/remote-deploy\.service/, 'the unit is never written by a direct redirect to the live path');
  assert.match(text, /UNIT_TMP/, 'the substituted unit is built in a temp file first');
  assert.match(text, /install -m 0644 "\$UNIT_TMP" \/etc\/systemd\/system\/remote-deploy\.service/, 'the temp file is moved into place with install, not a redirect');
});

test('install.sh: the Caddy keyring step is skip-if-present, and the group hint and logrotate print before the service and Caddy sections', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const lines = text.split('\n');
  // gpg --dearmor -o refuses non-interactively to overwrite an existing file;
  // `command -v caddy` alone does not guard it, so a first run that wrote the
  // keyring and then failed later (e.g. a network blip at `apt-get update`)
  // must not wedge every subsequent run at this exact line forever.
  assert.match(text, /\[ ! -e \/usr\/share\/keyrings\/caddy-stable-archive-keyring\.gpg \]/, 'the keyring write is guarded by the keyring file\'s own existence');
  // The group-membership hint (and logrotate) must print before BOTH the
  // service-liveness gate and the Caddy section: either can abort under
  // `set -e` for reasons unrelated to remote-deploy itself (a bad hand-written
  // conf; a pre-existing Caddyfile with a syntax error failing `reload` and
  // `restart`), and an operator who never sees the hint has no way to tell a
  // permissions problem from a dead service the next time `status` reports one.
  const logrotateIndex = lines.findIndex((l) => /^# 7\. logrotate$/.test(l));
  const usermodIndex = lines.findIndex((l) => /usermod -aG remote-deploy/.test(l));
  const serviceSectionIndex = lines.findIndex((l) => /^# 8\. service$/.test(l));
  const caddySectionIndex = lines.findIndex((l) => /^# 9\. Caddy$/.test(l));
  assert.ok(logrotateIndex >= 0 && serviceSectionIndex >= 0, 'both section markers exist');
  assert.ok(logrotateIndex < serviceSectionIndex, 'logrotate installs before the service-liveness gate, which can abort for reasons unrelated to logrotate');
  assert.ok(usermodIndex >= 0 && usermodIndex < serviceSectionIndex, 'the usermod hint prints before the service-liveness gate, which can abort a bad hand-written conf');
  assert.ok(caddySectionIndex >= 0 && usermodIndex < caddySectionIndex, 'the usermod hint prints before the Caddy section starts too');
});

test('install.sh: refuses an empty GitHub host-key response, and makes the entry point executable before starting the service', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const lines = text.split('\n');
  // curl and node can both succeed with a response that carries no ssh_keys;
  // printf writing that would still leave a non-empty known_hosts (even a
  // lone newline satisfies `[ -s ... ]`), silently skipping this block on
  // every future run and wedging every git fetch on host key verification.
  assert.match(text, /\[ -n "\$KEYS" \]/, 'installer refuses to write known_hosts when GitHub returned no ssh_keys');
  // systemd execs bin/remote-deploy directly; it must already be +x before
  // the service starts, not only before the /usr/local/bin symlink is made --
  // latent today because bin/remote-deploy is 100755 in git, but a checkout
  // that lost the mode bit must not abort at the service step before ever
  // reaching a chmod that would have fixed it.
  const chmodXIndex = lines.findIndex((l) => /chmod \+x "\$HERE\/bin\/remote-deploy"/.test(l));
  const serviceSectionIndex = lines.findIndex((l) => /^# 8\. service$/.test(l));
  assert.ok(chmodXIndex >= 0 && serviceSectionIndex >= 0 && chmodXIndex < serviceSectionIndex, 'the entry point is chmod +x before the service section starts it');
});

test('unit file and logrotate say what the spec says', async () => {
  const unit = await fs.readFile('remote-deploy.service', 'utf8');
  assert.match(unit, /^User=remote-deploy$/m);
  assert.match(unit, /^ExecStart=\/opt\/remote-deploy\/bin\/remote-deploy serve$/m);
  assert.match(unit, /^RuntimeDirectory=remote-deploy$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  const lr = await fs.readFile('remote-deploy.logrotate', 'utf8');
  assert.match(lr, /\/var\/log\/remote-deploy\/\*\/events\.log/);
  assert.match(lr, /monthly/);
  assert.match(lr, /rotate 12/);
});
