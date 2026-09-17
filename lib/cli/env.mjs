import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseKV, ConfigError, loadRepo, editKV, writeAtomic } from '../config.mjs';
import { chownFlipd } from '../owner.mjs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export default async function (args, { paths: p, stdout, stderr }) {
  const [name, phase, ...rest] = args;
  if (!name || !['build', 'deploy'].includes(phase)) { stderr.write('usage: flipd env <name> build|deploy [--set K=V] [--unset K]\n'); return 2; }
  const sets = [];
  const unsets = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--set') sets.push(rest[++i]);
    else if (rest[i] === '--unset') unsets.push(rest[++i]);
    // No part of the stray token is ever echoed — not even a prefix cut at
    // "=", which still leaks a value when the token has no "=" in the key
    // position ("--set TOK abc123secret") or when its only "=" is base64
    // padding ("c2VjcmV0dmFsdWU="). Position is enough for an operator to
    // find the argument themselves.
    else { stderr.write(`unknown argument at position ${i + 1}; expected --set KEY=VALUE or --unset KEY\n`); return 2; }
  }
  for (const k of unsets) {
    if (typeof k !== 'string') { stderr.write('--unset requires a KEY argument\n'); return 1; }
  }
  // --unset K --set K=V in one call is ambiguous (which wins depends on argv
  // order only by accident of how this loop happens to apply them), not a
  // defect to silently resolve — say so and let the operator pick one.
  const setKeys = new Set(sets.map((s) => { const eq = s?.indexOf('=') ?? -1; return eq > 0 ? s.slice(0, eq) : null; }).filter(Boolean));
  for (const k of unsets) {
    if (setKeys.has(k)) { stderr.write(`--set and --unset both target ${k}; say which you mean\n`); return 2; }
  }
  // The file the run will actually read: the config may point elsewhere.
  const repo = await loadRepo(p, name);
  const file = phase === 'build' ? repo.buildEnvFile : repo.deployEnvFile;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.stat(file); } catch { await writeAtomic(file, ''); }
  await chownFlipd(file, { mode: 0o640, root: true });

  const label = `${name}.${phase}`;
  const report = (kv) => stdout.write(`${label}: ${[...kv.keys()].join(' ') || '(empty)'}\n`);

  if (sets.length || unsets.length) {
    const text = await fs.readFile(file, 'utf8');
    // Validate the file as it stands today before touching it: a line
    // already too broken for parseKV to read is the run's problem, not
    // something --set should silently paper over by rewriting past it.
    try { parseKV(text, null); } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // parseKV echoes the line number and nothing else — not the line, and not
      // the key either: a de-prefixed secret's leading fragment can itself be a
      // malformed key. So its message can be relayed as it is.
      stderr.write(`${file}: bad syntax on ${e.message}; fix it with: sudo flipd env ${name} ${phase}\n`);
      return 1;
    }

    // Rewritten line-oriented, not by rebuilding the file from a Map: this is
    // the only supported way an operator touches these files, and the format
    // supports comments and blank lines (the $EDITOR path invites them). A
    // round trip through a Map would silently discard every one of them.
    // --set replaces the existing line for that key in place, or appends a
    // new line if there is none; --unset drops the line(s) for that key;
    // every other line — comments, blanks, ordering — is left byte-identical.
    const changes = [];
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
      changes.push([k, raw]);
    }
    for (const k of unsets) changes.push([k, null]);
    const { text: assembled, trimmed: trimmedKeys, collapsed: collapsedKeys } = editKV(text, changes);
    let kv;
    try {
      kv = parseKV(assembled, null);
    } catch {
      // A bug above must never ship a file the service cannot read: verify
      // the exact bytes about to be written parse before writing them. The
      // parse error is still left out: this one is a flipd bug report,
      // and a line number from an assembled buffer the operator cannot see
      // would only send them looking at the wrong line of the real file.
      throw new Error(`internal error: the rewritten ${file} would not parse; nothing was written`);
    }
    await writeAtomic(file, assembled);
    if (trimmedKeys.length) stdout.write(`note: trimmed leading/trailing whitespace from: ${[...new Set(trimmedKeys)].join(' ')}\n`);
    if (collapsedKeys.length) stdout.write(`note: collapsed duplicate lines for: ${[...new Set(collapsedKeys)].join(' ')}\n`);
    report(kv);
    return 0;
  }

  // Edit a copy: the live file is replaced only by a version that parses, so a
  // build that starts mid-edit never reads a half-typed line.
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const draft = `${file}.edit`;
  await fs.copyFile(file, draft);
  await chownFlipd(draft, { mode: 0o640, root: true });
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
          stderr.write(`${draft}: bad syntax on ${e.message}; refusing to prompt for a retry without a terminal\n`);
          return 1;
        }
        stderr.write(`${draft}: bad syntax on ${e.message}. Press enter to edit again, or ctrl-c to discard the edit.\n`);
        spawnSync('sh', ['-c', 'read _'], { stdio: 'inherit' });
      }
    }
  } finally {
    await fs.rm(draft, { force: true });
  }
}
