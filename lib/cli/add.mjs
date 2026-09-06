import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { NAME_RE, loadMain, loadAccount } from '../config.mjs';
import { HOST_RE } from '../paths.mjs';
import { parseRepoUrl } from '../repourl.mjs';
import { createForge, ForgeError } from '../forge.mjs';
import { chownFlipd } from '../owner.mjs';
import { webhookRecipe } from './recipe.mjs';

const run = promisify(execFile);

// The conf both paths write. REPO differs: the manual path writes what the
// operator gave (rewritten to scp form for github.com), the forge path writes
// the ssh_url the forge itself rendered.
function confLines({ repoUrl, branch, root, build, deploy, sharedKey, hookHost }) {
  return [
    `REPO=${repoUrl}`,
    `BRANCH=${branch}`,
    `ROOT=${root}`,
    build ? `BUILD=${build}` : '#BUILD=npm ci && npm test',
    deploy ? `DEPLOY=${deploy}` : '#DEPLOY=sudo /usr/local/bin/<your-adopt-script>',
    '#ON_FAILURE=curl -fsS -m 10 -d "$DEPLOY_NAME $DEPLOY_OUTCOME $DEPLOY_SHA $DEPLOY_LOG" https://ntfy.sh/<topic>',
    '#WATCH=src/** package.json',
    '#IGNORE=**/*.md docs/**',
    '#TIMEOUT=1200',
    ...(sharedKey ? [`KEY=${sharedKey}`] : []),
    ...(hookHost ? [`HOOK_HOST=${hookHost}`] : []),
  ];
}

async function writeConf(p, conf, lines) {
  await fs.mkdir(p.reposDir, { recursive: true });
  await fs.writeFile(conf, lines.join('\n') + '\n');
  await chownFlipd(conf, { mode: 0o640, root: true });
}

// Generates the key pair unless one is already there or --key was given.
// Returns what this call created, so a failing forge path can undo exactly that.
async function ensureKey(p, name, sharedKey) {
  const dir = p.repoDir(name);
  const dirExisted = await fs.stat(dir).then(() => true, () => false);
  // The directory is chmod'd to owner-only (0750: no "other" bits at all)
  // before anything is generated inside it. ssh-keygen itself always saves
  // the private key at mode 0600, but the belt-and-suspenders point of doing
  // this first is that the *directory* denies any other local user entry
  // for the entire time the key exists, not just from the moment the key's
  // own chmod (below) lands.
  await fs.mkdir(dir, { recursive: true });
  await chownFlipd(dir, { mode: 0o750 });
  const key = sharedKey ?? path.join(dir, 'key');
  let generated = false;
  if (!sharedKey) {
    try { await fs.stat(key); } catch {
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `flipd@${os.hostname()}`, '-f', key]);
      await chownFlipd(key, { mode: 0o600 });
      await chownFlipd(`${key}.pub`, { mode: 0o644 });
      generated = true;
    }
  }
  const pub = (await fs.readFile(`${key}.pub`, 'utf8').catch(() => '')).trim();
  return { dir, dirExisted, key, generated, pub };
}

