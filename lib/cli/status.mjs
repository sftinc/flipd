import { loadRepos, loadMain } from '../config.mjs';
import { readState } from '../state.mjs';
import { sendCommand } from '../socket.mjs';
import { shortSha } from '../git.mjs';

// One object per repo, then rendered either as the table or as JSON, so the two
// can never disagree about what they saw.
export default async function (args, { paths: p, stdout, stderr }) {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) { stderr.write('usage: flipd status [name] [--json]\n'); return 2; }
  const only = rest[0];
  const { repos: loaded, errors } = await loadRepos(p);
  let main = null;
  try { main = await loadMain(p); } catch { /* status still works without it */ }
  let live = null;
  try { live = await sendCommand(p.sock, { cmd: 'status' }, { timeoutMs: 1500 }); } catch { /* service down */ }
  const up = Boolean(live?.ok);

  const repos = [];
  for (const repo of loaded) {
    if (only && repo.name !== only) continue;
    const r = {
      name: repo.name,
      branch: repo.branch,
      activity: up ? (live.running === repo.name ? 'running' : live.queued.includes(repo.name) ? 'queued' : 'idle') : null,
      live: null, previous: null, pending: null, last: null,
      warnings: [],
      error: null,
    };
    if (main?.publicHost && repo.hookHost && repo.hookHost !== main.publicHost) {
      r.warnings.push(`webhook still points at ${repo.hookHost}; this box is now ${main.publicHost}`);
    }
    let s;
    try {
      s = await readState(p.repoDir(repo.name));
    } catch (e) {
      // One repo's corrupt state.json must not take the whole table down —
      // status is the operator's only view, and it is needed most exactly
      // when state is damaged. Say so for this repo and move on to the rest.
      r.error = `state unreadable: ${e.message}`;
      repos.push(r);
      continue;
    }
    const rel = (id) => (id ? { release: id, sha: s.releases[id]?.sha ?? null } : null);
    r.live = rel(s.live);
    r.previous = rel(s.previous);
    r.pending = rel(s.pending);
    r.last = s.last;
    repos.push(r);
  }
  for (const { name, error } of errors) {
    if (only && name !== only) continue;
    repos.push({ name, branch: null, activity: null, live: null, previous: null, pending: null, last: null, warnings: [], error: error.message });
  }
  if (repos.length === 0) { stderr.write(only ? `no repo named ${only}\n` : 'no repos configured\n'); return 1; }

  if (json) {
    stdout.write(`${JSON.stringify({ service: up ? 'up' : 'down', repos }, null, 2)}\n`);
    return 0;
  }
  const rows = [];
  for (const r of repos) {
    if (r.branch === null) { rows.push([r.name, 'config error', r.error, '', '']); continue; }
    if (r.error) { rows.push([r.name, r.branch, '-', r.error, '']); continue; }
    const liveSha = r.live ? shortSha(r.live.sha ?? '-------') : '-';
    let outcome = 'never';
    if (r.last) outcome = `${r.last.outcome === 'deploy failed' ? 'DEPLOY FAILED' : r.last.outcome} ${r.last.finished ?? 'running'}`;
    rows.push([r.name, r.branch, liveSha, outcome, r.activity ?? 'service down']);
    if (r.pending) rows.push(['', '', '', `PENDING ${r.pending.release}`, `run: flipd rollback ${r.name}  or  flipd run ${r.name}`]);
    for (const w of r.warnings) rows.push(['', '', '', w, '']);
  }
  const widths = [0, 0, 0, 0];
  for (const r of rows) for (let i = 0; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
  for (const r of rows) stdout.write(r.map((c, i) => (i < 4 ? c.padEnd(widths[i]) : c)).join('   ').trimEnd() + '\n');
  return 0;
}
