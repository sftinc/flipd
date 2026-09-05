import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseKV, ConfigError, loadRepo } from '../config.mjs';
import { chownRemoteDeploy } from '../owner.mjs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function writeAtomic(file, text) {
  await fs.writeFile(`${file}.tmp`, text, { mode: 0o640 });
  await chownRemoteDeploy(`${file}.tmp`, { mode: 0o640, root: true });
  await fs.rename(`${file}.tmp`, file);
}

// parseKV's ConfigError message embeds the offending line's raw text (e.g.
// `line 3: expected KEY=value, got "sk_live_..."`) — exactly right for
// build.conf/repo.conf, exactly wrong here: this file's lines are secret
// values. Never relay e.message to the operator; report only the line
// number parseKV already put first.
function syntaxErrorLine(e) {
  const m = /^line (\d+)/.exec(e.message);
  return m ? m[1] : '?';
}

// The key a line would parse as, or null for a line parseKV itself would
// skip (blank, a comment) or reject (no "="). Mirrors parseKV's own
// trim-then-split rule exactly, so "which line does --set K=V replace"
// agrees with "which line does the service read as K".
function lineKey(raw) {
  const t = raw.trim();
  if (!t || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq < 1) return null;
  return t.slice(0, eq).trim();
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export default async function (args, { paths: p, stdout, stderr }) {
  const [name, phase, ...rest] = args;
  if (!name || !['build', 'deploy'].includes(phase)) { stderr.write('usage: remote-deploy env <name> build|deploy [--set K=V] [--unset K]\n'); return 2; }
  const sets = [];
  const unsets = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--set') sets.push(rest[++i]);
    else if (rest[i] === '--unset') unsets.push(rest[++i]);
    // Only the flag-name half of an unrecognized token is ever echoed: a
    // forgotten "--set" before a second K=V (env r build --set TOK=abc
    // SECOND=supersecret) must not turn a usage typo into a leak.
    else { stderr.write(`unknown argument ${rest[i]?.split('=')[0] ?? rest[i]}\n`); return 2; }
  }
  for (const k of unsets) {
    if (typeof k !== 'string') { stderr.write('--unset requires a KEY argument\n'); return 1; }
  }
  // The file the run will actually read: the config may point elsewhere.
  const repo = await loadRepo(p, name);
  const file = phase === 'build' ? repo.buildEnvFile : repo.deployEnvFile;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.stat(file); } catch { await writeAtomic(file, ''); }
  await chownRemoteDeploy(file, { mode: 0o640, root: true });

  const label = `${name}.${phase}`;
  const report = (kv) => stdout.write(`${label}: ${[...kv.keys()].join(' ') || '(empty)'}\n`);

  if (sets.length || unsets.length) {
    const text = await fs.readFile(file, 'utf8');
    // Validate the file as it stands today before touching it: a line
    // already too broken for parseKV to read is the run's problem, not
    // something --set should silently paper over by rewriting past it.
    try { parseKV(text, null); } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      stderr.write(`${file}: bad syntax at line ${syntaxErrorLine(e)}; fix it with: sudo remote-deploy env ${name} ${phase}\n`);
      return 1;
    }

    // Rewritten line-oriented, not by rebuilding the file from a Map: this is
    // the only supported way an operator touches these files, and the format
    // supports comments and blank lines (the $EDITOR path invites them). A
    // round trip through a Map would silently discard every one of them.
    // --set replaces the existing line for that key in place, or appends a
    // new line if there is none; --unset drops the line(s) for that key;
    // every other line — comments, blanks, ordering — is left byte-identical.
    let lines = splitLines(text);
    const trimmedKeys = [];
    for (const s of sets) {
      const eq = s?.indexOf('=') ?? -1;
      if (eq <= 0) { stderr.write('--set wants KEY=value, got no "=" in the argument\n'); return 1; }
      const k = s.slice(0, eq);
      // Only the key is ever echoed back on a bad shape — never the value,
      // so a botched paste never turns a usage error into a leak.
      if (!KEY_RE.test(k)) { stderr.write(`--set wants a plain KEY before "=", got key "${k}"\n`); return 1; }
      const raw = s.slice(eq + 1);
      // A value with an embedded newline turns into extra, un-keyed line(s)
      // that break every other key below it in the file — the exact way a
      // pasted PEM or a service-account JSON blob corrupts NPM_TOKEN and
      // friends. Reject it outright; name the key only, never the value.
      if (/[\r\n]/.test(raw)) { stderr.write(`--set ${k}: the value contains a newline; an env file holds one KEY=value per line\n`); return 1; }
      const v = raw.trim();
      // Trim before writing, not just on read: the file the operator can see
      // must show the exact value the build receives, not a padded string
      // that quietly becomes something shorter by the time it is loaded.
      if (v !== raw) trimmedKeys.push(k);
      const line = `${k}=${v}`;
      const idx = lines.findIndex((l) => lineKey(l) === k);
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
    }
    for (const k of unsets) lines = lines.filter((l) => lineKey(l) !== k);

    const assembled = lines.length ? `${lines.join('\n')}\n` : '';
    let kv;
    try {
      kv = parseKV(assembled, null);
    } catch {
      // A bug above must never ship a file the service cannot read: verify
      // the exact bytes about to be written parse before writing them.
      // Deliberately does not include the parse error (it would quote the
      // very line — someone's value — that tripped it).
      throw new Error(`internal error: the rewritten ${file} would not parse; nothing was written`);
    }
    await writeAtomic(file, assembled);
    if (trimmedKeys.length) stdout.write(`note: trimmed leading/trailing whitespace from: ${[...new Set(trimmedKeys)].join(' ')}\n`);
    report(kv);
    return 0;
  }

  // Edit a copy: the live file is replaced only by a version that parses, so a
  // build that starts mid-edit never reads a half-typed line.
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const draft = `${file}.edit`;
  await fs.copyFile(file, draft);
  await chownRemoteDeploy(draft, { mode: 0o640, root: true });
  try {
    for (;;) {
      const r = spawnSync(editor, [draft], { stdio: 'inherit', shell: editor.includes(' ') });
      if (r.status !== 0) { stderr.write(`${editor} exited ${r.status}; ${file} left as is\n`); return 1; }
      try {
        const kv = parseKV(await fs.readFile(draft, 'utf8'), null);
        await fs.rename(draft, file);
        report(kv);
        return 0;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        // Without a tty to prompt on, the "press enter to retry" loop below
        // spins forever against any editor that exits 0 without fixing the
        // draft — trivially reachable from cron, ansible, or a non-interactive
        // ssh command. Fail fast instead of spinning.
        if (!process.stdin.isTTY) {
          stderr.write(`${draft}: bad syntax at line ${syntaxErrorLine(e)}; refusing to prompt for a retry without a terminal\n`);
          return 1;
        }
        stderr.write(`${draft}: bad syntax at line ${syntaxErrorLine(e)}. Press enter to edit again, or ctrl-c to discard the edit.\n`);
        spawnSync('sh', ['-c', 'read _'], { stdio: 'inherit' });
      }
    }
  } finally {
    await fs.rm(draft, { force: true });
  }
}
