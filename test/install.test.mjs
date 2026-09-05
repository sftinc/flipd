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
  const firstAction = text.split('\n').findIndex((l) => /^\s*(useradd|install |mkdir|cat >|ln |systemctl|apt-get|curl)/.test(l));
  const rootCheck = text.split('\n').findIndex((l) => /id -u.*-eq 0/.test(l));
  assert.ok(rootCheck >= 0 && rootCheck < firstAction, 'root check precedes any action');
  assert.match(text, /\( *umask 027/, 'umask is scoped to a subshell');
  assert.match(text, /x-github-event: ping/i, 'the path proof is a signed ping');
  // The signed-ping proof must never pass the webhook secret as a command-line
  // argument: that publishes it in /proc/<pid>/cmdline for any local user to
  // read with ps. It must go through the environment instead.
  assert.doesNotMatch(text, /createHmac\([^)]*\)\.update\(s\)\.digest\(hex\)[^\n]*"\$SECRET"/, 'no HMAC line passes $SECRET as an argv token');
  const secretLineIndex = text.split('\n').findIndex((l) => /process\.argv\[1\]/.test(l) && /SECRET|secret/.test(l));
  assert.equal(secretLineIndex, -1, 'the HMAC script never reads the secret from argv');
  assert.match(text, /SECRET="\$SECRET"/, 'the secret reaches node through the environment');
  assert.match(text, /process\.env\.SECRET/, 'the HMAC script reads the secret from the environment');
  // The unit's socket directory is root:remote-deploy only (by design, not a
  // bug) -- an ordinary admin account needs group membership to use status,
  // check, run and rollback. The installer must say so as a named step.
  assert.match(text, /usermod -aG remote-deploy/, 'installer prints the group-membership next step');
  // --host is interpolated into a Caddyfile block and a URL with no quoting
  // at all; it must be checked against a hostname shape before use.
  assert.match(text, /grep -qE|case "\$HOST"/, 'installer validates --host against a hostname shape');
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
