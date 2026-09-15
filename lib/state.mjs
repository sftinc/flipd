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
  const state = { ...emptyState(), ...parsed };
  const bad = shapeError(state);
  if (bad) throw new StateError(file, new Error(bad));
  return state;
}

// Parsing is not enough. Every field below is dereferenced as a map or compared
// as an id, and two wrong shapes delete a release rather than merely throwing:
// a numeric `live` is missed by prune's Set.has (release names are strings), and
// a null entry in `releases` reads to reconcile() as an unregistered directory.
// `github_id` and `last` are records, not inputs to a decision, and are left alone.
function shapeError(state) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(state.releases)) return 'releases is not an object';
  if (!Object.values(state.releases).every(isObject)) return 'an entry in releases is not an object';
  for (const k of ['live', 'previous', 'pending']) {
    if (state[k] !== null && typeof state[k] !== 'string') return `${k} is neither a release id nor null`;
  }
  return null;
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

export const pausedMsg = (name, since) => `paused since ${since ?? '(unknown)'}; run flipd resume ${name}`;

const UNREADABLE_MARKER = Object.freeze({ since: null, reason: '(marker unreadable)' });

// Fails closed: anything but a marker exactly as writePaused writes it reads as
// paused. Parsing alone is not enough — `null` and `false` parse, and a falsy
// result would silently unpause. `since` must be what toISOString produces and
// `reason` printable ASCII (cleanForLog's output), because both are printed by
// status and written to logs, and this file is only ever meant to come from us.
export async function readPaused(dir) {
  let text;
  try {
    text = await fs.readFile(path.join(dir, 'paused'), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : UNREADABLE_MARKER;
  }
  try {
    const m = JSON.parse(text);
    const isObject = m !== null && typeof m === 'object' && !Array.isArray(m);
    if (isObject && typeof m.since === 'string' && typeof m.reason === 'string'
      && !Number.isNaN(Date.parse(m.since)) && new Date(m.since).toISOString() === m.since
      && /^[\x20-\x7e]*$/.test(m.reason)) {
      return { since: m.since, reason: m.reason };
    }
  } catch { /* not JSON */ }
  return UNREADABLE_MARKER;
}

export async function writePaused(dir, marker) {
  const file = path.join(dir, 'paused');
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(marker)}\n`);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function clearPaused(dir) {
  try {
    await fs.rm(path.join(dir, 'paused'));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
