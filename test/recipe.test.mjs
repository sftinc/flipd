// test/recipe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webhookRecipe, sshRecipe, FLIPD_BIN } from '../lib/cli/recipe.mjs';
import { tmpdir } from './helpers.mjs';

const run = promisify(execFile);

test('webhookRecipe: names the URL, the conf, the event, and the gh pipeline; never a secret value', () => {
  const r = webhookRecipe({ host: 'deploy.example.com', ghRepo: 'o/r', mainConf: '/etc/flipd/flipd.conf' });
  assert.match(r, /Payload URL\s+https:\/\/deploy\.example\.com\/deploy/);
  assert.match(r, /Content type\s+application\/json/);
  assert.match(r, /Secret\s+the WEBHOOK_SECRET in \/etc\/flipd\/flipd\.conf/);
  assert.match(r, /Events\s+just the push event/);
  assert.match(r, /gh api repos\/o\/r\/hooks/);
  assert.ok(!r.endsWith('\n'), 'no trailing newline: the caller frames it');
  assert.ok(!/^\s*\d\./m.test(r), 'no step number: the caller numbers it');
});

test('webhookRecipe: the secret reaches gh only over stdin, never on any argv', () => {
  const r = webhookRecipe({ host: 'h', ghRepo: 'o/r', mainConf: '/c' });
  // These are the argv-safety properties that used to be asserted on add's
  // output. They belong to the recipe text itself, so they are tested here
  // once and hold for every command that prints it.
  assert.match(r, /--input -/, 'the webhook is created from a JSON body on stdin, not -f flags');
  assert.match(r, /--method POST/, 'the recipe posts explicitly, so --input - can never be read as a silent GET');
  assert.doesNotMatch(r, /-f\s+"?config\[secret\]/, 'no gh flag carries config[secret] on argv');
  assert.match(r, /process\.env\.SECRET/, 'the secret reaches node through the environment, not argv');
  const ghApiLines = r.split('\n').filter((l) => /\bgh api\b/.test(l));
  assert.ok(ghApiLines.length > 0, 'the recipe does call gh api');
  for (const l of ghApiLines) {
    assert.ok(!/\$\(/.test(l), `the gh api invocation itself takes no command substitution as an argument: ${l}`);
    assert.ok(!/config\[secret\]/.test(l), `the gh api invocation line never names config[secret]: ${l}`);
  }
});

test('webhookRecipe: the sed that reads the secret reads what the daemon reads', async () => {
  // The recipe's own pipeline, run against temp confs this test writes. It has
  // to agree with parseKV: an operator who hand-wrote ' WEBHOOK_SECRET = abc '
  // -- legal, and what the docs invite -- would otherwise create a webhook with
  // an empty secret, which gh accepts with a 201 and every push then fails.
  const f = path.join(await tmpdir('flipd-recipe'), 'flipd.conf');
  const r = webhookRecipe({ host: 'h', ghRepo: 'o/r', mainConf: f });
  const cmd = /SECRET=\$\(([\s\S]*?)\) node -e/.exec(r)?.[1];
  assert.ok(cmd, 'the recipe reads the secret in a command substitution');
  assert.ok(cmd.startsWith('sudo '), 'the conf is root-readable only');
  const secret = async (content) => {
    await fs.writeFile(f, content);
    // sudo dropped: the temp file is already ours. Trailing newline stripped,
    // nothing else -- a .trim() would pass against a pipeline that leaves
    // whitespace on the value, which is exactly the bug under test.
    const { stdout } = await run('sh', ['-c', cmd.replace('sudo ', '')], { env: { ...process.env, LC_ALL: 'C' } });
    return stdout.replace(/\n$/, '');
  };
  assert.equal(await secret('  WEBHOOK_SECRET  =  abc  \n'), 'abc', 'whitespace around the key, the = and the value is separator, not value');
  assert.equal(await secret('WEBHOOK_SECRET=first\nWEBHOOK_SECRET=second\n'), 'second', 'the last assignment wins');
  assert.equal(await secret('LISTEN=x\n'), '', 'absent is empty');
});

test('webhookRecipe: placeholders pass through verbatim when nothing is known yet', () => {
  const r = webhookRecipe({ host: '<PUBLIC_HOST>', ghRepo: '<owner>/<repo>', mainConf: '/c' });
  assert.match(r, /https:\/\/<PUBLIC_HOST>\/deploy/);
  assert.match(r, /repos\/<owner>\/<repo>\/hooks/);
});

test('sshRecipe: the forced command with restrict, the repo name, the group, the doc; instructions only', () => {
  const r = sshRecipe({ name: 'app', ghRepo: 'o/r', bin: '/opt/flipd/bin/flipd' });
  assert.match(r, /command="\/opt\/flipd\/bin\/flipd trigger app --wait",restrict /, 'one key, one thing');
  assert.match(r, /ssh-keygen -t ed25519 -f flipd-app -N ''/);
  assert.match(r, /gh secret set FLIPD_SSH_KEY -R o\/r < flipd-app$/m, 'the private half goes to GitHub straight from the file');
  assert.match(r, /usermod -aG flipd/);
  assert.match(r, /docs\/triggering-over-ssh\.md/);
  assert.doesNotMatch(r, /ssh-keygen[^\n]*\/etc\/flipd/, 'flipd generates nothing: the keypair is made off-box');
  assert.ok(!r.endsWith('\n'), 'no trailing newline: the caller frames it');
  assert.ok(!/^\s*\d\./m.test(r), 'no step number: the caller numbers it');
});

test('sshRecipe: the bin path defaults to this clone\'s bin/flipd, and ghRepo to a placeholder', () => {
  const r = sshRecipe({ name: 'a' });
  assert.ok(r.includes(`command="${FLIPD_BIN} trigger a --wait"`), r);
  assert.ok(FLIPD_BIN.endsWith('/bin/flipd'));
  assert.match(r, /-R <owner>\/<repo> </);
});
