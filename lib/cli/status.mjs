import { loadRepos, loadMain } from '../config.mjs';
import { readState } from '../state.mjs';
import { sendCommand } from '../socket.mjs';
import { shortSha } from '../git.mjs';

export default async function (args, { paths: p, stdout, stderr }) {
  const only = args[0];
  const { repos, errors } = await loadRepos(p);
  let main = null;
  try { main = await loadMain(p); } catch { /* status still works without it */ }
  let live = null;
  try { live = await sendCommand(p.sock, { cmd: 'status' }, { timeoutMs: 1500 }); } catch { /* service down */ }

  const rows = [];
  for (const repo of repos) {
    if (only && repo.name !== only) continue;
    let s;
    try {
      s = await readState(p.repoDir(repo.name));
    } catch (e) {
      // One repo's corrupt state.json must not take the whole table down —
      // status is the operator's only view, and it is needed most exactly
      // when state is damaged. Say so for this repo and move on to the rest.
      rows.push([repo.name, repo.branch, '-', `state unreadable: ${e.message}`, '']);
      continue;
    }
    const liveSha = s.live ? shortSha(s.releases[s.live]?.sha ?? '-------') : '-';
    let outcome = 'never';
    if (s.last) outcome = `${s.last.outcome === 'deploy failed' ? 'DEPLOY FAILED' : s.last.outcome} ${s.last.finished ?? 'running'}`;
    let activity = 'service down';
    if (live?.ok) activity = live.running === repo.name ? 'running' : live.queued.includes(repo.name) ? 'queued' : 'idle';
    rows.push([repo.name, repo.branch, liveSha, outcome, activity]);
    if (s.pending) rows.push(['', '', '', `PENDING ${s.pending}`, `run: flipd rollback ${repo.name}  or  flipd run ${repo.name}`]);
    if (main?.publicHost && repo.hookHost && repo.hookHost !== main.publicHost) {
      rows.push(['', '', '', `webhook still points at ${repo.hookHost}; this box is now ${main.publicHost}`, '']);
    }
  }
  for (const { name, error } of errors) {
    if (only && name !== only) continue;
    rows.push([name, 'config error', error.message, '', '']);
  }
  if (rows.length === 0) { stderr.write(only ? `no repo named ${only}\n` : 'no repos configured\n'); return 1; }

  const widths = [0, 0, 0, 0];
  for (const r of rows) for (let i = 0; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
  for (const r of rows) stdout.write(r.map((c, i) => (i < 4 ? c.padEnd(widths[i]) : c)).join('   ').trimEnd() + '\n');
  return 0;
}
