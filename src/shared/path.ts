// Node.js `path`: the implementation is vendored from Node (node-path.ts); this module exposes
// the POSIX flavour as named exports, which is what the kernel and the Node layer use.

import { posix, win32 } from './node-path.ts';

export { setCwdProvider, globToRegExp } from './node-path-support.ts';

export const sep = '/';
export const delimiter = ':';
export const resolve: (...paths: string[]) => string = posix.resolve;
export const normalize: (p: string) => string = posix.normalize;
export const isAbsolute: (p: string) => boolean = posix.isAbsolute;
export const join: (...paths: string[]) => string = posix.join;
export const relative: (from: string, to: string) => string = posix.relative;
export const toNamespacedPath: (p: string) => string = posix.toNamespacedPath;
export const dirname: (p: string) => string = posix.dirname;
export const basename: (p: string, suffix?: string) => string = posix.basename;
export const extname: (p: string) => string = posix.extname;
export const format: (o: Partial<ParsedPath>) => string = posix.format;
export const parse: (p: string) => ParsedPath = posix.parse;
export const matchesGlob: (p: string, pattern: string) => boolean = posix.matchesGlob;

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export { win32 };
export default posix as any as typeof posix;
