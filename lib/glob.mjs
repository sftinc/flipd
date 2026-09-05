// `*` any run except `/`; `**` any run including `/`; `**/` zero or more directories;
// `?` one char except `/`; everything else literal. Matches the whole path.
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function anyMatches(files, watch, ignore) {
  const w = watch.map(globToRegExp);
  const ig = ignore.map(globToRegExp);
  return files.some((f) => (w.length === 0 || w.some((r) => r.test(f))) && !ig.some((r) => r.test(f)));
}
