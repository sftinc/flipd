# Real-Install Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five open items surfaced by the first real install of flipd, so that a webhook's arrival is visible on the server, the webhook recipe can be re-printed after `--host`, Caddy logs requests, and the two documentation gaps are filled.

**Architecture:** Four of the five are small, independent edits to existing files — a handful of `journal` calls in the webhook handler, a `log` block in the Caddy heredoc, and two README sections. The fifth extracts the webhook recipe text from `lib/cli/add.mjs` into a shared module so `flipd check` can print it too. Nothing new is added to the service's runtime surface; every change is either a log line, a printed line, or a documentation line.

**Tech Stack:** Node 20+, ESM, `node:test`, zero npm dependencies. POSIX `sh` for `install.sh`, tested statically only.

**Spec:** `docs/superpowers/specs/2026-09-06-real-install-findings.md` — the five items under **Open**. Each task below cites its item. The spec also has a **Not a defect** section listing things that were investigated and deliberately left alone; do not "fix" any of those while working nearby.

## Global Constraints

- Node `>= 20`; ESM (`.mjs`); `node:test`; **zero npm dependencies** — do not add any.
- **The never-print rule:** flipd never prints `WEBHOOK_SECRET`, a private key, or an env-file value. Log the key names only. This applies to journald exactly as it applies to the attempt log.
- **Never execute `install.sh`.** It is a root-only installer. `test/install.test.mjs` inspects it statically (`sh -n` and text assertions); every test you add for it must do the same.
- The webhook recipe must keep the secret out of argv: it reaches `node` through the environment and reaches `gh api` through `--input -` on stdin. `test/cli-add-check-env-remove.test.mjs` enforces this on `add`'s output; the same properties must hold wherever the recipe is printed.
- Every commit message ends with the trailer `Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf`.
- Run the full suite (`npm test`) before every commit; it must stay at 0 failures. It was 160/160 when this plan was written.
- Match the surrounding style: the codebase writes comments that explain *why*, one file per module, and tests that state the property they protect. Do not restructure files you are not asked to.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `lib/hook.mjs` | Webhook HTTP handler. Gains `cleanForLog()` and six journal lines. | 1 |
| `test/hook.test.mjs` | Handler tests. Gains journal-line assertions and a `cleanForLog` unit test. | 1 |
| `lib/cli/recipe.mjs` | **New.** One exported function that renders the webhook recipe text. The single source of that text. | 4 |
| `lib/cli/add.mjs` | Calls `webhookRecipe()` instead of carrying the text inline. | 4 |
| `lib/cli/check.mjs` | Prints the recipe after the check rows, with the current `PUBLIC_HOST`. | 4 |
| `test/cli-add-check-env-remove.test.mjs` | Gains a `check` recipe test. | 4 |
| `test/recipe.test.mjs` | **New.** Tests `webhookRecipe()` directly, including the argv-safety properties. | 4 |
| `install.sh` | Loses the sudoers block (Task 3); Caddy heredoc gains a `log` block (Task 5). | 3, 5 |
| `test/install.test.mjs` | Gains assertions for both `install.sh` changes. | 3, 5 |
| `README.md` | Prerequisites paragraph (2); sudoers moved into Permissions (3); Caddy logging + `conf.d` note (5). | 2, 3, 5 |

Tasks 1, 2, 3, and 5 are independent of each other. Task 4 is independent too but is the largest; it is placed last so that the small ones land first.

---

### Task 1: Log every post-verification arm of the webhook handler

**Spec item:** Open · 1.

**Files:**
- Modify: `lib/hook.mjs:77-99`
- Test: `test/hook.test.mjs`

**Interfaces:**
- Consumes: the existing `journal(line)` callback passed to `createHookServer`, and `from` (the remote address), both already in scope in `handle()`.
- Produces: `export function cleanForLog(value, max = 80)` from `lib/hook.mjs`. Returns a string with every byte outside printable ASCII (`0x20`–`0x7e`) replaced by `?`, truncated to `max`. `undefined`/`null` become `''`. Task 4 does not use it; nothing else depends on it, but it is exported so it can be unit-tested.

**Background for the implementer.** Read `lib/hook.mjs` in full first (104 lines). The function `handle()` verifies the HMAC at line 72, and *after* that point six `return reply(...)` statements write nothing to the journal, while every rejection before that point and the "no matching repo" arm after it do. The spec has the table. Two facts govern the change:

1. Everything you log here runs after `verifySignature`, so it is authenticated — but "authenticated" is not "safe to put in journald." A header or payload field can carry a newline, which forges a log line. So every value that came off the wire goes through `cleanForLog` first. The body itself is never logged, by anyone, ever.
2. The `x-hub-signature-256` header is derived from the secret. It must not appear in any log line.

- [ ] **Step 1: Write the failing unit test for `cleanForLog`**

Add to the top of `test/hook.test.mjs`, after the existing imports (change the import line to include `cleanForLog`):

