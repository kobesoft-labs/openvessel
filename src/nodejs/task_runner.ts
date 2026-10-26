// `node --run <script>` (node_task_runner.cc): runs a package.json script with /bin/sh -c, in the
// package's directory, with every node_modules/.bin from the working directory up put in front of
// PATH. Node does this in C++ before it creates the environment; here it runs once lib is
// bootstrapped (child_process does the spawn) and before any main script.

import { sys } from '../node/sys.ts';
import * as loop from './loop.ts';
import { S, lib } from './state.ts';

const enc = new TextEncoder();
const err = (s: string) => {
  try {
    sys('write', { fd: 2, pos: null }, enc.encode(s));
  } catch {}
};

function readText(p: string): string {
  try {
    return new TextDecoder().decode(sys<Uint8Array>('readFile', { p }));
  } catch {
    return '';
  }
}

function isDirectory(p: string): boolean {
  try {
    return (sys<{ mode: number }>('stat', { p }).mode & 0o170000) === 0o040000;
  } catch {
    return false;
  }
}

const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const join = (dir: string, name: string) => (dir === '/' ? '/' : dir + '/') + name;

/**
 * FindPackageJson: the nearest package.json from the working directory up, and the
 * node_modules/.bin directories on the way (all of them, also above the package). The root
 * directory itself is not searched.
 */
function findPackageJson(cwd: string): { path: string; raw: string; pathPrefix: string } | null {
  let raw = '';
  let path = join(cwd, 'package.json');
  let pathPrefix = '';
  for (let dir = cwd; dir !== '/'; dir = parent(dir)) {
    const bin = join(dir, 'node_modules/.bin');
    if (isDirectory(bin)) pathPrefix += bin + ':';
    if (!raw) {
      path = join(dir, 'package.json');
      raw = readText(path);
    }
  }
  return raw ? { path, raw, pathPrefix } : null;
}

/** EscapeShell (POSIX): an argument quoted for sh, unless it has nothing to quote. */
export function escapeShell(input: string): string {
  if (input === '') return "''";
  if (!/[[\]\t\n\r "#$&'()*;<>%?\\`|~]/.test(input)) return input;
  return `'${input.replace(/'/g, "\\'")}'`.replace(/^(?:'')+(?!$)/, '').replace(/\\'''/g, "\\'");
}

/** RunTask: never returns; the process exits with 1 if the script failed, else 0. */
export function runTask(id: string, argv: string[]): void {
  const fail = (msg: string): never => {
    err(msg);
    return loop.reallyExit(1);
  };
  const cwd = S.cwd;
  const pkg = findPackageJson(cwd);
  if (!pkg) return fail(`Can't find package.json for directory ${cwd}\n`);
  let json: unknown;
  try {
    json = JSON.parse(pkg.raw);
  } catch {
    return fail(`Can't parse ${pkg.path}\n`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return fail(`Root value unexpected not an object for ${pkg.path}\n\n`);
  const scripts = (json as { scripts?: unknown }).scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return fail(`Can't find "scripts" field in ${pkg.path}\n`);
  const command = (scripts as Record<string, unknown>)[id];
  if (typeof command !== 'string') {
    if (Object.hasOwn(scripts, id)) return fail(`Script "${id}" is unexpectedly not a string for ${pkg.path}\n\n`);
    let list = '';
    for (const [k, v] of Object.entries(scripts)) if (typeof v === 'string') list += `  ${k}: ${v}\n`;
    return fail(`Missing script: "${id}" for ${pkg.path}\n\nAvailable scripts are:\n${list}`);
  }
  // GetPositionalArgs: what follows the first "--" of the command line
  const dashDash = argv.indexOf('--');
  const positional = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
  let commandStr = command;
  for (const a of positional) commandStr += ' ' + escapeShell(a);
  // the process's environment, PATH (any case) prefixed, and the two NODE_RUN_ variables
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(S.process.env as Record<string, string>)) env[k] = k.toLowerCase() === 'path' ? pkg.pathPrefix + v : v;
  env.NODE_RUN_SCRIPT_NAME = id;
  env.NODE_RUN_PACKAGE_JSON_PATH = pkg.path;
  // what child_process needs from pre-execution (no main script runs)
  lib('internal/util/debuglog').initializeDebugEnv(S.process.env.NODE_DEBUG);
  let child: any;
  try {
    child = lib('child_process').spawn('/bin/sh', ['-c', commandStr], { cwd: parent(pkg.path), env, stdio: 'inherit' });
  } catch (e) {
    err(`Error: ${(e as Error).message}\n`);
    loop.reallyExit(0);
  }
  // a failed spawn leaves the exit code alone (0), as uv_spawn's error does
  child.on('error', (e: Error & { code?: string }) => {
    err(`Error: ${uvMessage(e)}\n`);
    loop.reallyExit(0);
  });
  child.on('exit', (code: number | null) => loop.reallyExit(code !== null && code > 0 ? 1 : 0));
}

function uvMessage(e: Error & { code?: string }): string {
  try {
    const { getSystemErrorMessage } = lib('util');
    const n = lib('os').constants.errno[e.code ?? ''];
    if (n) return getSystemErrorMessage(-n);
  } catch {}
  return e.message;
}
