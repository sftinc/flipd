import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';

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
  // The unit's socket directory is root:flipd only (by design, not a
  // bug) -- an ordinary admin account needs group membership to use status,
  // check, run and rollback. The installer must say so as a named step.
  assert.match(text, /usermod -aG flipd/, 'installer prints the group-membership next step');
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
  // the same style, distinguishable from HOST's. Deliberately wide: now that
  // the unit is built with awk's ENVIRON rather than a sed replacement
  // string, only whitespace, '&', '|', backslash and '%' are actually
  // hazardous, so '+', '@', '~', ':' and ',' must all still be admitted.
  assert.match(text, /case "\$HERE" in/, 'installer validates $HERE against a safe character set via a case glob');
  assert.match(text, /\[!A-Za-z0-9\/_\.\+@~:,-\]/, 'the $HERE glob rejects whitespace, &, |, backslash and %, while admitting +, @, ~, : and ,');
  // `case` glob character-class ranges (A-Za-z0-9) are locale-collated, and
  // `sudo` preserves LANG/LC_* by default, so under a UTF-8 locale a range
  // like a-z can collate in non-ASCII letters that have no business passing
  // either guard. Both guards above only mean what they read as under C.
  assert.match(text, /^export LC_ALL=C$/m, 'installer forces the C locale so the case-glob character ranges mean what they read as');
  const lines = text.split('\n');
  const lcAllIndex = lines.findIndex((l) => /^export LC_ALL=C$/.test(l));
  const hostCaseIndex = lines.findIndex((l) => /case "\$HOST" in/.test(l));
  const hereCaseIndex = lines.findIndex((l) => /case "\$HERE" in/.test(l));
  assert.ok(lcAllIndex >= 0 && lcAllIndex < hostCaseIndex && lcAllIndex < hereCaseIndex, 'LC_ALL is forced before either locale-sensitive case glob runs');
});

test('install.sh: an existing conf is always reconciled to root:flipd 0640', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const lines = text.split('\n');
  // Must be unconditional -- not indented inside the "file did not exist yet"
  // branch -- or an operator's hand-written conf (root:root 0600, as both the
  // docs and `add`'s own output leave someone to create by hand) never gets
  // fixed by a re-run, and the service (User=flipd) gets EACCES and
  // crash-loops under Restart=on-failure forever.
  const chownLine = lines.findIndex((l) => /^chown root:flipd \/etc\/flipd\/flipd\.conf$/.test(l));
  const chmodLine = lines.findIndex((l) => /^chmod 0640 \/etc\/flipd\/flipd\.conf$/.test(l));
  assert.ok(chownLine >= 0, 'chown runs at top level, not nested inside the create-branch');
  assert.ok(chmodLine >= 0, 'chmod runs at top level, not nested inside the create-branch');
  // And it must run after both the create and the --host-rewrite branches, so
  // it applies regardless of which one ran (or neither).
  const ifBranch = lines.findIndex((l) => /^if \[ ! -f \/etc\/flipd\/flipd\.conf \]; then$/.test(l));
  assert.ok(ifBranch >= 0 && ifBranch < chownLine && ifBranch < chmodLine);
});

test('install.sh: the service is verified to still be running, not just successfully (re)started', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // Type=simple means `restart`/`enable --now` return the instant the process
  // execs; a bad conf, EACCES, or a missing secret all crash within
  // milliseconds under Restart=on-failure, indistinguishable from a healthy
  // start unless something checks again after a settle.
  assert.match(text, /systemctl is-active --quiet flipd/, 'installer checks the service is actually active after (re)starting it');
  // Anchored on the exact startup-liveness message, not a bare
  // "journalctl -u flipd" search: that string also appears in the
  // unrelated Caddy ping diagnostic later in the file, so a regression that
  // deleted the startup hint specifically (while leaving the Caddy one)
  // would otherwise still pass.
  assert.match(text, /did not stay running; check: journalctl -u flipd/, 'a failed startup names the log to check, specifically in the startup-liveness message');
  // Every run restarts, not just the first: `enable --now` is a no-op on an
  // already-enabled, already-running unit, so a re-run after `git pull` must
  // not leave old code running under a clean transcript.
  assert.match(text, /^systemctl restart flipd \|\| fail_started$/m, 'every run restarts the service, not just the first, and a failed restart itself is caught');
  assert.match(text, /^systemctl is-active --quiet flipd \|\| fail_started$/m, 'a restart that "succeeds" but does not stay up is caught by the same path');
});

