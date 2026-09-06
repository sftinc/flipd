// test/recipe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookRecipe } from '../lib/cli/recipe.mjs';

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

test('webhookRecipe: placeholders pass through verbatim when nothing is known yet', () => {
  const r = webhookRecipe({ host: '<PUBLIC_HOST>', ghRepo: '<owner>/<repo>', mainConf: '/c' });
  assert.match(r, /https:\/\/<PUBLIC_HOST>\/deploy/);
  assert.match(r, /repos\/<owner>\/<repo>\/hooks/);
});
