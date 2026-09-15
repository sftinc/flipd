// lib/cli/history.mjs
//
// Past attempts, newest first. Reads history.jsonl and state.json directly, like
// `log`, so it works with the service down. state.last is merged in when its id
// is not in the file: the attempt in progress, or one whose row was never
// written. "running" therefore means "recorded unfinished", not "the worker is
// busy with it" — `status` answers that.
import { readState } from '../state.mjs';
import { readHistory, compareIds } from '../log.mjs';
import { checkName } from '../paths.mjs';
import { shortSha } from '../git.mjs';

// One release can hold two roles at once: flip() sets `pending` and live/previous
// move only on confirmation. `pending` is shown because it needs a person.
const ROLES = ['pending', 'live', 'previous'];

export default async function (args, { paths: p, stdout, stderr }) {
  const usage = () => { stderr.write('usage: flipd history <name> [--limit N] [--json]\n'); return 2; };
  let name = null;
  let limit = 20;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--limit' && /^[1-9]\d*$/.test(args[i + 1] ?? '')) limit = Number(args[++i]);
    else if (!a.startsWith('-') && name === null) name = a;
    else return usage();
  }
  if (name === null) return usage();
  try { checkName(name); } catch (e) { stderr.write(`${e.message}\n`); return 1; }

  let rows, skipped;
  try {
    ({ rows, skipped } = await readHistory(p.repoLog(name)));
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
  if (skipped) stderr.write(`skipped ${skipped} unreadable line(s) in history.jsonl\n`);
  let state = null;
  try {
    state = await readState(p.repoDir(name));
  } catch (e) {
    stderr.write(`${e.message}; rows are shown without roles\n`);
  }

  const byId = new Map();
  for (const r of rows) byId.set(r.attempt, r);   // the last valid copy of an id wins
  const last = state?.last;
  if (last && typeof last.attempt === 'string' && !byId.has(last.attempt)) byId.set(last.attempt, last);
  if (byId.size === 0) { stderr.write(`no history for ${name} yet\n`); return 1; }

  const out = [...byId.values()]
    .sort((a, b) => compareIds(b.attempt, a.attempt))
    .slice(0, limit)
    .map((r) => ({
      ...r,
      role: (state && r.release && ROLES.find((k) => state[k] === r.release)) || null,
      duration_s: r.started && r.finished ? Math.round((Date.parse(r.finished) - Date.parse(r.started)) / 100) / 10 : null,
    }));

  if (json) {
    stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const table = [
    ['ATTEMPT', 'TRIGGER', 'SHA', 'OUTCOME', 'DURATION', 'RELEASE'],
    ...out.map((r) => [r.attempt, r.trigger ?? '-', r.sha ? shortSha(r.sha) : '-', r.outcome ?? 'running', r.duration_s === null ? '-' : `${r.duration_s.toFixed(1)}s`, r.role ?? '']),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  for (const row of table) stdout.write(`${row.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()}\n`);
  return 0;
}
