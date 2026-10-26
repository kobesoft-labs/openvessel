// Symbolic file modes (chmod u+x,go=r…; umask u=rwx,g=rx), shared by chmod and umask.

const WHO_BITS: Record<string, number> = { u: 0o4700, g: 0o2070, o: 0o1007 };

/**
 * Applies a symbolic mode (`[ugoa]*([-+=]([rwxXst]*|[ugo]))+`, clauses separated by commas) to
 * `mode`. With no `ugoa`, the bits set in `umask` are left alone (GNU chmod). `isDir` makes X
 * mean x. Returns null when the spec is invalid.
 */
export function applySymbolicMode(mode: number, spec: string, opts: { isDir?: boolean; umask?: number } = {}): number | null {
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=](?:[rwxXst]*|[ugo]))+)$/.exec(clause);
    if (!m) return null;
    let who = 0;
    for (const c of m[1] || 'a') who |= c === 'a' ? 0o7777 : WHO_BITS[c];
    // without u/g/o/a the bits set in the umask are not added or removed
    const limit = m[1] ? 0o7777 : ~(opts.umask ?? 0) & 0o7777;
    const ops = m[2].match(/[-+=][^-+=]*/g)!;
    for (const op of ops) {
      const kind = op[0];
      const perms = op.slice(1);
      let bits = 0;
      if (/^[ugo]$/.test(perms)) {
        // copy the permissions of another class: g=u
        const shift = perms === 'u' ? 6 : perms === 'g' ? 3 : 0;
        const rwx = (mode >> shift) & 7;
        bits = (rwx << 6) | (rwx << 3) | rwx;
      } else {
        for (const c of perms) {
          if (c === 'r') bits |= 0o444;
          else if (c === 'w') bits |= 0o222;
          else if (c === 'x') bits |= 0o111;
          else if (c === 'X') {
            if (opts.isDir || mode & 0o111) bits |= 0o111;
          } else if (c === 's') bits |= 0o6000;
          else if (c === 't') bits |= 0o1000;
        }
      }
      bits &= who;
      if (kind === '+') mode |= bits & limit;
      else if (kind === '-') mode &= ~(bits & limit);
      else {
        // `=` clears the class's bits (a directory keeps its setuid/setgid bits) and sets the given ones
        const clear = opts.isDir ? who & ~0o6000 : who;
        mode = (mode & ~clear) | (bits & limit);
      }
    }
  }
  return mode & 0o7777;
}

/** `u=rwx,g=rx,o=rx` for the permissions a umask leaves (umask -S). */
export function symbolicUmask(mask: number): string {
  const allowed = ~mask & 0o777;
  const part = (shift: number) => {
    const v = (allowed >> shift) & 7;
    return (v & 4 ? 'r' : '') + (v & 2 ? 'w' : '') + (v & 1 ? 'x' : '');
  };
  return `u=${part(6)},g=${part(3)},o=${part(0)}`;
}
