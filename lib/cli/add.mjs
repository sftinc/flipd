import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { NAME_RE, loadMain } from '../config.mjs';
import { chownFlipd } from '../owner.mjs';
import { webhookRecipe } from './recipe.mjs';
import { parseRepoUrl } from '../repourl.mjs';

const run = promisify(execFile);

export default async function (args, { paths: p, stdout, stderr }) {
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

  let main = null;
  try { main = await loadMain(p); } catch { /* installer not run yet; print placeholders */ }
  const host = main?.publicHost ?? '<PUBLIC_HOST>';

  const dir = p.repoDir(name);
  // The directory is chmod'd to owner-only (0750: no "other" bits at all)
  // before anything is generated inside it. ssh-keygen itself always saves
  // the private key at mode 0600, but the belt-and-suspenders point of doing
  // this first is that the *directory* denies any other local user entry
  // for the entire time the key exists, not just from the moment the key's
  // own chmod (below) lands.
  await fs.mkdir(dir, { recursive: true });
  await chownFlipd(dir, { mode: 0o750 });
  const key = sharedKey ?? path.join(dir, 'key');
  if (!sharedKey) {
    try { await fs.stat(key); } catch {
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `flipd@${os.hostname()}`, '-f', key]);
      await chownFlipd(key, { mode: 0o600 });
      await chownFlipd(`${key}.pub`, { mode: 0o644 });
    }
  }
  const pub = (await fs.readFile(`${key}.pub`, 'utf8').catch(() => '')).trim();

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
  const lines = [
    `REPO=${gh ? `git@github.com:${gh.owner}/${gh.repo}.git` : url}`,
    `BRANCH=${branch}`,
    `ROOT=${root}`,
    build ? `BUILD=${build}` : '#BUILD=npm ci && npm test',
    deploy ? `DEPLOY=${deploy}` : '#DEPLOY=sudo /usr/local/bin/<your-adopt-script>',
    '#ON_FAILURE=curl -fsS -m 10 -d "$DEPLOY_NAME $DEPLOY_OUTCOME $DEPLOY_SHA $DEPLOY_LOG" https://ntfy.sh/<topic>',
    '#WATCH=src/** package.json',
    '#IGNORE=**/*.md docs/**',
    '#TIMEOUT=1200',
    ...(sharedKey ? [`KEY=${sharedKey}`] : []),
    ...(main?.publicHost ? [`HOOK_HOST=${main.publicHost}`] : []),
  ];
  await fs.mkdir(p.reposDir, { recursive: true });
  await fs.writeFile(conf, lines.join('\n') + '\n');
  await chownFlipd(conf, { mode: 0o640, root: true });

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