```js
import { verifySignature, createHookServer, cleanForLog } from '../lib/hook.mjs';

test('cleanForLog: replaces control and non-ASCII bytes, truncates, tolerates missing values', () => {
  // A newline in a logged field forges a second log line; a tab or ESC can
  // hide text in a terminal. Every such byte becomes a visible '?'.
  assert.equal(cleanForLog('push\nfake: line'), 'push?fake: line');
  assert.equal(cleanForLog('a\tb\x1bc'), 'a?b?c');
  assert.equal(cleanForLog('café'), 'caf??', 'multi-byte UTF-8 is replaced byte-for-byte, not passed through');
  assert.equal(cleanForLog('x'.repeat(200)), 'x'.repeat(80), 'default cap is 80');
  assert.equal(cleanForLog('x'.repeat(200), 40), 'x'.repeat(40), 'cap is a parameter');
  assert.equal(cleanForLog(undefined), '');
  assert.equal(cleanForLog(null), '');
  assert.equal(cleanForLog(42), '42', 'non-strings are stringified, not thrown on');
});
```

Note on the `café` case: `'café'` is one JavaScript string of length 4, but its UTF-8 encoding is 5 bytes and the é is two of them. The implementation below works on the UTF-8 bytes so that the output is a faithful account of what was on the wire — `caf??`, two replacements. If you implement on the string instead of the bytes you get `caf?` and this assertion fails; that is the test doing its job.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/hook.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../lib/hook.mjs' does not provide an export named 'cleanForLog'`.

- [ ] **Step 3: Implement `cleanForLog`**

Add to `lib/hook.mjs` after the `MAX_BODY` constant (line 5):

```js
// Anything that came off the wire and is about to be journaled goes through
// here first. Verification proves the sender holds the secret; it does not
// make a header or a payload field safe to write to a log. A newline forges a
// second journal line, an ESC can hide text in a terminal, and an unbounded
// value can flood the journal. Works on the UTF-8 bytes so that what is logged
// is an honest account of what arrived, one '?' per replaced byte.
export function cleanForLog(value, max = 80) {
  if (value === undefined || value === null) return '';
  const bytes = Buffer.from(String(value), 'utf8');
  let out = '';
  for (const b of bytes) {
    if (out.length >= max) break;
    out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '?';
  }
  return out;
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --test test/hook.test.mjs`
Expected: the new test PASSES; every existing test in the file still passes.

- [ ] **Step 5: Write the failing journal-line assertions for the six arms**

In `test/hook.test.mjs`, inside the existing test `'routes: 404 elsewhere, 401 unsigned, ping, push match, push no match, bad json'`, add assertions immediately after each of the calls named below. The `lines` array in that test already collects every journal line. Use the exact code shown; the regexes are the contract.

After the `ping` post (the line `assert.deepEqual(await h.post(ping, ...), { status: 200, text: 'pong' });`):

```js
    assert.ok(lines.some((l) => /^webhook ping from 127\.0\.0\.1: ok$/.test(l)), 'an accepted ping is journaled with its source');
```

After the `gone` (branch deletion) post and its `pushes.length` assertion:

```js
    assert.ok(lines.some((l) => /^ignored push from 127\.0\.0\.1: git@github\.com:o\/r\.git main was deleted$/.test(l)), 'a branch deletion is journaled as ignored, with repo and branch');
```

After the `bad` (not json) post:

```js
    assert.ok(lines.some((l) => /^webhook rejected from 127\.0\.0\.1: body is not json$/.test(l)), 'a 400 for unparseable json is journaled');
    assert.ok(!lines.some((l) => l.includes('not json') && l.includes(bad)), 'the body is never quoted in the journal');
```

After the `missing` post:

```js
    assert.ok(lines.some((l) => /^webhook rejected from 127\.0\.0\.1: missing repository\.ssh_url or ref$/.test(l)), 'a 400 for a malformed payload is journaled');
```

After the `ev` (issues event) post:

```js
    assert.ok(lines.some((l) => /^ignored issues event from 127\.0\.0\.1$/.test(l)), 'a non-push event is journaled with its event name');
```

Then add two new posts at the end of the `try` block, before `finally`, for the arms the existing test does not exercise:

```js
    // A tag push: signed, well-formed, and not a branch. Silent before this change.
    const tag = JSON.stringify({ ref: 'refs/tags/v1', repository: { ssh_url: 'git@github.com:o/r.git' } });
    assert.deepEqual(await h.post(tag, { 'x-hub-signature-256': h.sign('s', tag), 'x-github-event': 'push' }), { status: 200, text: 'ignored' });
    assert.ok(lines.some((l) => /^ignored push from 127\.0\.0\.1: git@github\.com:o\/r\.git refs\/tags\/v1 is not a branch$/.test(l)), 'a tag push is journaled as ignored, with the ref');

    // An event name is a free-form header. It is bounded before it reaches the journal.
    const long = '{}';
    await h.post(long, { 'x-hub-signature-256': h.sign('s', long), 'x-github-event': 'e'.repeat(300) });
    const longLine = lines.find((l) => l.startsWith('ignored eeee'));
    assert.ok(longLine, 'the long event name was journaled');
    assert.ok(longLine.length < 120, `the event name is bounded, got ${longLine.length} chars`);
    assert.ok(!lines.some((l) => l.includes('sha256=')), 'the signature header never appears in any journal line');
```

