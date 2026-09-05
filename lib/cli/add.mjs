import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { NAME_RE, loadMain } from '../config.mjs';
import { chownRemoteDeploy } from '../owner.mjs';

const run = promisify(execFile);

export function parseRepoUrl(url) {
  const m = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2], name: m[2].toLowerCase() };
}

export default async function (args, { paths: p, stdout, stderr }) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' }, branch: { type: 'string' }, root: { type: 'string' }, build: { type: 'string' }, deploy: { type: 'string' }, key: { type: 'string' } } });
  } catch (e) {
    stderr.write(`${e.message}\n`); return 2;
  }
  const url = parsed.positionals[0];
  if (!url) { stderr.write('usage: remote-deploy add <git-url> [--name N] [--branch B] [--root R] [--build C] [--deploy C] [--key PATH]\n'); return 2; }
  const gh = parseRepoUrl(url);
  const name = parsed.values.name ?? gh?.name;
  if (!name) { stderr.write(`cannot derive a name from ${url}; pass --name\n`); return 1; }
  if (!NAME_RE.test(name)) { stderr.write(`bad name "${name}": must match ${NAME_RE}\n`); return 1; }
  const conf = p.repoConf(name);
  try { await fs.stat(conf); stderr.write(`${conf} already exists\n`); return 1; } catch { /* good */ }

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
  await chownRemoteDeploy(dir, { mode: 0o750 });
  // A deploy key attaches to exactly one repository. A key shared across repos can
  // only be a machine user's, so --key skips generation and changes the instruction.
  const sharedKey = parsed.values.key ?? null;
  const key = sharedKey ?? path.join(dir, 'key');
  if (sharedKey) {
    try { await fs.stat(sharedKey); } catch { stderr.write(`--key ${sharedKey}: no such file\n`); return 1; }
  } else {
    try { await fs.stat(key); } catch {
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `remote-deploy@${os.hostname()}`, '-f', key]);
      await chownRemoteDeploy(key, { mode: 0o600 });
      await chownRemoteDeploy(`${key}.pub`, { mode: 0o644 });
    }
  }
  const pub = (await fs.readFile(`${key}.pub`, 'utf8').catch(() => '')).trim();

  const { branch = 'main', root = '.', build, deploy } = parsed.values;
  const lines = [
    `REPO=${url}`,
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
  await chownRemoteDeploy(conf, { mode: 0o640, root: true });

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

2. add the webhook (Settings > Webhooks):
   Payload URL    https://${host}/deploy
   Content type   application/json
   Secret         the WEBHOOK_SECRET in ${p.mainConf}
   Events         just the push event
   gh api repos/${ghRepo}/hooks -f name=web -F active=true -f 'events[]=push' \\
     -f config[url]=https://${host}/deploy -f config[content_type]=json \\
     -f "config[secret]=$(sudo sed -n 's/^WEBHOOK_SECRET=//p' ${p.mainConf})"

3. edit ${conf}, then:  remote-deploy check ${name}
`);
  return 0;
}
