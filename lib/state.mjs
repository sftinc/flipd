import fs from 'node:fs/promises';
import path from 'node:path';

export function emptyState() {
  return { live: null, previous: null, pending: null, github_id: null, releases: {}, last: null };
}

export async function readState(dir) {
  try {
    const text = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    return { ...emptyState(), ...JSON.parse(text) };
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
}

let seq = 0;

// The temporary name is unique per process and per call. A fixed `state.json.tmp`
// is a file two writers share: the second one's writeFile truncates it under the
// first, and the first's rename then finds it gone (ENOENT) or renames a
// half-written file over the real one. Production has one writer today — one
// serve process, reconcile awaited before the queue starts, one worker slot —
// but nothing enforces that beyond the hook port's EADDRINUSE, and the test
// suite reproduced the race deterministically (200 ENOENTs in 400 concurrent
// writes). A failed write removes its own tmp file rather than leaving it for
// the next reader to wonder about; readState only ever opens `state.json`, so a
// leftover is inert either way.
export async function writeState(dir, state) {
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