- [ ] **Step 6: Run to verify the new assertions fail**

Run: `node --test test/hook.test.mjs`
Expected: FAIL at the first new `assert.ok` — `an accepted ping is journaled with its source`. (The tag and long-event posts are not reached yet; that is fine.)

- [ ] **Step 7: Add the six journal lines**

Replace `lib/hook.mjs` lines 77–99 (from `const event = ...` through the closing `}` of the `if (!repo)` block) with:

```js
  // Every arm from here down runs after the signature has verified, and every
  // one journals. The rejections above already do; before this, six arms
  // returned silently, two of them 400s -- so a sender holding the correct
  // secret could be failing on every delivery and the server would not say
  // so, and an operator wiring up a webhook could not tell an accepted ping
  // from one that never arrived. Fields only, cleaned, never the body.
  const event = cleanForLog(req.headers['x-github-event'], 40) || '(none)';
  if (event === 'ping') { journal(`webhook ping from ${from}: ok`); return reply(200, 'pong'); }
  if (event !== 'push') { journal(`ignored ${event} event from ${from}`); return reply(200, 'ignored'); }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    journal(`webhook rejected from ${from}: body is not json`);
    return reply(400, 'not json');
  }
  const sshUrl = payload?.repository?.ssh_url;
  const ref = payload?.ref;
  if (typeof sshUrl !== 'string' || typeof ref !== 'string') {
    journal(`webhook rejected from ${from}: missing repository.ssh_url or ref`);
    return reply(400, 'missing repository.ssh_url or ref');
  }
  const url = cleanForLog(sshUrl);
  if (!ref.startsWith('refs/heads/')) {
    journal(`ignored push from ${from}: ${url} ${cleanForLog(ref)} is not a branch`);
    return reply(200, 'ignored');
  }
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted === true) {   // a branch deletion is not a request
    journal(`ignored push from ${from}: ${url} ${cleanForLog(branch)} was deleted`);
    return reply(200, 'ignored');
  }
  const id = Number.isInteger(payload?.repository?.id) ? payload.repository.id : null;

  const repo = await findRepo({ sshUrl, branch, id });
  if (!repo) {
    journal(`ignored push from ${from}: ${url} ${cleanForLog(branch)} matches no repo config`);
    return reply(200, 'ignored');
  }
```

Two things to notice. First, `event` is cleaned *before* the comparisons, which is deliberate: a header of `ping\n` is not a ping, and cleaning first means it falls to the `ignored` arm and is logged as `ignored ping? event`, which is the truthful account. Second, the pre-existing "matches no repo config" line at the old line 97 logged `sshUrl` and `branch` raw; it now goes through the same cleaner. It is the same class of value and the same hole, and leaving one raw beside five cleaned would be a trap for the next reader.

- [ ] **Step 8: Run the hook tests to verify they pass**

Run: `node --test test/hook.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: `# pass` equals `# tests`, `# fail 0`. If `test/serve.test.mjs` fails on a journal-line count, read the failing assertion: it will be counting lines around a ping or ignored event that is now logged, and the count should be raised by exactly the number of newly-logged deliveries in that test. Do not weaken it to `>=`.

- [ ] **Step 10: Commit**

```bash
git add lib/hook.mjs test/hook.test.mjs
git commit -F - <<'MSG'
Journal every post-verification arm of the webhook handler

Six arms returned after the signature had verified without writing a line:
ping, non-push events, unparseable json, a payload missing ssh_url or ref, a
tag push, and a branch deletion. Two of those are 400s from a sender holding
the correct secret, and the first is the one an operator meets when wiring up
a webhook for the first time. On the first real install the ping had arrived
and verified, and nothing on the server could say so.

Each arm now journals its source and the fields that name what happened, and
every value that came off the wire goes through cleanForLog first: printable
ASCII only, bounded, working on the UTF-8 bytes. The event header is cleaned
before it is compared, so a header that is almost "ping" is logged as what it
is rather than treated as what it resembles. The body is never logged, and
neither is the signature header, which is derived from the secret.

Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf
MSG
```

---

### Task 2: State the prerequisites `install.sh` enforces

**Spec item:** Open · 2.

**Files:**
- Modify: `README.md:12-24` (the "Install (once per server)" section)

**Interfaces:** none. Documentation only.

**Background.** `install.sh` lines 66–70 check for `git`, `node` (major ≥ 20), and `ssh-keygen`, and exit with a message if one is missing; `curl` is used unguarded at line 117. None of that is in the README. On the first real install, `apt-get install nodejs` on Ubuntu did not bring `npm`, and the first thing the operator met was `BUILD` exiting 127. This task writes the prerequisites down. It does not change `install.sh`; the spec's Not-a-defect section records that flipd behaved correctly.