export default async function (args, { paths: p, stdout, stderr, forgeOverride }) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' }, branch: { type: 'string' }, root: { type: 'string' }, build: { type: 'string' }, deploy: { type: 'string' }, key: { type: 'string' } } });
  } catch (e) {
    stderr.write(`${e.message}\n`); return 2;
  }
  const usage = 'usage: flipd add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]\n';
  const url = parsed.positionals[0];
  // A second (or third...) bare word is what an unquoted --build/--deploy
  // spills into (parseArgs takes exactly one token as the option's value and
  // leaves the rest as positionals) — that is a usage mistake, not silently
  // dropped input.
  if (!url || parsed.positionals.length > 1) { stderr.write(usage); return 2; }
  const parsedUrl = parseRepoUrl(url);
  // Only github.com gets the https→scp rewrite and the `gh` instructions
  // below; a Forgejo URL parses too but must be written as given.
  const gh = parsedUrl?.host === 'github.com' ? parsedUrl : null;
  const name = parsed.values.name ?? parsedUrl?.name;
  if (!name) { stderr.write(`cannot derive a name from ${url}; pass --name\n`); return 1; }
  if (!NAME_RE.test(name)) { stderr.write(`bad name "${name}": must match ${NAME_RE}\n`); return 1; }

  // Validate every value that is about to be written into the conf file
  // before anything is created: a rejected invocation must leave no partial
  // state (no directory, no key, no conf) behind for a retry to trip over.
  const { branch = 'main', root = '.', build, deploy } = parsed.values;
  const writtenValues = [['<git-url>', url], ['--name', parsed.values.name], ['--branch', parsed.values.branch], ['--root', parsed.values.root], ['--build', build], ['--deploy', deploy], ['--key', parsed.values.key]];
  for (const [flag, v] of writtenValues) {
    if (typeof v === 'string' && /[\r\n]/.test(v)) { stderr.write(`${flag} contains a newline or carriage return, which a config line cannot hold\n`); return 1; }
  }
  // Same check, same wording, that parseRepo (lib/config.mjs) applies when the
  // conf is later loaded — reject it here instead of writing a conf that
  // reports success today and fails every check/run from now on.
  if (path.isAbsolute(root) || root.split('/').includes('..')) {
    stderr.write(`ROOT must be relative with no "..", got "${root}"\n`);
    return 1;
  }

  const conf = p.repoConf(name);
  try { await fs.stat(conf); stderr.write(`${conf} already exists\n`); return 1; } catch { /* good */ }

  // A deploy key attaches to exactly one repository. A key shared across repos can
  // only be a machine user's, so --key skips generation and changes the instruction.
  // Checked here, before anything is created: this is the last pre-flight
  // validation, so a missing --key path leaves no directory behind either.
  const sharedKey = parsed.values.key ?? null;
  if (sharedKey) {
    try { await fs.stat(sharedKey); } catch { stderr.write(`--key ${sharedKey}: no such file\n`); return 1; }
  }

  // An account for this host switches `add` from printing the two setup
  // steps to performing them. Absent (null) means the manual path; present
  // but unreadable stops here — silently demoting to manual would print a
  // recipe the operator thinks they no longer need to follow.
  let account = null;
  if (parsedUrl && HOST_RE.test(parsedUrl.host)) {
    try {
      account = await loadAccount(p, parsedUrl.host);
    } catch (e) {
      stderr.write(`${p.accountConf(parsedUrl.host)}: ${e.message}\n`); return 1;
    }
  }

  let main = null;
  try { main = await loadMain(p); } catch { /* installer not run yet; print placeholders */ }

  if (account) {
    return addViaForge({ p, stdout, stderr, forgeOverride, account, main, parsedUrl, name, conf, branch, root, build, deploy, sharedKey });
  }

  const host = main?.publicHost ?? '<PUBLIC_HOST>';
  const { key, pub } = await ensureKey(p, name, sharedKey);

  // The https form is accepted as input — it is what a browser's address bar
  // gives you — but REPO is matched for strict equality against the push
  // payload's `repository.ssh_url`, which GitHub always renders as
  // git@github.com:owner/repo.git. Writing the https URL verbatim produced a
  // repo that could never match a push (findRepoFor returns null, the hook
  // answers `200 ignored`, and one journald line is the only trace) while
  // `check` still passed every row, because ls-remote over https works
  // anonymously: the command whose whole job is catching a lost webhook
  // reporting green on a repo that can never receive one. So normalise to the
  // ssh form whenever the URL was recognisably GitHub's; anything else (a
  // GitLab host, a file:// URL) is written as given.
  await writeConf(p, conf, confLines({
    repoUrl: gh ? `git@github.com:${gh.owner}/${gh.repo}.git` : url,
    branch, root, build, deploy, sharedKey, hookHost: main?.publicHost,
  }));

  const ghRepo = gh ? `${gh.owner}/${gh.repo}` : '<owner>/<repo>';
  const keyStep = sharedKey
    ? `1. KEY=${sharedKey} is a machine user's key, so it is NOT added as a deploy key (GitHub
   allows a deploy key on one repository only). Add the machine user as a read-only
   collaborator on ${ghRepo} instead (Settings > Collaborators), if it is not one already:
   ${pub || '(public key: ' + sharedKey + '.pub)'}`
    : `1. add this read-only deploy key to the repo (Settings > Deploy keys):
   ${pub}
   gh repo deploy-key add ${key}.pub -R ${ghRepo} --title ${os.hostname()}`;
  stdout.write(`wrote ${conf}${build && deploy ? '' : '   (BUILD and DEPLOY are placeholders: edit them)'}
${sharedKey ? `using ${sharedKey}` : `generated ${key}`}

${keyStep}

2. ${webhookRecipe({ host, ghRepo, mainConf: p.mainConf })}

3. edit ${conf}, then:  flipd check ${name}
`);
  return 0;
}

