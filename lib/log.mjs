import fs from 'node:fs/promises';
import path from 'node:path';

const LINE_MAX = 4096;

export function attemptIdFor(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

// Log names sort chronologically as strings except that a "-2" suffix sorts
// before the unsuffixed id of the same second. Order by (second, suffix).
function idKey(name) {
  const id = name.replace(/\.log$/, '');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?$/.exec(id);
  return m ? [m[1], Number(m[2] ?? 1)] : [id, 0];
}
export function compareIds(a, b) {
  const [sa, na] = idKey(a);
  const [sb, nb] = idKey(b);
  return sa < sb ? -1 : sa > sb ? 1 : na - nb;
}

export async function openAttemptLog(logDir, { now = () => new Date(), maxBytes = 52428800, mask = [] } = {}) {
  await fs.mkdir(logDir, { recursive: true });
  const base = attemptIdFor(now());
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const file = path.join(logDir, `${id}.log`);
    let fh;
    try {
      fh = await fs.open(file, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    return makeLog(id, file, fh, maxBytes, mask);
  }
}

const MASK_MIN = 8;

// Longest first, so a value that contains another is replaced whole.
export function makeScrubber(mask) {
  const secrets = [...new Set(mask.filter((v) => typeof v === 'string' && v.length >= MASK_MIN))].sort((a, b) => b.length - a.length);
  const scrub = (text) => secrets.reduce((t, v) => t.split(v).join('***'), text);
  scrub.longest = secrets[0]?.length ?? 0;
  return scrub;
}

function makeLog(id, file, fh, maxBytes, mask) {
  let bytes = 0;
  let truncated = false;
  let chain = Promise.resolve();
  const scrub = makeScrubber(mask);
  // Output arrives in chunks; a secret can straddle two. Hold back a tail at
  // least as long as the longest secret so the join is scanned when the next
  // chunk arrives.
  const CARRY = Math.max(256, scrub.longest);
  let held = '';
  const scrubStream = (chunk, final) => {
    const text = scrub(held + chunk);
    if (final) { held = ''; return text; }
    const keep = Math.min(CARRY, text.length);
    held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  };
  const write = (s) => (chain = chain.then(() => (s ? fh.write(s) : undefined)).then(() => undefined));
  return {
    id,
    file,
    line(text) {
      // remote-deploy's own lines are never dropped, but no single line may carry an
      // unbounded payload (git stderr inside an error message, say). Scrub the
      // full text before cutting it, so a secret straddling the cut boundary is
      // masked whole rather than truncated into an unmatched, unmasked fragment.
      // Never force-finalize the output stream's carry buffer here: it may hold
      // the first half of a secret whose remainder is still to arrive via a
      // later output() call, so it stays buffered until output() or close()
      // flushes it - meaning buffered command output can land in the file after
      // an interleaved line rather than before it, which is fine.
      const scrubbed = scrub(text);
      const t = Buffer.byteLength(scrubbed) > LINE_MAX
        ? `${Buffer.from(scrubbed).subarray(0, LINE_MAX).toString()} [line cut at ${LINE_MAX} bytes]`
        : scrubbed;
      return write(`${new Date().toISOString()}  ${t}\n`);
    },
    output(chunk) {
      if (truncated) return chain;
      const len = Buffer.byteLength(chunk);
      if (bytes + len > maxBytes) {
        truncated = true;
        return write(`${scrubStream('', true)}\n[output truncated at ${maxBytes} bytes]\n`);
      }
      bytes += len;
      return write(scrubStream(chunk, false));
    },
    async close() {
      if (held) write(scrubStream('', true));
      await chain;
      await fh.close();
    },
  };
}

export async function appendEvent(logDir, event, details = '') {
  await fs.mkdir(logDir, { recursive: true });
  const line = details ? `${new Date().toISOString()} ${event} ${details}\n` : `${new Date().toISOString()} ${event}\n`;
  await fs.appendFile(path.join(logDir, 'events.log'), line);
}

async function attemptLogs(logDir) {
  let names = [];
  try {
    names = await fs.readdir(logDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return names.filter((n) => n.endsWith('.log') && n !== 'events.log').sort(compareIds);
}

export async function pruneLogs(logDir, keep) {
  if (keep === 0) return [];
  const names = await attemptLogs(logDir);
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) await fs.rm(path.join(logDir, n), { force: true });
  return doomed;
}

export async function latestLog(logDir) {
  const names = await attemptLogs(logDir);
  return names.length ? path.join(logDir, names[names.length - 1]) : null;
}