- [ ] **Step 1: Confirm what the installer actually checks**

Run: `grep -n "command -v\|NODE_MAJOR" install.sh`
Expected: lines checking `git`, `node`, `ssh-keygen`, and the `NODE_MAJOR -ge 20` test. If the list differs from git / node ≥ 20 / ssh-keygen, write what you find, not what this plan says.

- [ ] **Step 2: Add the prerequisites paragraph**

In `README.md`, directly under the `## Install (once per server)` heading and *before* the `git clone` code block, insert:

```markdown
The box needs `git`, `node` 20 or newer, `ssh-keygen` and `curl` before the
installer will run; it checks for them and stops if one is missing, but it does
not install them. On Debian and Ubuntu, `apt install nodejs` does **not** include
`npm` — that is a separate package, needed only if your `BUILD` command uses it
(`apt install npm`). A `BUILD=npm test` on a box with `node` but no `npm` fails
with exit 127 and `npm: not found` in the attempt log; the fix is upstream of
flipd.

```

- [ ] **Step 3: Verify the README says it**

Run: `grep -n "does \*\*not\*\* include" README.md && grep -n "exit 127" README.md`
Expected: both lines found, inside the Install section (line numbers between the `## Install` and `## Add a repo` headings).

- [ ] **Step 4: Run the suite (README is not under test; this is the pre-commit habit)**

Run: `npm test`
Expected: unchanged pass count, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -F - <<'MSG'
Say what install.sh requires before it will run

The installer checks for git, node 20+, ssh-keygen and curl and stops if one is
missing, which is right -- provisioning a runtime is not its job -- but the
README did not say so. On the first real install, Ubuntu's nodejs package did
not bring npm, and the operator's first sight of flipd was a BUILD exiting 127
for a reason upstream of it entirely. Name the prerequisites, and name the
Debian/Ubuntu split between nodejs and npm specifically, since that is the one
that bit.

Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf
MSG
```

---

### Task 3: Move the sudoers hint out of the installer's output

**Spec item:** Open · 3.

**Decision taken by this plan.** The spec offered two options: print the hint only when a repo config's `DEPLOY` references `sudo`, or move it to the README. This plan moves it. Reason: at install time there are normally no repo configs yet, so the conditional would print nothing on a first install — the same effect as moving it, with a conditional to maintain. The README already has a Permissions section that is the natural home, and the installer's output can point at it by name. YAGNI.

**Files:**
- Modify: `install.sh:312-317` (the unconditional `cat <<EOF` block starting with a blank line and `sudoers, for a DEPLOY command that needs root`)
- Modify: `README.md` (the `## Permissions` section)
- Test: `test/install.test.mjs`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Add to `test/install.test.mjs`, at the end of the file:

```js
test('install.sh does not print a paste-ready sudoers line; the README carries it', async () => {
  const text = await fs.readFile('install.sh', 'utf8');
  // The most security-sensitive suggestion in the tool was also the most
  // repeated: printed on every run, including runs where nothing needed root.
  // A paste-ready NOPASSWD line that appears every time stops being read.
  assert.doesNotMatch(text, /NOPASSWD/, 'install.sh no longer prints a sudoers rule');
  assert.doesNotMatch(text, /sudoers\.d/, 'install.sh no longer names the sudoers.d path');
  const readme = await fs.readFile('README.md', 'utf8');
  assert.match(readme, /NOPASSWD: \/usr\/local\/bin\/<your-adopt-script>/, 'the README carries the rule, scoped to one script');
  assert.match(readme, /chmod 0440 \/etc\/sudoers\.d\/flipd/, 'and the mode that sudo requires of it');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/install.test.mjs`
Expected: FAIL — `install.sh no longer prints a sudoers rule`.

- [ ] **Step 3: Remove the block from `install.sh`**

Delete these six lines from `install.sh` (currently 312–317; confirm with `grep -n "sudoers, for a DEPLOY" install.sh` — the block starts two lines above that match at `cat <<EOF` and ends at `EOF`):

```sh
cat <<EOF

sudoers, for a DEPLOY command that needs root (one script, no password):
  echo 'flipd ALL=(root) NOPASSWD: /usr/local/bin/<your-adopt-script>' > /etc/sudoers.d/flipd
  chmod 0440 /etc/sudoers.d/flipd
EOF
```

Then, so the operator is still told where to look, change the final line of `install.sh` from:

```sh
say "next: sudo flipd add <git-url>"
```

to:

```sh
say "next: sudo flipd add <git-url>   (a DEPLOY that needs root: see README, Permissions)"
```

- [ ] **Step 4: Verify the script still parses**

Run: `sh -n install.sh && echo OK`
Expected: `OK`.

- [ ] **Step 5: Add the rule to the README's Permissions section**

In `README.md`, at the end of the `## Permissions` section (after the paragraph beginning `If you see either of those but`), add:

```markdown

### A DEPLOY command that needs root

`DEPLOY` runs as the `flipd` user. If it must do something only root can —
restart a system service, say — give `flipd` passwordless `sudo` for **one
script and nothing else**, and put the privileged steps in that script:

    echo 'flipd ALL=(root) NOPASSWD: /usr/local/bin/<your-adopt-script>' > /etc/sudoers.d/flipd
    chmod 0440 /etc/sudoers.d/flipd

Then `DEPLOY=sudo /usr/local/bin/<your-adopt-script>`. Keep the script's path
absolute and its contents root-owned and not group- or world-writable, or the
rule grants root to whoever can edit it. The installer used to print this on
every run; it lives here now so that it is read when it is needed rather than
skimmed when it is not.
```

- [ ] **Step 6: Run the install tests to verify they pass**

Run: `node --test test/install.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add install.sh README.md test/install.test.mjs
git commit -F - <<'MSG'
Move the sudoers hint from the installer's output to the README

install.sh printed a paste-ready NOPASSWD line on every run, including runs
where nothing needed root. The most security-sensitive suggestion in the tool
was also the most repeated, and a line seen every time stops being read.

The spec offered a conditional (print only when a DEPLOY references sudo) or
a move. This is the move: at install time there are normally no repo configs,
so the conditional would print nothing on a first install anyway, which is the
same result with a branch to maintain. The rule now lives under Permissions in
the README, with the hardening note the one-liner could not carry, and the
installer's last line points there by name.

Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf
MSG
```

---

### Task 4: Let `flipd check` print the webhook recipe

**Spec item:** Open · 4.

**Files:**
- Create: `lib/cli/recipe.mjs`
- Modify: `lib/cli/add.mjs:65-67` and `lib/cli/add.mjs:124-148` (the `stdout.write` template)
- Modify: `lib/cli/check.mjs:1-2` (imports) and `lib/cli/check.mjs:20-22` (after the rows loop)
- Create: `test/recipe.test.mjs`
- Test: `test/cli-add-check-env-remove.test.mjs`

**Interfaces:**
- Produces: `export function webhookRecipe({ host, ghRepo, mainConf })` in `lib/cli/recipe.mjs`. All three are strings. Returns a multi-line string with **no leading step number and no trailing newline**; the caller decides how to frame it. `host` is either a hostname or the literal placeholder `<PUBLIC_HOST>`; `ghRepo` is `owner/repo` or the literal `<owner>/<repo>`; `mainConf` is the path to `flipd.conf` (from `paths.mainConf`).
- Consumes: `loadMain(p)` and `loadRepo(p, name)` from `lib/config.mjs` — `loadMain` returns an object with `.publicHost` (string or `null`); `loadRepo` returns an object with `.repo` (the `REPO=` url string) and `.hookHost` (string or `null`). `parseRepoUrl(url)` from `lib/cli/add.mjs` returns `{ owner, repo, name }` or `null`.

**Background.** The recipe — Payload URL, where the secret lives, and the `gh api` pipeline that keeps the secret off argv — exists only inside `add`'s big `stdout.write` template, and `add` refuses to run twice. So if `--host` is set after `add` (the natural first-time order), the recipe was printed once with `<PUBLIC_HOST>` and can never be re-printed. `check` is the right second home: it is the "is this repo wired?" command and the one the README tells you to run after editing the config.

The existing `add` test asserts several argv-safety properties on the printed recipe (`--input -`, `--method POST`, no `-f config[secret]`, the `gh api` line carrying no `$(`). Those are the contract for the recipe *text*, so they move to a test of `webhookRecipe()` itself, and the `add` test keeps a lighter smoke assertion that the recipe is present. That way the properties are tested once, at the source, and hold for every caller.

- [ ] **Step 1: Write the failing test for `webhookRecipe`**

Create `test/recipe.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/recipe.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/cli/recipe.mjs'`.

- [ ] **Step 3: Create `lib/cli/recipe.mjs`**

```js
// lib/cli/recipe.mjs
//
// The webhook recipe, rendered once here and printed by both `add` and
// `check`. `add` prints it at the moment the repo is created; `check` prints it
// whenever asked, which matters because `add` refuses to run twice and the
// natural first-time order -- add, then install.sh --host -- means `add` only
// ever saw a placeholder for the host.
//
// The gh step builds the hook's JSON body on node's stdin and posts it with
// `gh api ... --input -`, rather than `-f config[secret]=$(...)`: a value
// interpolated into a `gh` flag lands in `gh`'s own argv, published for the
// life of that process in /proc/<pid>/cmdline (readable by any local user with
// ps) and in the operator's shell history. `SECRET=$(...) node -e '...'` puts
// the secret in node's environment instead, which only its owner or root can
// read. test/recipe.test.mjs holds those properties.
export function webhookRecipe({ host, ghRepo, mainConf }) {
  return `add the webhook (Settings > Webhooks):
   Payload URL    https://${host}/deploy
   Content type   application/json
   Secret         the WEBHOOK_SECRET in ${mainConf}
   Events         just the push event
   SECRET=$(sudo sed -n 's/^WEBHOOK_SECRET=//p' ${mainConf}) node -e '
     process.stdout.write(JSON.stringify({ name: "web", active: true, events: ["push"],
       config: { url: "https://${host}/deploy", content_type: "json", secret: process.env.SECRET } }));
   ' | gh api repos/${ghRepo}/hooks --method POST --input -`;
}
```

- [ ] **Step 4: Run the recipe test to verify it passes**

Run: `node --test test/recipe.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Make `add` use it**

