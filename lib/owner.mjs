import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
// undefined: not yet looked up. null: looked up, no such user (cached — a
// missing remote-deploy user does not get re-probed, and re-warned about, on
// every single chownRemoteDeploy call in one command). {uid,gid}: found.
let ids;

async function remoteDeployIds() {
  if (ids !== undefined) return ids;
  try {
    const uid = Number((await run('id', ['-u', 'remote-deploy'])).stdout.trim());
    const gid = Number((await run('id', ['-g', 'remote-deploy'])).stdout.trim());
    ids = { uid, gid };
  } catch {
    ids = null;
  }
  return ids;
}

// chown only when root; chmod always. root:true means owner root, group remote-deploy.
export async function chownRemoteDeploy(file, { mode, root = false } = {}) {
  if (typeof mode === 'number') await fs.chmod(file, mode);
  if (process.getuid?.() !== 0) return;
  const d = await remoteDeployIds();
  if (!d) { process.stderr.write(`warning: no remote-deploy user; leaving ${file} owned by root\n`); return; }
  await fs.chown(file, root ? 0 : d.uid, d.gid);
}
