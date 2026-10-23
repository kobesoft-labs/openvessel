// npm / npx / pnpm / yarn / bun commands (one implementation, several front ends).

import { NODE_VERSION } from '../../node/version.ts';
import * as path from '../../shared/path.ts';
import type { Kernel, ProgramContext } from '../kernel.ts';
import { exitCodeOf } from '../proc.ts';
import { Installer, isDirectory, readJsonFile } from './install.ts';
import { readLockHints } from './lockfile.ts';
import { type FetchFn, Registry } from './registry.ts';
import * as semver from './semver.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
export const NPM_VERSION = '10.9.3';
const PM_VERSIONS: Record<string, string> = { npm: NPM_VERSION, pnpm: '9.15.9', yarn: '1.22.22', bun: '1.2.21' };

let fetchFn: FetchFn | null = null;
let sharedRegistry: Registry | null = null;
export function setNpmFetch(f: FetchFn) {
  fetchFn = f;
  sharedRegistry = null;
}
export function getNetFetch(): FetchFn {
  if (!fetchFn) throw new Error('network is not configured');
  return fetchFn;
}

function readNpmrc(ctx: ProgramContext, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const files = [path.join(ctx.env.HOME ?? '/home/user', '.npmrc')];
  let d = dir;
  const chain: string[] = [];
  for (;;) {
    chain.push(path.join(d, '.npmrc'));
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  files.push(...chain.reverse());
  for (const f of files) {
    try {
      for (const line of dec.decode(ctx.vfs.readFile(f)).split('\n')) {
        const m = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_x, k) => ctx.env[k] ?? '');
      }
    } catch {}
  }
  for (const [k, v] of Object.entries(ctx.env)) {
    const m = /^npm_config_(.+)$/i.exec(k);
    if (m) out[m[1].toLowerCase().replace(/_/g, '-')] = v;
  }
  return out;
}

function getRegistry(ctx: ProgramContext, dir: string): Registry {
  const rc = readNpmrc(ctx, dir);
  const url = rc.registry ?? 'https://registry.npmjs.org/';
  const scopes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rc)) if (/^@[^:]+:registry$/.test(k)) scopes[k.split(':')[0]] = v;
  if (!fetchFn) throw new Error('npm: network is not configured');
  if (!sharedRegistry || sharedRegistry.registryUrl !== (url.endsWith('/') ? url : url + '/') || JSON.stringify(sharedRegistry.scopes) !== JSON.stringify(scopes)) {
    sharedRegistry = new Registry(fetchFn, url, scopes);
  }
  return sharedRegistry;
}