// The automated path. Order: read-only calls, then local writes, then forge
// writes, then the conf — so every failure leaves the least to undo, and what
// it does leave is undone here.
async function addViaForge({ p, stdout, stderr, forgeOverride, account, main, parsedUrl, name, conf, branch, root, build, deploy, sharedKey }) {
  const publicHost = main?.publicHost ?? null;
  if (!publicHost) {
    stderr.write(`PUBLIC_HOST is not set in ${p.mainConf}; run install.sh --host <host> first, then add\n`);
    return 1;
  }
  const hookUrl = `https://${publicHost}/deploy`;
  const { owner, repo } = parsedUrl;
  const at = `${account.host} ${owner}/${repo}`;
  const forge = (forgeOverride ?? createForge)(account);
  const title = `flipd@${os.hostname()}`;

  // 1. The repository, as the forge sees it. Its ssh_url is what every push
  //    payload will carry, custom SSH port included, so it becomes REPO.
  let remote;
  try {
    remote = await forge.getRepo(owner, repo);
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    if (e.status === 404) { stderr.write(`${at}: not found on ${account.host}, or the token cannot see it\n`); return 1; }
    if (e.status === 401 || e.status === 403) { stderr.write(`${at}: token rejected by ${account.host} (${e.status})\n`); return 1; }
    stderr.write(`${at}: ${e.message}\n`); return 1;
  }
  if (typeof remote.sshUrl !== 'string' || !remote.sshUrl) { stderr.write(`${at}: the API returned no ssh_url\n`); return 1; }

  // 2. An existing hook with our URL is left alone: no API returns a hook's
  //    secret, so it cannot be verified, and GitHub would 422 a duplicate
  //    while Forgejo would silently create one and double every delivery.
  let hooks;
  try {
    hooks = await forge.listHooks(owner, repo);
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    stderr.write(`${at}: ${e.message}\n`); return 1;
  }
  const existing = hooks.find((h) => h.url === hookUrl) ?? null;

  // From here on there is something to undo. dirExisted is captured before
  // ensureKey runs so undo knows what to remove even if ensureKey itself
  // throws before returning (it may not return at all).
  const dir = p.repoDir(name);
  const dirExisted = await fs.stat(dir).then(() => true, () => false);
  let key = sharedKey ?? path.join(dir, 'key');
  let generated = false;
  let pub = '';
  let keyId = null;
  let hookId = existing?.id ?? null;

  // Never throws: a cleanup failure becomes a note for the operator instead of
  // replacing whatever error is being reported (the way a thrown fs.rm would).
  const undo = async () => {
    const notes = [];
    if (keyId !== null) {
      try { await forge.deleteDeployKey(owner, repo, keyId); } catch { notes.push(`delete the deploy key "${title}" (id ${keyId}) on ${at} by hand`); }
    }
    if (generated) {
      try { await fs.rm(key, { force: true }); } catch { notes.push(`remove ${key} by hand`); }
      try { await fs.rm(`${key}.pub`, { force: true }); } catch { notes.push(`remove ${key}.pub by hand`); }
    }
    if (!dirExisted) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { notes.push(`remove ${dir} by hand`); }
    }
    return notes;
  };

  // 3, 4, 5 and 6: local key generation, the forge writes, and the conf,
  // last — one guarded region. A failure at any point here (a rejected forge
  // call, a permission error writing the conf, ssh-keygen missing) means
  // something this run already created must be undone, not merely a forge
  // write gone wrong.
  try {
    ({ key, generated, pub } = await ensureKey(p, name, sharedKey));
    if (!sharedKey) keyId = (await forge.addDeployKey(owner, repo, { title, key: pub })).id;
    if (!existing) hookId = (await forge.addHook(owner, repo, { url: hookUrl, secret: main.webhookSecret })).id;
    await writeConf(p, conf, confLines({ repoUrl: remote.sshUrl, branch, root, build, deploy, sharedKey, hookHost: publicHost }));
  } catch (e) {
    const notes = await undo();
    const detail = e instanceof ForgeError ? `${at}: ${e.message}` : e.message;
    stderr.write(`${detail}\n${notes.map((n) => `  ${n}\n`).join('')}nothing was written; fix the cause and run add again\n`);
    return 1;
  }

  const keyLine = sharedKey
    ? `  deploy key         not added: KEY=${sharedKey} is a machine user's key. Add that user as a read-only collaborator on ${owner}/${repo} if it is not one already`
    : `  deploy key added   ${title} (id ${keyId}, read-only)`;
  const hookLine = existing
    ? `  webhook present    ${hookUrl} (id ${hookId}); left alone. If deliveries are refused 401 its secret is stale: delete it on ${account.host}, flipd remove ${name}, add again`
    : `  webhook added      ${hookUrl} (id ${hookId}, push only)`;
  stdout.write(`wrote ${conf}${build && deploy ? '' : '   (BUILD and DEPLOY are placeholders: edit them)'}
${sharedKey ? `using ${sharedKey}` : `generated ${key}`}
${at}:
${keyLine}
${hookLine}

edit ${conf}, then:  flipd check ${name}
`);
  return 0;
}