test('install.sh: systemctl enable and restart failures are surfaced, not swallowed by set -e with no output', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // A masked unit, or a box where systemd is not PID 1, must not exit the
  // script silently: systemctl's own "Created symlink ..." progress line
  // goes to stderr already (systemd's log_info(), not stdout), so there is
  // nothing to mute and no redirect belongs here; a failure must print our
  // own message before exiting, the way the liveness check does.
  assert.doesNotMatch(text, /systemctl enable flipd >\/dev\/null/, 'systemctl enable does not redirect a stream that was never carrying its progress chatter');
  assert.match(text, /systemctl enable flipd \|\| \{ echo/, 'a failed systemctl enable prints its own diagnostic and exits, rather than aborting silently under set -e');
  // `restart` itself can fail outright (e.g. a broken ExecStart path) before
  // ever reaching the is-active settle-check below it; both failure paths
  // must land on the same journalctl hint.
  assert.match(text, /fail_started\(\) \{/, 'a shared helper prints the journalctl hint for both restart-failed and stayed-down cases');
});

test('install.sh: the installed unit points at this clone, wherever it lives, without a truncating write in the failure path', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  assert.match(text, /"ExecStart=" ENVIRON\["HERE"\] "\/bin\/flipd serve"/, 'installer substitutes $HERE into the unit when the clone is not at /opt/flipd');
  assert.match(text, /HERE" = \/opt\/flipd/, 'installer only uses the shipped unit file verbatim when the clone actually is at /opt/flipd');
  // Not sed: $HERE lands in a sed *replacement* string, where '&' and a
  // backslash are metacharacters -- '&' re-inserts the whole matched line
  // (mangling it) and a broken replacement script would abort mid-write.
  // awk's ENVIRON does no such processing (unlike `awk -v`, which does).
  assert.match(text, /ENVIRON\["HERE"\]/, 'the unit substitution reads $HERE via awk ENVIRON, immune to replacement-string metacharacters');
  assert.doesNotMatch(text, /sed ["'][^"']*ExecStart/, 'ExecStart substitution does not go through sed');
  // The substituted unit must never be written via a truncating redirect
  // straight to the live path: a mid-write failure there would leave
  // /etc/systemd/system/flipd.service at zero bytes, with set -e
  // aborting before daemon-reload runs again -- reproduced on every later
  // run. It must be built in a temp file and moved into place with `install`.
  assert.doesNotMatch(text, />\s*\/etc\/systemd\/system\/flipd\.service/, 'the unit is never written by a direct redirect to the live path');
  assert.match(text, /UNIT_TMP/, 'the substituted unit is built in a temp file first');
  assert.match(text, /install -m 0644 "\$UNIT_TMP" \/etc\/systemd\/system\/flipd\.service/, 'the temp file is moved into place with install, not a redirect');
  // A plain `rm -f "$UNIT_TMP"` placed after the install line is never
  // reached if awk or install fails first, leaking the temp file. An EXIT
  // trap runs regardless of how (or whether) the rest of the script exits.
  assert.match(text, /trap 'rm -f "\$UNIT_TMP"' EXIT/, 'the temp unit file is cleaned up via an EXIT trap, not only on the success path');
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
  // `set -e` for reasons unrelated to flipd itself (a bad hand-written
  // conf; a pre-existing Caddyfile with a syntax error failing `reload` and
  // `restart`), and an operator who never sees the hint has no way to tell a
  // permissions problem from a dead service the next time `status` reports one.
  const logrotateIndex = lines.findIndex((l) => /^# 7\. logrotate$/.test(l));
  const usermodIndex = lines.findIndex((l) => /usermod -aG flipd/.test(l));
  const serviceSectionIndex = lines.findIndex((l) => /^# 8\. service$/.test(l));
  const caddySectionIndex = lines.findIndex((l) => /^# 9\. Caddy$/.test(l));
  assert.ok(logrotateIndex >= 0 && serviceSectionIndex >= 0, 'both section markers exist');
  assert.ok(logrotateIndex < serviceSectionIndex, 'logrotate installs before the service-liveness gate, which can abort for reasons unrelated to logrotate');
  assert.ok(usermodIndex >= 0 && usermodIndex < serviceSectionIndex, 'the usermod hint prints before the service-liveness gate, which can abort a bad hand-written conf');
  assert.ok(caddySectionIndex >= 0 && usermodIndex < caddySectionIndex, 'the usermod hint prints before the Caddy section starts too');
  // /etc/logrotate.d does not exist on every box (logrotate is only
  // Priority: important, so a slim container or minbase image can lack it),
  // and `install` without -d/-D does not create a missing destination
  // directory -- it exits 71. Now that this step runs ahead of the service
  // section, that failure would abort the whole install (unit never
  // written, daemon-reload/enable/restart never run) rather than the
  // harmless post-service failure it used to be.
  const logrotateDirIndex = lines.findIndex((l) => /^install -d -m 0755 \/etc\/logrotate\.d$/.test(l));
  const logrotateInstallIndex = lines.findIndex((l) => /^install -m 0644 "\$HERE\/flipd\.logrotate" \/etc\/logrotate\.d\/flipd$/.test(l));
  assert.ok(logrotateDirIndex >= 0 && logrotateInstallIndex >= 0 && logrotateDirIndex < logrotateInstallIndex, 'the logrotate.d directory is created before the config is installed into it');
});

test('install.sh: refuses an empty GitHub host-key response, and makes the entry point executable before starting the service', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const lines = text.split('\n');
  // curl and node can both succeed with a response that carries no ssh_keys;
  // printf writing that would still leave a non-empty known_hosts (even a
  // lone newline satisfies `[ -s ... ]`), silently skipping this block on
  // every future run and wedging every git fetch on host key verification.
  assert.match(text, /\[ -n "\$KEYS" \]/, 'installer refuses to write known_hosts when GitHub returned no ssh_keys');
  // systemd execs bin/flipd directly; it must already be +x before
  // the service starts, not only before the /usr/local/bin symlink is made --
  // latent today because bin/flipd is 100755 in git, but a checkout
  // that lost the mode bit must not abort at the service step before ever
  // reaching a chmod that would have fixed it.
  const chmodXIndex = lines.findIndex((l) => /chmod \+x "\$HERE\/bin\/flipd"/.test(l));
  const serviceSectionIndex = lines.findIndex((l) => /^# 8\. service$/.test(l));
  assert.ok(chmodXIndex >= 0 && serviceSectionIndex >= 0 && chmodXIndex < serviceSectionIndex, 'the entry point is chmod +x before the service section starts it');
});

test('unit file and logrotate say what the spec says', async () => {
  const unit = await fs.readFile('flipd.service', 'utf8');
  assert.match(unit, /^User=flipd$/m);
  assert.match(unit, /^ExecStart=\/opt\/flipd\/bin\/flipd serve$/m);
  assert.match(unit, /^RuntimeDirectory=flipd$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  const lr = await fs.readFile('flipd.logrotate', 'utf8');
  assert.match(lr, /\/var\/log\/flipd\/\*\/events\.log/);
  assert.match(lr, /monthly/);
  assert.match(lr, /rotate 12/);
});

test('install.sh does not print a paste-ready sudoers line; docs/build-and-deploy.md carries it', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // The most security-sensitive suggestion in the tool was also the most
  // repeated: printed on every run, including runs where nothing needed root.
  // A paste-ready NOPASSWD line that appears every time stops being read.
  assert.doesNotMatch(text, /NOPASSWD/, 'install.sh no longer prints a sudoers rule');
  assert.doesNotMatch(text, /sudoers\.d/, 'install.sh no longer names the sudoers.d path');
  const doc = await fs.readFile('docs/build-and-deploy.md', 'utf8');
  assert.match(doc, /NOPASSWD: \/usr\/local\/bin\/<your-adopt-script>/, 'the doc carries the rule, scoped to one script');
  assert.match(doc, /chmod 0440 \/etc\/sudoers\.d\/flipd/, 'and the mode that sudo requires of it');
});

// Returns the text of the brace-delimited block that `opener` starts, from the
// opening `{` to its matching `}`. Used to assert nesting rather than mere
// ordering: two directives can appear in the right order and still be siblings.
function spanOf(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start + opener.length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

test('spanOf finds a nested block and distinguishes it from a sibling', () => {
  const nested = 'site {\n  log {\n    output stderr\n    format filter {\n      f delete\n    }\n  }\n  handle {\n  }\n}';
  const sibling = 'site {\n  log {\n    output stderr\n  }\n  format filter {\n    f delete\n  }\n  handle {\n  }\n}';
  // The ordering check the real assertion replaces passes on BOTH of these --
  // that is the bug in it. The nesting check must separate them.
  for (const t of [nested, sibling]) {
    const d = t.indexOf('f delete');
    assert.ok(d > t.indexOf('log {') && d < t.indexOf('handle {'), 'ordering alone cannot tell these apart');
  }
  assert.ok(spanOf(nested, 'log {').includes('f delete'), 'nested: the filter is inside the log block');
  assert.ok(!spanOf(sibling, 'log {').includes('f delete'), 'sibling: the filter is not inside the log block');
  assert.equal(spanOf('a { b }', 'zz {'), '', 'a missing opener yields empty, not a throw');
  assert.equal(spanOf('log { unclosed', 'log {'), '', 'an unbalanced block yields empty, not a hang');
});

test('install.sh: the Caddy site block logs every request to journald, not to a file', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const start = text.indexOf('CADDY_BLOCK=');
  assert.ok(start >= 0, 'the Caddy block heredoc exists');
  const block = text.slice(start, text.indexOf('\n}"', start) + 3);
  // A single endpoint with a handful of requests a day has no volume argument
  // against logging all of them, and the site block is the only layer that
  // sees a request flipd never receives -- a TLS failure, a 404 on the wrong
  // path, a proxy misconfiguration. On the first real install, proving that
  // GitHub's ping had arrived took adding this by hand.
  assert.match(block, /^\s+log \{/m, 'a log directive');
  assert.match(block, /^\s+output stderr$/m, 'writing to stderr, which the unit sends to journald');
  // The signature header is an HMAC under WEBHOOK_SECRET and so inside the
  // never-print rule; Caddy's default redaction set does not include it.
  assert.match(block, /^\s+request>headers>X-Hub-Signature-256 delete$/m, 'the signature header is filtered out of the logged request');
  // Nesting, not ordering. The obvious check -- delete-line sits between
  // `log {` and `handle /deploy` -- also passes when the filter has been moved
  // out of the log block to sit beside it, which is precisely the regression
  // worth catching. Scan brace depth from `log {` to find where that block
  // actually ends, and require the delete line inside it.
  assert.ok(spanOf(block, 'log {').includes('X-Hub-Signature-256 delete'), 'the filter is nested inside the log block, not merely before the handlers');
  // `output file /var/log/caddy/...` is refused by the Debian unit's sandbox
  // with "permission denied" even when caddy owns the directory; observed.
  assert.doesNotMatch(block, /output file/, 'never a file: the sandbox refuses it');
  // The directive must be inside the site block, not at the top level of the
  // Caddyfile, or it would apply to (and be ambiguous with) other sites.
  const logIndex = block.indexOf('log {');
  const handleIndex = block.indexOf('handle /deploy');
  assert.ok(logIndex > 0 && logIndex < handleIndex, 'log is declared inside the site, before the handlers');
});

// The packaged Caddyfile, verbatim from the caddy .deb (dpkg conffile
// 8cbf072a3e390217a88c242a7f18ee76), trimmed of the comment preamble that
// carries no directives. This is the thing the installer has to neutralise.
const STOCK_CADDYFILE = `# The Caddyfile is an easy way to configure your Caddy web server.

:80 {
\t# Set this path to your site's directory.
\troot * /usr/share/caddy

\t# Enable the static file server.
\tfile_server

\t# Another common task is to set up a reverse proxy:
\t# reverse_proxy localhost:8080
}

# Refer to the Caddy docs for more information:
# https://caddyserver.com/docs/caddyfile
`;

// Pulls the awk program out of install.sh and runs it over `input`, the same
// way read_secret's body is extracted and exercised above: the installer stays
// unexecuted, only the few lines of awk it contains are.
async function runDefaultSiteAwk(input) {
  const text = await fs.readFile('install.sh', 'utf8');
  // Anchor on the end -- install.sh has more than one awk program (the unit's
  // ExecStart rewrite is the other), and the one that matters here is the one
  // applied to the Caddyfile. Find that, then take the `awk '` nearest before.
  const close = text.indexOf("\n  ' /etc/caddy/Caddyfile");
  assert.ok(close >= 0, 'an awk program is applied to /etc/caddy/Caddyfile');
  const open = text.lastIndexOf("awk '", close);
  assert.ok(open >= 0, 'that awk program has an opening quote');
  const program = text.slice(open + "awk '".length, close + 1);
  const dir = await tmpdir();
  const file = path.join(dir, 'Caddyfile');
  await fs.writeFile(file, input);
  const { stdout } = await run('awk', [program, file]);
  return stdout;
}

test('install.sh: the packaged ":80" default site is commented out, and only when it is still the packaged one', async () => {
  // The apt package serves /usr/share/caddy/index.html -- the "Caddy works!"
  // page -- from a host-less `:80` block. flipd's own site matches by Host, so
  // the two coexist happily and every flipd box answers a bare-IP request with
  // that page. Caddy refuses a second `:80` ("ambiguous site definition:
  // :80"), so conf.d cannot shadow it; the stock block itself has to go.
  const out = await runDefaultSiteAwk(STOCK_CADDYFILE);
  assert.doesNotMatch(out, /^[\t ]*:80[\t ]*\{/m, 'no uncommented :80 block survives');
  assert.doesNotMatch(out, /^[\t ]*root \* \/usr\/share\/caddy/m, 'the packaged root is no longer live');
  assert.doesNotMatch(out, /^[\t ]*file_server/m, 'the file server inside the block went with it');
  // Commented, not deleted: an operator reading the file must be able to see
  // what was there and why the page stopped answering.
  assert.match(out, /^#[\t ]*:80[\t ]*\{/m, 'the block is commented out rather than removed');
  // Everything outside the block is untouched, including any import line the
  // installer appends -- clobbering that would unwire flipd's own site.
  assert.match(out, /^# Refer to the Caddy docs for more information:$/m, 'trailing comments survive');
  assert.match(out, /^# The Caddyfile is an easy way/m, 'the preamble survives');

  // Idempotent, which install.sh's own first line promises of every step: the
  // commented output must be a fixed point, or a re-run stacks a second `#` on
  // each line and the block drifts further from what it was.
  const twice = await runDefaultSiteAwk(out);
  assert.equal(twice, out, 're-running over its own output changes nothing');
});

test('install.sh: a :80 site the operator actually wrote is left alone', async () => {
  // The whole safety of this step is that it recognises the packaged block by
  // the packaged root and nothing else. A real site on :80 -- someone serving
  // their own files, or proxying -- must survive an install untouched.
  const theirs = ':80 {\n\troot * /srv/www\n\tfile_server\n}\n';
  assert.equal(await runDefaultSiteAwk(theirs), theirs, 'a :80 block with a different root is not the packaged one');

  const proxy = ':80 {\n\treverse_proxy 127.0.0.1:3000\n}\n';
  assert.equal(await runDefaultSiteAwk(proxy), proxy, 'a :80 block with no root at all is not the packaged one');

  // A Caddyfile that never had a :80 block -- someone who already replaced it
  // with their own hostname site -- passes through byte for byte.
  const named = 'example.com {\n\troot * /usr/share/caddy\n\tfile_server\n}\n';
  assert.equal(await runDefaultSiteAwk(named), named, 'the packaged root under a named site is not the host-less default');
});

test('install.sh: --host normalises WEBHOOK_SECRET by the effective value, delete-all then write-one; the no-host tail names PUBLIC_HOST and the SSH doc', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  const start = text.indexOf('elif [ -n "$HOST" ]; then');
  const end = text.indexOf('# Unconditional, on every run');
  assert.ok(start > 0 && end > start, 'the --host branch is where it was');
  const branch = text.slice(start, end);
  assert.ok(branch.includes('EFFECTIVE=$(read_secret /etc/flipd/flipd.conf)'), 'the check reads the secret the way the daemon does, through the one shared reader');
  assert.match(branch, /if \[ -z "\$EFFECTIVE" \]; then/, 'only a missing or empty effective value triggers a write; a non-empty secret is never rewritten');
  const DELETE = `sed -i '/^[[:space:]]*WEBHOOK_SECRET[[:space:]]*=/d' /etc/flipd/flipd.conf`;
  const WRITE = `printf 'WEBHOOK_SECRET=%s\\n' "$SECRET" >> /etc/flipd/flipd.conf`;
  assert.ok(branch.includes(DELETE), 'every assignment line is deleted');
  assert.ok(branch.includes(WRITE), 'then exactly one is written');
  assert.ok(branch.indexOf(DELETE) < branch.indexOf(WRITE), 'delete-all precedes write-one: one key, one assignment, so the line an operator reads by eye is the line the daemon uses');
  assert.ok(!/WEBHOOK_SECRET=[^\n]*\bsay\b|say[^\n]*\$SECRET/.test(branch), 'the new secret is never echoed');
  assert.match(text, /set PUBLIC_HOST=<[^>]+> in \/etc\/flipd\/flipd\.conf[^\n]*no webhook listener/, 'the no-host tail says a hand-rolled front also needs PUBLIC_HOST');
  assert.match(text, /docs\/triggering-over-ssh\.md/, 'the no-host tail points at the SSH doc');
});

test('read_secret in install.sh follows the parser: last assignment wins, whitespace tolerated, empty is empty', async () => {
  // Runs the extracted function body against a temp file -- not the installer.
  const text = await fs.readFile('install.sh', 'utf8');
  const body = /^read_secret\(\) \{\n([\s\S]*?)\n\}$/m.exec(text)?.[1];
  assert.ok(body, 'read_secret is where the readers get the value');
  // Both readers go through it, and no strict one survives: '^WEBHOOK_SECRET='
  // finds nothing in a legal ' WEBHOOK_SECRET = abc ', so the ping would sign
  // under an empty secret and the recipe would create a webhook with none.
  assert.match(text, /EFFECTIVE=\$\(read_secret \/etc\/flipd\/flipd\.conf\)/, 'the --host backfill check reads through it');
  assert.match(text, /SECRET=\$\(read_secret \/etc\/flipd\/flipd\.conf\)/, 'the signed ping reads through it');
  assert.doesNotMatch(text, /sed -n 's\/\^WEBHOOK_SECRET=/, 'no strict reader is left in the installer');
  const f = path.join(await tmpdir('flipd-install'), 'flipd.conf');
  const effective = async (content) => {
    await fs.writeFile(f, content);
    const { stdout } = await run('sh', ['-c', body, 'sh', f], { env: { ...process.env, LC_ALL: 'C' } });
    // Strip the trailing newline only. A .trim() here would pass against a
    // reader that leaves whitespace on the value -- which is the bug.
    return stdout.replace(/\n$/, '');
  };
  assert.equal(await effective('WEBHOOK_SECRET=old\n WEBHOOK_SECRET = \n'), '', 'a later empty assignment makes the value empty, as parseKV reads it');
  assert.equal(await effective('WEBHOOK_SECRET=first\nWEBHOOK_SECRET=second\n'), 'second', 'the last assignment wins, as parseKV reads it');
  assert.equal(await effective('LISTEN=x\nWEBHOOK_SECRET=abc\n'), 'abc');
  assert.equal(await effective('  WEBHOOK_SECRET  =  abc  \n'), 'abc', 'whitespace around the key, the = and the value is the parser\'s rule');
  assert.equal(await effective('WEBHOOK_SECRET=\n'), '');
  assert.equal(await effective('LISTEN=x\n'), '', 'absent is empty');
  assert.equal(await effective('#WEBHOOK_SECRET=commented\n'), '', 'a comment is not an assignment');
});