In `lib/cli/add.mjs`, add the import after the existing `chownFlipd` import (line 8):

```js
import { webhookRecipe } from './recipe.mjs';
```

Then in the `stdout.write` template near the end of the file, replace the block that begins `2. add the webhook (Settings > Webhooks):` and ends with the line `   ' | gh api repos/${ghRepo}/hooks --method POST --input -` (nine lines) with exactly:

```
2. ${webhookRecipe({ host, ghRepo, mainConf: p.mainConf })}
```

Also delete the seven-line comment immediately above the `stdout.write(` call that begins `// The webhook recipe below builds the hook's JSON body on node's stdin` — its content now lives in `recipe.mjs`, and a comment describing code that is no longer here is the kind of stale safety comment this project has been bitten by before.

- [ ] **Step 6: Run the add tests — they must still pass unchanged**

Run: `node --test test/cli-add-check-env-remove.test.mjs`
Expected: PASS. The `add` test's assertions on `https://deploy.example.com/deploy`, `--input -`, `--method POST`, and the `gh api` lines all still hold because the rendered text is identical. If any fails, the rendered text differs from the original; diff the two and fix the recipe, not the test.

- [ ] **Step 7: Slim the `add` test to a smoke check (the properties now live in `test/recipe.test.mjs`)**

In `test/cli-add-check-env-remove.test.mjs`, in the test `'add writes the config with placeholders, ...'`, delete the block from the comment `// The webhook-creation recipe must never carry WEBHOOK_SECRET as a command's` through the closing `}` of the `for (const l of ghApiLines)` loop (it is about 20 lines: two `assert.match` for `--input -` and `--method POST`, one `doesNotMatch`, one `assert.match` for `process.env.SECRET`, the `ghApiLines` filter, and the loop). Replace it with:

```js
  // The recipe's argv-safety properties are tested at the source in
  // test/recipe.test.mjs. Here: only that add prints it, framed as step 2.
  assert.match(o.out(), /^2\. add the webhook/m);
  assert.match(o.out(), /gh api repos\/o\/r\/hooks --method POST --input -/);
```

Keep the existing `assert.ok(!o.out().includes('testsecret'), 'secret is never printed');` line — that one is about `add`, not the recipe.

- [ ] **Step 8: Run the cli tests to verify they pass**

Run: `node --test test/cli-add-check-env-remove.test.mjs`
Expected: PASS.

- [ ] **Step 9: Write the failing test for `check` printing the recipe**

Add to `test/cli-add-check-env-remove.test.mjs`, immediately after the existing `check:` test:

```js
test('check prints the webhook recipe with the current PUBLIC_HOST, so it can be read after --host', async () => {
  const p = await makePrefix();
  await writeRepoConf(p, 'r', { REPO: 'git@github.com:o/r.git', BRANCH: 'main', ROOT: '.', BUILD: 'true', DEPLOY: 'true' });
  const send = (reply) => async () => reply;
  const ok = { ok: true, passed: true, behind: false, rows: [['main', 'x  up to date']] };

  // Host known: the recipe carries it.
  await writeMain(p, 'PUBLIC_HOST=deploy.example.com\n');
  const o = io();
  assert.equal(await check(['r'], { paths: p, ...o, sendOverride: send(ok) }), 0);
  assert.match(o.out(), /^main\s+x  up to date$/m, 'the rows still print first');
  assert.match(o.out(), /^webhook/m, 'the recipe is a labelled section after the rows');
  assert.match(o.out(), /Payload URL\s+https:\/\/deploy\.example\.com\/deploy/);
  assert.match(o.out(), /gh api repos\/o\/r\/hooks --method POST --input -/);
  assert.ok(!o.out().includes('testsecret'), 'secret is never printed');

  // Host not known yet: the placeholder, not a crash and not silence.
  await writeMain(p);
  const o2 = io();
  assert.equal(await check(['r'], { paths: p, ...o2, sendOverride: send(ok) }), 0);
  assert.match(o2.out(), /https:\/\/<PUBLIC_HOST>\/deploy/);

  // A failed check still prints it: the rows say what failed, the recipe is
  // still the next thing the operator needs.
  const o3 = io();
  assert.equal(await check(['r'], { paths: p, ...o3, sendOverride: send({ ok: true, passed: false, rows: [['remote', 'MISMATCH']] }) }), 1);
  assert.match(o3.out(), /Payload URL/);

  // No repo conf on disk (the service reported on a name it knows but we
  // cannot read): the rows print, the recipe is skipped, and the exit code is
  // the service's verdict, not a read error.
  const o4 = io();
  assert.equal(await check(['nothere'], { paths: p, ...o4, sendOverride: send(ok) }), 0);
  assert.match(o4.out(), /^main\s+x  up to date$/m);
  assert.doesNotMatch(o4.out(), /Payload URL/);
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `node --test test/cli-add-check-env-remove.test.mjs`
Expected: FAIL — `the recipe is a labelled section after the rows`.

- [ ] **Step 11: Make `check` print the recipe**

Replace the two import lines at the top of `lib/cli/check.mjs` with:

```js
import { checkName } from '../paths.mjs';
import { sendCommand } from '../socket.mjs';
import { loadMain, loadRepo } from '../config.mjs';
import { parseRepoUrl } from './add.mjs';
import { webhookRecipe } from './recipe.mjs';
```

Then replace the last three lines of the function (from `for (const [k, v] of reply.rows ?? [])` through `return reply.behind ? 4 : 0;`) with:

```js
  for (const [k, v] of reply.rows ?? []) stdout.write(`${k.padEnd(8)} ${v}\n`);

  // The webhook recipe, re-printable. `add` shows it once, and if --host was
  // set afterwards it showed a placeholder; this is the second chance. Best
  // effort: a conf that cannot be read means the rows above already said so
  // (or the service did), and the recipe is not worth a second error. The
  // host comes from the main conf first, then the HOOK_HOST recorded at add
  // time, then a placeholder -- never a guess.
  let repo = null;
  try { repo = await loadRepo(p, name); } catch { /* rows already report a bad conf */ }
  if (repo) {
    let main = null;
    try { main = await loadMain(p); } catch { /* installer not run yet: placeholder */ }
    const host = main?.publicHost ?? repo.hookHost ?? '<PUBLIC_HOST>';
    const gh = parseRepoUrl(repo.repo);
    const ghRepo = gh ? `${gh.owner}/${gh.repo}` : '<owner>/<repo>';
    stdout.write(`\nwebhook  ${webhookRecipe({ host, ghRepo, mainConf: p.mainConf })}\n`);
  }

  if (!reply.passed) return 1;
  return reply.behind ? 4 : 0;   // 4: nothing is wrong with the setup, but live is not the head
```

Note the recipe's first line is `add the webhook (Settings > Webhooks):`, so the printed section reads `webhook  add the webhook (Settings > Webhooks):` followed by the indented fields — the `webhook` label matches the padded row style above it.

- [ ] **Step 12: Run the cli tests to verify they pass**

Run: `node --test test/cli-add-check-env-remove.test.mjs`
Expected: PASS, including the new test's four scenarios.

- [ ] **Step 13: Update the README's Commands row for `check`**

In `README.md`, in the `## Commands` table, the `flipd check` row's third column currently ends with `; \`3\` service down (or unreachable — see [Permissions](#permissions))`. Append to that cell, before the closing `|`:

```
. Also prints the webhook recipe (Payload URL, secret location, `gh api` pipeline) with the current `PUBLIC_HOST`, so it can be read again after `--host`
```

And in the `## Add a repo` section, change the comment line

```
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints)
```

to

```
    # paste the deploy key and the webhook it prints (or run the deploy-key
    # command and the webhook pipeline it prints). If you set --host after
    # this, `flipd check app` prints the webhook recipe again with the real host.
```

- [ ] **Step 14: Run the full suite**

Run: `npm test`
Expected: `# fail 0`, and `# tests` is three higher than before this task (the three new recipe tests) plus one (the new check test).

- [ ] **Step 15: Commit**

```bash
git add lib/cli/recipe.mjs lib/cli/add.mjs lib/cli/check.mjs test/recipe.test.mjs test/cli-add-check-env-remove.test.mjs README.md
git commit -F - <<'MSG'
Print the webhook recipe from check as well as add

The recipe -- Payload URL, where the secret lives, the gh api pipeline that
keeps the secret off argv -- lived only inside add's output, and add refuses
to run twice. In the natural first-time order, add then install.sh --host, it
was printed once with a <PUBLIC_HOST> placeholder and could never be printed
again with the real name. On the first real install that is exactly what
happened.

The text moves to lib/cli/recipe.mjs and both commands render it from there.
check prints it after its rows, best-effort: host from the main conf, then the
HOOK_HOST recorded at add time, then the placeholder; repo from the conf's
REPO line. A conf that cannot be read skips the recipe rather than adding a
second error to rows that already report one.

The argv-safety assertions that guarded add's output now test the recipe
function directly, once, so they hold for every command that prints it.

Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf
MSG
```

---

### Task 5: Give the shipped Caddy block an access log

**Spec item:** Open · 5.

**Files:**
- Modify: `install.sh:228-235` (the `CADDY_BLOCK=` heredoc)
- Modify: `README.md:12-24` (the Install section — the paragraph beginning `` `--host` needs a name ``)
- Test: `test/install.test.mjs`