/** Finds the nearest directory containing package.json. */
function findProjectRoot(ctx: ProgramContext, from: string): string | null {
  let d = from;
  for (;;) {
    if (ctx.vfs.exists(path.join(d, 'package.json'))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

function writeJson(ctx: ProgramContext, p: string, data: unknown) {
  ctx.vfs.writeFile(p, JSON.stringify(data, null, 2) + '\n');
}

function fmtTime(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`;
}

interface Flags {
  dev: boolean;
  exact: boolean;
  global: boolean;
  omitDev: boolean;
  omitOptional: boolean;
  ignoreScripts: boolean;
  yes: boolean;
  silent: boolean;
  legacyPeerDeps: boolean;
  workspace?: string;
  prefix?: string;
  rest: string[];
  passthrough: string[];
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { dev: false, exact: false, global: false, omitDev: false, omitOptional: false, ignoreScripts: false, yes: false, silent: false, legacyPeerDeps: false, rest: [], passthrough: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      f.passthrough = args.slice(i + 1);
      break;
    }
    switch (a) {
      case '-D':
      case '--save-dev':
      case '--dev':
      case '-d':
        f.dev = true;
        break;
      case '-E':
      case '--save-exact':
      case '--exact':
        f.exact = true;
        break;
      case '-g':
      case '--global':
        f.global = true;
        break;
      case '--production':
      case '--prod':
      case '-P':
      case '--omit=dev':
        f.omitDev = true;
        break;
      case '--omit=optional':
      case '--no-optional':
        f.omitOptional = true;
        break;
      case '--ignore-scripts':
        f.ignoreScripts = true;
        break;
      case '-y':
      case '--yes':
        f.yes = true;
        break;
      case '-s':
      case '--silent':
      case '--loglevel=silent':
      case '--reporter=silent':
        f.silent = true;
        break;
      case '--legacy-peer-deps':
      case '--force':
        f.legacyPeerDeps = true;
        break;
      case '-w':
      case '--workspace':
      case '--filter':
      case '-F':
        f.workspace = args[++i];
        break;
      case '--prefix':
      case '-C':
      case '--dir':
      case '--cwd':
        f.prefix = args[++i];
        break;
      default:
        if (a.startsWith('--prefix=') || a.startsWith('--dir=') || a.startsWith('--cwd=')) f.prefix = a.slice(a.indexOf('=') + 1);
        else if (a.startsWith('--workspace=') || a.startsWith('--filter=')) f.workspace = a.slice(a.indexOf('=') + 1);
        else if (a.startsWith('-') && a !== '-') {
          // ignore unknown flags (--no-fund, --no-audit, --frozen-lockfile, --save, ...)
        } else f.rest.push(a);
    }
  }
  return f;
}

class Npm {
  constructor(public ctx: ProgramContext, public pm: 'npm' | 'pnpm' | 'yarn' | 'bun') {}

  out(s: string) {
    this.ctx.out(s);
  }
  err(s: string) {
    this.ctx.err(s);
  }

  userAgent() {
    return `${this.pm}/${PM_VERSIONS[this.pm]} npm/? node/v${NODE_VERSION} linux x64 workspaces/false`;
  }

  async install(dir: string, f: Flags, opts: { noLock?: boolean } = {}): Promise<number> {
    const ctx = this.ctx;
    const t0 = performance.now();
    const rootPkg = readJsonFile(ctx.vfs, path.join(dir, 'package.json'));
    if (!rootPkg) {
      this.err(`npm error code ENOENT\nnpm error Could not read package.json: ${dir}/package.json\n`);
      return 254;
    }
    const lock = opts.noLock ? { versions: new Map(), source: null } : readLockHints((n) => {
      try {
        return dec.decode(ctx.vfs.readFile(path.join(dir, n)));
      } catch {
        return null;
      }
    });
    if (!f.ignoreScripts) {
      const c = await this.runLifecycle(dir, rootPkg, 'preinstall');
      if (c) return c;
    }
    const isTty = ctx.isatty(2);
    let lastLen = 0;
    const progress = (s: string) => {
      if (!isTty || f.silent) return;
      const line = `\r\x1b[K${s}`;
      lastLen = s.length;
      ctx.err(line);
    };
    const inst = new Installer({
      root: dir,
      vfs: ctx.vfs,
      registry: getRegistry(ctx, dir),
      lock,
      omitDev: f.omitDev || ctx.env.NODE_ENV === 'production' && false,
      omitOptional: f.omitOptional,
      omitPeer: f.legacyPeerDeps || readNpmrc(ctx, dir)['legacy-peer-deps'] === 'true',
      log: (s) => !f.silent && this.out(s + '\n'),
      warn: (s) => {
        if (f.silent) return;
        if (isTty && lastLen) ctx.err('\r\x1b[K');
        lastLen = 0;
        this.err(s + '\n');
      },
      progress,
    });
    let res;
    try {
      res = await inst.run();
    } catch (e: any) {
      if (isTty && lastLen) ctx.err('\r\x1b[K');
      const code = e?.code ?? 'EUNKNOWN';
      this.err(`npm error code ${code}\nnpm error ${e?.message ?? e}\n`);
      if (code === 'EACCES') this.err('npm error network access was denied by the OpenVessel network policy\n');
      return 1;
    }
    if (isTty && lastLen) ctx.err('\r\x1b[K');
    if (!f.ignoreScripts) {
      for (const s of ['install', 'postinstall', 'preprepare', 'prepare', 'postprepare']) {
        const c = await this.runLifecycle(dir, rootPkg, s);
        if (c) return c;
      }
    }
    if (!f.silent) {
      if (this.pm === 'pnpm') this.out(`Packages: +${res.added}\nDone in ${fmtTime(performance.now() - t0)}\n`);
      else if (this.pm === 'yarn') this.out(`success Saved lockfile.\nDone in ${fmtTime(performance.now() - t0)}.\n`);
      else this.out(`\n${res.added ? `added ${res.added} package${res.added === 1 ? '' : 's'}` : 'up to date'}${res.added && res.total !== res.added ? `, and audited ${res.total + 1} packages` : ''} in ${fmtTime(performance.now() - t0)}\n`);
    }
    return 0;
  }

  private async runLifecycle(dir: string, pkg: any, event: string): Promise<number> {
    const script = pkg.scripts?.[event];
    if (!script) return 0;
    return this.runScript(dir, pkg, event, [], { quiet: false });
  }

  scriptEnv(dir: string, pkg: any, event: string, script: string): Record<string, string> {
    const env: Record<string, string> = { ...this.ctx.env };
    const bins: string[] = [];
    let d = dir;
    for (;;) {
      bins.push(path.join(d, 'node_modules/.bin'));
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
    env.PATH = [...bins, env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(':');
    env.npm_lifecycle_event = event;
    env.npm_lifecycle_script = script;
    env.npm_package_name = pkg.name ?? '';
    env.npm_package_version = pkg.version ?? '';
    env.npm_package_json = path.join(dir, 'package.json');
    // npx inside another manager's script keeps that manager's user agent (only-allow relies on it)
    if (event !== 'npx' || !env.npm_config_user_agent) env.npm_config_user_agent = this.userAgent();
    env.npm_execpath = `/usr/lib/node_modules/${this.pm}/bin/${this.pm}-cli.js`;
    env.npm_node_execpath = '/usr/bin/node';
    env.npm_command = event === 'test' || event === 'start' ? event : 'run-script';
    env.INIT_CWD = this.ctx.cwd;
    env.NODE = '/usr/bin/node';
    env.COLOR = this.ctx.isatty(1) ? '1' : '0';
    return env;
  }

  async runScript(dir: string, pkg: any, name: string, args: string[], o: { quiet: boolean }): Promise<number> {
    const script = pkg.scripts?.[name];
    if (script === undefined) return 0;
    const quoted = args.map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
    const full = quoted ? `${script} ${quoted}` : script;
    if (!o.quiet) {
      if (this.pm === 'yarn') this.out(`$ ${full}\n`);
      else this.out(`\n> ${pkg.name ?? ''}${pkg.version ? '@' + pkg.version : ''} ${name}\n> ${full}\n\n`);
    }
    const code = await this.ctx.run(['/bin/sh', '-c', full], { env: this.scriptEnv(dir, pkg, name, full), cwd: dir });
    return code;
  }

  async run(dir: string, name: string | undefined, args: string[], f: Flags): Promise<number> {
    const pkg = readJsonFile(this.ctx.vfs, path.join(dir, 'package.json'));
    if (!pkg) {
      this.err(`npm error code ENOENT\nnpm error Could not read package.json in ${dir}\n`);
      return 254;
    }
    if (!name) {
      const scripts = Object.entries<string>(pkg.scripts ?? {});
      this.out(`Scripts available in ${pkg.name ?? dir} via \`npm run-script\`:\n`);
      for (const [k, v] of scripts) this.out(`  ${k}\n    ${v}\n`);
      return 0;
    }
    if (pkg.scripts?.[name] === undefined) {
      if (name === 'start' && this.ctx.vfs.exists(path.join(dir, 'server.js'))) {
        return this.ctx.run(['node', 'server.js', ...args], { cwd: dir });
      }
      this.err(`npm error Missing script: "${name}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n`);
      return 1;
    }
    for (const stage of [`pre${name}`, name, `post${name}`]) {
      if (pkg.scripts?.[stage] === undefined) continue;
      const code = await this.runScript(dir, pkg, stage, stage === name ? args : [], { quiet: f.silent });
      if (code) {
        if (!f.silent && this.pm === 'npm') this.err(`npm error Lifecycle script \`${stage}\` failed with error:\nnpm error code ${code}\nnpm error path ${dir}\nnpm error command failed\nnpm error command sh -c ${pkg.scripts[stage]}\n`);
        return code;
      }
    }
    return 0;
  }

  /** Adds packages to package.json and installs. */
  async add(dir: string, specs: string[], f: Flags): Promise<number> {
    const ctx = this.ctx;
    const pjPath = path.join(dir, 'package.json');
    let pkg = readJsonFile(ctx.vfs, pjPath);
    if (!pkg) {
      pkg = { name: path.basename(dir), version: '1.0.0' };
    }
    const reg = getRegistry(ctx, dir);
    const field = f.dev ? 'devDependencies' : 'dependencies';
    for (const spec of specs) {
      const { name, range } = splitSpec(spec);
      let saveRange = range;
      if (!range || !/^(file:|link:|workspace:|https?:|git|github:|npm:)/.test(range)) {
        try {
          const p = await reg.packument(name);
          const v = !range ? p['dist-tags'].latest : semver.validRange(range) ? semver.maxSatisfying(Object.keys(p.versions), range) : p['dist-tags'][range];
          if (!v) {
            this.err(`npm error code ETARGET\nnpm error notarget No matching version found for ${spec}.\n`);
            return 1;
          }
          saveRange = f.exact ? v : !range || !semver.validRange(range) || range === v ? `^${v}` : range;
        } catch (e: any) {
          this.err(`npm error code ${e?.code ?? 'E404'}\nnpm error ${e?.message ?? e}\n`);
          return 1;
        }
      }
      pkg[field] = { ...(pkg[field] ?? {}), [name]: saveRange };
      if (field === 'devDependencies' && pkg.dependencies?.[name]) delete pkg.dependencies[name];
      if (field === 'dependencies' && pkg.devDependencies?.[name]) delete pkg.devDependencies[name];
      pkg[field] = Object.fromEntries(Object.entries(pkg[field]).sort(([a], [b]) => a.localeCompare(b)));
    }
    writeJson(ctx, pjPath, pkg);
    return this.install(dir, f);
  }

  async remove(dir: string, names: string[], f: Flags): Promise<number> {
    const pjPath = path.join(dir, 'package.json');
    const pkg = readJsonFile(this.ctx.vfs, pjPath);
    if (!pkg) return 1;
    for (const n of names) {
      for (const fld of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (pkg[fld]) delete pkg[fld][n];
    }
    writeJson(this.ctx, pjPath, pkg);
    return this.install(dir, f);
  }

  /** npx / npm exec / pnpm dlx / yarn dlx / bunx */
  async exec(dir: string, args: string[], f: Flags, opts: { forceInstall?: boolean; packages?: string[] } = {}): Promise<number> {
    if (!args.length) {
      this.err('npm error npx requires a command\n');
      return 1;
    }
    const [first, ...rest] = args;
    const { name, range } = splitSpec(first);
    const binName = (opts.packages?.length ? first : name.replace(/^@[^/]+\//, '')).replace(/^create-/, 'create-');
    // local bin?
    if (!opts.forceInstall && !range && !opts.packages?.length) {
      let d = dir;
      for (;;) {
        const b = path.join(d, 'node_modules/.bin', first);
        if (this.ctx.vfs.tryLookup(b)) return this.ctx.run([b, ...rest], { env: this.scriptEnv(dir, readJsonFile(this.ctx.vfs, path.join(dir, 'package.json')) ?? {}, 'npx', args.join(' ')) });
        const p = path.dirname(d);
        if (p === d) break;
        d = p;
      }
      const g = this.ctx.kernel.which(first, this.ctx.env, this.ctx.cwd);
      if (g && !g.startsWith('/bin/') && !first.startsWith('create-')) return this.ctx.run([g, ...rest]);
    }
    // install into a cache dir
    const pkgs = opts.packages?.length ? opts.packages : [first];
    const key = pkgs.join(' ').replace(/[^\w@.-]+/g, '_').slice(0, 100);
    const home = this.ctx.env.HOME ?? '/home/user';
    const cacheDir = path.join(home, '.npm/_npx', key);
    const vfs = this.ctx.vfs;
    if (!vfs.exists(path.join(cacheDir, 'node_modules/.package-lock.json')) || opts.forceInstall) {
      vfs.mkdir(cacheDir, 0o755, true);
      const deps: Record<string, string> = {};
      for (const p of pkgs) {
        const s = splitSpec(p);
        deps[s.name] = s.range || 'latest';
      }
      writeJson(this.ctx, path.join(cacheDir, 'package.json'), { name: 'npx-cache', private: true, dependencies: deps });
      if (!f.silent && !f.yes && this.pm === 'npm') this.err(`Need to install the following packages:\n${pkgs.join('\n')}\n`);
      const code = await this.install(cacheDir, { ...f, silent: true, ignoreScripts: true });
      if (code) return code;
    }
    // find the bin
    const pj = readJsonFile(vfs, path.join(cacheDir, 'node_modules', name, 'package.json'));
    let bin: string | undefined;
    const bins = typeof pj?.bin === 'string' ? { [name.replace(/^@[^/]+\//, '')]: pj.bin } : (pj?.bin ?? {});
    if (opts.packages?.length) bin = path.join(cacheDir, 'node_modules/.bin', first);
    else if (bins[binName]) bin = path.join(cacheDir, 'node_modules/.bin', binName);
    else if (Object.keys(bins).length === 1) bin = path.join(cacheDir, 'node_modules/.bin', Object.keys(bins)[0]);
    else bin = path.join(cacheDir, 'node_modules/.bin', binName);
    if (!vfs.tryLookup(bin)) {
      this.err(`npm error could not determine executable to run for ${first}\n`);
      return 1;
    }
    const env = this.scriptEnv(dir, readJsonFile(vfs, path.join(dir, 'package.json')) ?? {}, 'npx', args.join(' '));
    env.PATH = `${path.join(cacheDir, 'node_modules/.bin')}:${env.PATH}`;
    return this.ctx.run([bin, ...(opts.packages?.length ? rest : rest)], { env, cwd: dir });
  }

  async view(dir: string, args: string[]): Promise<number> {
    const [spec, ...fields] = args;
    if (!spec) return 1;
    const { name, range } = splitSpec(spec);
    try {
      const p = await getRegistry(this.ctx, dir).packument(name);
      const v = !range ? p['dist-tags'].latest : semver.validRange(range) ? semver.maxSatisfying(Object.keys(p.versions), range) : p['dist-tags'][range];
      const m: any = v ? p.versions[v] : null;
      if (!m) return 1;
      if (fields.length) {
        for (const fld of fields) {
          const val = fld === 'versions' ? Object.keys(p.versions) : fld === 'dist-tags' ? p['dist-tags'] : fld.split('.').reduce((o: any, k) => o?.[k], m);
          this.out((typeof val === 'string' ? val : JSON.stringify(val, null, 2)) + '\n');
        }
      } else {
        this.out(`\n${m.name}@${m.version} | ${m.license ?? 'Proprietary'} | deps: ${Object.keys(m.dependencies ?? {}).length}\n${m.description ?? ''}\n\ndist-tags:\n${Object.entries(p['dist-tags']).map(([k, x]) => `${k}: ${x}`).join('  ')}\n`);
      }
      return 0;
    } catch (e: any) {
      this.err(`npm error code ${e?.code ?? 'E404'}\nnpm error ${e?.message}\n`);
      return 1;
    }
  }

  ls(dir: string): number {
    const pkg = readJsonFile(this.ctx.vfs, path.join(dir, 'package.json')) ?? {};
    const lock = readJsonFile(this.ctx.vfs, path.join(dir, 'node_modules/.package-lock.json'));
    this.out(`${pkg.name ?? ''}@${pkg.version ?? ''} ${dir}\n`);
    const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).sort();
    direct.forEach((n, i) => {
      const v = lock?.packages?.[`node_modules/${n}`]?.version;
      this.out(`${i === direct.length - 1 ? '└──' : '├──'} ${n}@${v ?? 'UNMET DEPENDENCY'}\n`);
    });
    return 0;
  }

  init(dir: string, f: Flags): number {
    const pj = path.join(dir, 'package.json');
    if (this.ctx.vfs.exists(pj) && !f.yes) {
      this.out(`package.json already exists in ${dir}\n`);
      return 0;
    }
    const pkg = { name: path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, '-'), version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };
    writeJson(this.ctx, pj, pkg);
    this.out(`Wrote to ${pj}:\n\n${JSON.stringify(pkg, null, 2)}\n\n`);
    return 0;
  }
}

function splitSpec(spec: string): { name: string; range: string } {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    return at === -1 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
  }
  const at = spec.indexOf('@');
  return at === -1 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

async function main(ctx: ProgramContext, pm: 'npm' | 'pnpm' | 'yarn' | 'bun', argv: string[]): Promise<number> {
  const npm = new Npm(ctx, pm);
  const f = parseFlags(argv);
  let [cmd, ...rest] = f.rest;
  const baseDir = f.prefix ? ctx.resolve(f.prefix) : ctx.cwd;
  if (argv.includes('-v') || argv.includes('--version')) {
    if (!cmd) {
      ctx.out(PM_VERSIONS[pm] + '\n');
      return 0;
    }
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    ctx.out(`Usage: ${pm} <command>\n\nCommands: install, ci, add, remove, run, exec, test, start, init, view, ls, create\n(OpenVessel ${pm}-compatible front end)\n`);
    return 0;
  }
  const projectDir = () => findProjectRoot(ctx, baseDir) ?? baseDir;
  const globalDir = '/usr/local/lib/node_modules/.ov-global';

  if (!cmd) {
    if (pm === 'yarn' || pm === 'pnpm' || pm === 'bun') return npm.install(projectDir(), f);
    ctx.out(`npm <command>\n\nUsage:\n\nnpm install        install all the dependencies in your project\nnpm install <foo>  add the <foo> dependency to your project\nnpm test           run this project's tests\nnpm run <foo>      run the script named <foo>\n\nnpm@${NPM_VERSION}\n`);
    return 1;
  }
  switch (cmd) {
    case 'install':
    case 'i':
    case 'in':
    case 'isntall':
    case 'add':
      if (f.global) {
        ctx.vfs.mkdir(globalDir, 0o755, true);
        if (!ctx.vfs.exists(path.join(globalDir, 'package.json'))) writeJson(ctx, path.join(globalDir, 'package.json'), { name: 'global', private: true });
        const code = await npm.add(globalDir, rest, { ...f, ignoreScripts: true });
        if (code) return code;
        // expose global bins
        const bdir = path.join(globalDir, 'node_modules/.bin');
        try {
          for (const b of ctx.vfs.readdir(bdir)) {
            const link = `/usr/local/bin/${b}`;
            if (ctx.vfs.tryLookup(link, false)) ctx.vfs.unlink(link);
            ctx.vfs.symlink(path.join(bdir, b), link);
          }
        } catch {}
        return 0;
      }
      if (rest.length) return npm.add(projectDir(), rest, f);
      if (cmd === 'add') {
        ctx.err(`${pm} add requires at least one package\n`);
        return 1;
      }
      return npm.install(projectDir(), f);
    case 'ci':
    case 'clean-install':
    case 'install-clean': {
      const dir = projectDir();
      ctx.vfs.rmrf(path.join(dir, 'node_modules'));
      return npm.install(dir, f);
    }
    case 'update':
    case 'up':
    case 'upgrade':
      return npm.install(projectDir(), f, { noLock: true });
    case 'uninstall':
    case 'remove':
    case 'rm':
    case 'un':
    case 'unlink':
      return npm.remove(projectDir(), rest, f);
    case 'run':
    case 'run-script':
    case 'rum':
    case 'urn':
      return npm.run(projectDir(), rest[0], [...rest.slice(1), ...f.passthrough], f);
    case 'test':
    case 't':
    case 'tst':
    case 'start':
    case 'stop':
    case 'restart':
      return npm.run(projectDir(), cmd === 't' || cmd === 'tst' ? 'test' : cmd, [...rest, ...f.passthrough], f);
    case 'exec':
    case 'x':
    case 'dlx': {
      const pkgs: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--package' || argv[i] === '-p') pkgs.push(argv[++i]);
        else if (argv[i].startsWith('--package=')) pkgs.push(argv[i].slice(10));
      }
      const execArgs = [...rest.filter((r) => !pkgs.includes(r)), ...f.passthrough];
      return npm.exec(baseDir, execArgs, { ...f, yes: true }, { forceInstall: cmd === 'dlx' && pm !== 'npm', packages: pkgs });
    }
    case 'create':
    case 'init': {
      if (cmd === 'init' && (!rest.length || rest[0].startsWith('-'))) return npm.init(baseDir, f);
      const [init, ...iargs] = rest;
      let pkgName: string;
      if (init.startsWith('@')) {
        const [scope, n] = init.split('/');
        pkgName = n ? `${scope}/create-${n.replace(/@.*$/, '')}` : `${scope}/create`;
      } else pkgName = `create-${init}`;
      const version = !init.startsWith('@') && init.includes('@') ? '@' + init.split('@')[1] : '';
      return npm.exec(baseDir, [pkgName.replace(/@[^/]*$/, '') + version, ...iargs, ...f.passthrough], { ...f, yes: true }, { forceInstall: true });
    }
    case 'view':
    case 'info':
    case 'show':
    case 'v':
      return npm.view(baseDir, rest);
    case 'ls':
    case 'list':
    case 'll':
    case 'la':
      return npm.ls(projectDir());
    case 'prune':
    case 'dedupe':
    case 'ddp':
    case 'rebuild':
    case 'rb':
      return npm.install(projectDir(), f);
    case 'config':
    case 'c': {
      const rc = readNpmrc(ctx, baseDir);
      if (rest[0] === 'get') {
        const k = rest[1] ?? 'registry';
        ctx.out((rc[k] ?? (k === 'registry' ? 'https://registry.npmjs.org/' : k === 'prefix' ? '/usr/local' : 'undefined')) + '\n');
        return 0;
      }
      if (rest[0] === 'set' && rest[1]) {
        const [k, v] = rest[1].includes('=') ? rest[1].split('=') : [rest[1], rest[2]];
        const file = path.join(ctx.env.HOME ?? '/home/user', '.npmrc');
        let text = '';
        try {
          text = dec.decode(ctx.vfs.readFile(file));
        } catch {}
        text = text.split('\n').filter((l) => l && !l.startsWith(k + '=')).concat(`${k}=${v}`).join('\n') + '\n';
        ctx.vfs.writeFile(file, text);
        return 0;
      }
      if (rest[0] === 'list' || rest[0] === 'ls') {
        for (const [k, v] of Object.entries(rc)) ctx.out(`${k} = "${v}"\n`);
        return 0;
      }
      return 0;
    }
    case 'prefix':
      ctx.out((f.global ? '/usr/local' : projectDir()) + '\n');
      return 0;
    case 'root':
      ctx.out((f.global ? '/usr/local/lib/node_modules' : path.join(projectDir(), 'node_modules')) + '\n');
      return 0;
    case 'bin':
      ctx.out(path.join(projectDir(), 'node_modules/.bin') + '\n');
      return 0;
    case 'pkg': {
      const dir = projectDir();
      const pjPath = path.join(dir, 'package.json');
      const pkg = readJsonFile(ctx.vfs, pjPath) ?? {};
      if (rest[0] === 'get') {
        const v = rest[1] ? rest[1].split('.').reduce((o: any, k) => o?.[k], pkg) : pkg;
        ctx.out(JSON.stringify(v, null, 2) + '\n');
        return 0;
      }
      if (rest[0] === 'set') {
        for (const kv of rest.slice(1)) {
          const eq = kv.indexOf('=');
          const keys = kv.slice(0, eq).split('.');
          let o = pkg;
          for (const k of keys.slice(0, -1)) o = o[k] ??= {};
          o[keys[keys.length - 1]] = kv.slice(eq + 1);
        }
        writeJson(ctx, pjPath, pkg);
        return 0;
      }
      return 1;
    }
    case 'cache':
      if (rest[0] === 'clean' || rest[0] === 'clear' || rest[0] === 'verify') {
        if (typeof caches !== 'undefined') await caches.delete('openvessel-npm-v1').catch(() => {});
        ctx.out('Cache cleaned\n');
      }
      return 0;
    case 'audit':
    case 'fund':
    case 'doctor':
    case 'outdated':
    case 'login':
    case 'publish':
    case 'whoami':
      ctx.err(`${pm} ${cmd} is not supported in OpenVessel\n`);
      return cmd === 'audit' || cmd === 'fund' ? 0 : 1;
    case 'why':
    case 'explain':
      return npm.ls(projectDir());
    default: {
      // pnpm/yarn/bun run scripts directly; bun can also run files
      const dir = projectDir();
      const pkg = readJsonFile(ctx.vfs, path.join(dir, 'package.json'));
      if (pm !== 'npm') {
        if (pkg?.scripts?.[cmd] !== undefined) return npm.run(dir, cmd, [...rest, ...f.passthrough], f);
        if (pm === 'bun' && /\.(m?[jt]s|cjs|tsx?)$/.test(cmd)) return ctx.run(['node', cmd, ...rest]);
        return npm.exec(baseDir, [cmd, ...rest, ...f.passthrough], f);
      }
      ctx.err(`Unknown command: "${cmd}"\n\nTo see a list of supported npm commands, run:\n  npm help\n`);
      return 1;
    }
  }
}

export function installNpm(kernel: Kernel) {
  const front = (pm: 'npm' | 'pnpm' | 'yarn' | 'bun') => async (ctx: ProgramContext) => main(ctx, pm, ctx.argv.slice(1));
  kernel.registerProgram('npm', front('npm'), ['/usr/bin']);
  kernel.registerProgram('pnpm', front('pnpm'), ['/usr/bin']);
  kernel.registerProgram('yarn', front('yarn'), ['/usr/bin']);
  kernel.registerProgram('bun', front('bun'), ['/usr/bin']);
  kernel.registerProgram('npx', async (ctx) => main(ctx, 'npm', ['exec', '--', ...ctx.argv.slice(1).filter((a) => a !== '-y' && a !== '--yes')]), ['/usr/bin']);
  kernel.registerProgram('pnpx', async (ctx) => main(ctx, 'pnpm', ['dlx', ...ctx.argv.slice(1)]), ['/usr/bin']);
  kernel.registerProgram('bunx', async (ctx) => main(ctx, 'bun', ['x', ...ctx.argv.slice(1)]), ['/usr/bin']);
  kernel.registerProgram('corepack', async (ctx) => {
    ctx.err('corepack: package managers are built into OpenVessel; nothing to do\n');
    return 0;
  }, ['/usr/bin']);
  void enc;
  void exitCodeOf;
  void isDirectory;
}
