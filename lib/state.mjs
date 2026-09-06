import fs from 'node:fs/promises';
import path from 'node:path';

export function emptyState() {
  return { live: null, previous: null, pending: null, github_id: null, releases: {}, last: null };
}

// Thrown when state.json exists but cannot be read as state. Typed, so that
// every caller can make its own decision about a damaged file — and so that no
// caller has to decide by matching on a message. readState deliberately does
// *not* degrade to emptyState() here: an empty state has no `live`, no
// `previous` and no releases map, so the next prune would treat every release
// directory on the box as an unregistered orphan and delete it.
export class StateError extends Error {
  constructor(file, cause) {
    super(`${file}: ${cause.message}`);
    this.file = file;
    this.cause = cause;
    this.code = cause.code;
  }
}

export async function readState(dir) {
  const file = path.join(dir, 'state.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();   // never written yet: that is an empty state, not a damaged one
    throw new StateError(file, e);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new StateError(file, e);
  }
  // `null`, a number, a string or an array all spread into nothing, so without
  // this a state.json holding any of them would read as a pristine empty state —
  // the silent degradation this function exists to refuse.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateError(file, new Error('not a JSON object'));
  }
  return { ...emptyState(), ...parsed };
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
