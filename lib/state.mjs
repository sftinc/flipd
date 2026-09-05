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

export async function writeState(dir, state) {
  const file = path.join(dir, 'state.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}