**Interfaces:** none.

**Background.** With the shipped block, a delivery that flipd accepted left no trace at either layer: flipd was silent (fixed in Task 1) and Caddy's access log is off by default. Proving on the first real install that GitHub's ping had arrived meant hand-editing `/etc/caddy/conf.d/flipd.caddy`, and that edit is overwritten by the next `install.sh --host`. Two facts from that install decide the shape here: `output file /var/log/caddy/...` fails under the Debian unit's sandbox with `permission denied` even when the directory is owned by `caddy`; and a stray file left in `conf.d/` is picked up by the `import /etc/caddy/conf.d/*` glob and breaks the reload with `ambiguous site definition`. Journald sidesteps the first; the README note covers the second.

- [ ] **Step 1: Write the failing test**

Add to `test/install.test.mjs` at the end:

```js
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
  assert.match(block, /^\s+log \{\s*\n\s+output stderr\s*\n\s+\}/m, 'a log directive writing to stderr, which the unit sends to journald');
  // `output file /var/log/caddy/...` is refused by the Debian unit's sandbox
  // with "permission denied" even when caddy owns the directory; observed.
  assert.doesNotMatch(block, /output file/, 'never a file: the sandbox refuses it');
  // The directive must be inside the site block, not at the top level of the
  // Caddyfile, or it would apply to (and be ambiguous with) other sites.
  const logIndex = block.indexOf('log {');
  const handleIndex = block.indexOf('handle /deploy');
  assert.ok(logIndex > 0 && logIndex < handleIndex, 'log is declared inside the site, before the handlers');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/install.test.mjs`
Expected: FAIL — `a log directive writing to stderr, which the unit sends to journald`.

- [ ] **Step 3: Add the `log` block to the heredoc**

In `install.sh`, replace the `CADDY_BLOCK=` assignment (currently lines 228–235):

```sh
CADDY_BLOCK="${HOST:-deploy.example.com} {
    handle /deploy {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        respond 404
    }
}"
```

with:

```sh
# `log` goes to stderr, which the Debian unit sends to journald, so
# `journalctl -u caddy` shows every request to this site with its source IP,
# method, URI and status. That is the only record of a request flipd never
# receives -- a TLS failure, a 404 on the wrong path, a proxy that never
# forwarded -- and on a first install it is how an operator confirms that
# GitHub's ping arrived at all. Not `output file`: the unit's sandbox refuses
# writes under /var/log/caddy even when caddy owns the directory.
CADDY_BLOCK="${HOST:-deploy.example.com} {
    log {
        output stderr
    }
    handle /deploy {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        respond 404
    }
}"
```

- [ ] **Step 4: Verify the script still parses**

Run: `sh -n install.sh && echo OK`
Expected: `OK`.

- [ ] **Step 5: Run the install tests to verify they pass**

Run: `node --test test/install.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 6: Add the README note**

In `README.md`, in the `## Install (once per server)` section, the paragraph that begins `` `--host` needs a name that already points at the box `` currently ends with `and the Caddy block is printed to paste by hand.` Append to that paragraph:

```
The block logs every request to the site — source IP, method, path, status —
to journald, so `journalctl -u caddy` is where to look when a webhook seems
not to arrive. The block lives at `/etc/caddy/conf.d/flipd.caddy` and is
rewritten on each `--host` run, so hand edits there do not survive; and
everything in `conf.d/` is imported, so a backup file left there defines the
site twice and Caddy refuses the reload.
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add install.sh README.md test/install.test.mjs
git commit -F - <<'MSG'
Log every request to the flipd site in the shipped Caddy block

With the shipped block, a delivery from GitHub that flipd accepted left no
trace at either layer: flipd was silent, and Caddy's access log is off by
default. Proving on the first real install that the ping had arrived meant
editing /etc/caddy/conf.d/flipd.caddy by hand, and that edit is overwritten
by the next --host run.

The site block now carries `log { output stderr }`. Journald, not a file: the
Debian unit's sandbox refuses writes under /var/log/caddy even when caddy owns
the directory, observed on that install. For a single endpoint receiving a
handful of requests a day there is no volume argument against logging all of
them, and the site block is the only layer that sees a request flipd never
receives.

The README now says where the log is, that the block is rewritten on each
--host run, and that anything left in conf.d/ is imported -- a backup file
there defines the site twice and Caddy refuses the reload.

Claude-Session: https://claude.ai/code/session_01PtorKwzrHVj1dDBJ2RacFf
MSG
```

---

## After all five tasks

- [ ] Run `npm test` once more and record the final count.
- [ ] In `docs/superpowers/specs/2026-09-06-real-install-findings.md`, tick the five `[ ]` boxes under **Open** to `[x]` and add a one-line `**Done:** <commit>` under each item's Size line. Commit that with the message `Tick the five real-install items as done` and the session trailer.
- [ ] Do **not** push from inside the plan. A push to `main` triggers a live deploy on the test box; the operator decides when.
