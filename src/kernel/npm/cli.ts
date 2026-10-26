// npm / npx / pnpm / yarn / bun commands (one implementation, several front ends).

import { NODE_VERSION } from '../../node/version.ts';
import * as path from '../../shared/path.ts';
import type { Kernel, ProgramContext } from '../kernel.ts';
import { isLink } from '../vfs.ts';
import { Installer, listWorkspaces, readJsonFile } from './install.ts';
import { readLockHints } from './lockfile.ts';
import { type FetchFn, Registry } from './registry.ts';
import * as semver from './semver.ts';

const dec = new TextDecoder();
export const NPM_VERSION = '10.9.3';
type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';
const PM_VERSIONS: Record<Pm, string> = { npm: NPM_VERSION, pnpm: '9.15.9', yarn: '1.22.22', bun: '1.2.21' };

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

/** The workspace root that lists `dir` as one of its workspaces, if any. */
function findWorkspaceRoot(ctx: ProgramContext, dir: string): string | null {
  let d = path.dirname(dir);
  for (;;) {
    if (ctx.vfs.exists(path.join(d, 'package.json')) || ctx.vfs.exists(path.join(d, 'pnpm-workspace.yaml'))) {
      if (listWorkspaces(ctx.vfs, d).some((w) => w.dir === dir)) return d;
    }
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
  /** undefined: not given (NODE_ENV=production then omits devDependencies, like npm). */
  omitDev?: boolean;
  omitOptional: boolean;
  ignoreScripts: boolean;
  /** npm exec: true for --yes, false for --no, undefined when neither was given. */
  yes?: boolean;
  silent: boolean;
  legacyPeerDeps: boolean;
  json: boolean;
  ifPresent: boolean;
  /** yarn --frozen-lockfile / --pure-lockfile / --no-lockfile: don't write yarn.lock. */
  noLockfile: boolean;
  help: boolean;
  version: boolean;
  /** npm -w/--workspace */
  workspaces: string[];
  /** npm --workspaces/-ws */
  allWorkspaces: boolean;
  includeWorkspaceRoot: boolean;
  /** pnpm and bun --filter/-F */
  filters: string[];
  /** pnpm -r/--recursive */
  recursive: boolean;
  /** pnpm -w/--workspace-root */
  workspaceRoot: boolean;
  /** exec: -p/--package */
  packages: string[];
  /** npm exec -c/--call */
  call?: string;
  /** pnpm dlx -c/--shell-mode */
  shellMode: boolean;
  prefix?: string;
  /** npm: `--name[=value]` options (npm keeps every one as config, scripts see it as npm_config_<name>) */
  config: Record<string, string>;
  rest: string[];
  passthrough: string[];
  dashDash: boolean;
  /** index of the first argument not parsed (the first positional with stopAtPositional, or `--`) */
  stop: number;
}

/** npm's config names (and their long aliases): any other `--name` gets an "Unknown cli config" warning. */
const NPM_CONFIGS = new Set(
  ('_auth access all allow-same-version audit audit-level auth-type before bin-links browser ca cache cafile call cert cidr ci-name color ' +
    'commit-hooks cpu depth description desc diff diff-dst-prefix diff-ignore-all-space diff-name-only diff-no-prefix diff-src-prefix diff-text ' +
    'diff-unified dry-run editor engine-strict expect-result-count expect-results fetch-retries fetch-retry-factor fetch-retry-maxtimeout ' +
    'fetch-retry-mintimeout fetch-timeout force foreground-scripts format-package-lock fund git git-tag-version global global-style globalconfig ' +
    'heading help https-proxy if-present ignore-scripts include include-staged include-workspace-root init-author-email init-author-name ' +
    'init-author-url init-license init-module init-type init-version init-private install-links install-strategy json key legacy-bundling ' +
    'legacy-peer-deps libc link local local-address location lockfile-version loglevel logs-dir logs-max long maxsockets message node-options ' +
    'noproxy offline omit omit-lockfile-registry-resolved only optional os otp pack-destination package package-lock package-lock-only parseable ' +
    'porcelain prefer-dedupe prefer-offline prefer-online prefix preid production dev progress provenance provenance-file proxy quiet read-only ' +
    'readonly rebuild-bundle reg registry replace-registry-host save save-bundle save-dev save-exact save-optional save-peer save-prefix ' +
    'save-prod sbom-format sbom-type scope script-shell searchexclude searchlimit searchopts searchstaleness shell shrinkwrap sign-git-commit ' +
    'sign-git-tag silent strict-peer-deps strict-ssl tag tag-version-prefix timing umask unicode update-notifier usage user-agent userconfig ' +
    'verbose version versions viewer which workspace workspaces workspaces-update yes enjoy-by dir cwd').split(' '),
);

/** Options that take a value (`--opt value` as well as `--opt=value`), per front end. */
const VALUE_OPTS: Record<Pm, string[]> = {
  npm: ['--prefix', '-C', '--registry', '--loglevel', '--cache', '--userconfig', '--tag', '--otp', '--omit', '--include', '--workspace', '-w', '--script-shell', '--save-prefix'],
  pnpm: ['--dir', '-C', '--prefix', '--filter', '-F', '--registry', '--loglevel', '--reporter', '--store-dir', '--modules-dir', '--virtual-store-dir', '--workspace-concurrency', '--omit', '--include'],
  yarn: ['--cwd', '--registry', '--network-timeout', '--modules-folder', '--cache-folder', '--global-folder', '--link-folder', '--mutex'],
  bun: ['--cwd', '--filter', '-F', '--registry', '--cache-dir', '--backend', '--omit'],
};
const EXEC_VALUE_OPTS: Record<Pm, string[]> = { npm: ['--package', '-p', '--call', '-c'], pnpm: ['--package'], yarn: ['--package', '-p'], bun: ['--package', '-p'] };

function parseFlags(args: string[], pm: Pm, o: { exec?: boolean; stopAtPositional?: boolean } = {}): Flags {
  const f: Flags = {
    dev: false, exact: false, global: false, omitOptional: false, ignoreScripts: false, silent: false, legacyPeerDeps: false, json: false, ifPresent: false,
    noLockfile: false, help: false, version: false, workspaces: [], allWorkspaces: false, includeWorkspaceRoot: false, filters: [], recursive: false,
    workspaceRoot: false, packages: [], shellMode: false, config: {}, rest: [], passthrough: [], dashDash: false, stop: args.length,
  };
  const valued = new Set([...VALUE_OPTS[pm], ...(o.exec ? EXEC_VALUE_OPTS[pm] : []), '--dir', '--cwd']);
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') {
      f.passthrough = args.slice(i + 1);
      f.dashDash = true;
      f.stop = i;
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      if (o.stopAtPositional) {
        f.stop = i;
        break;
      }
      f.rest.push(a);
      continue;
    }
    let value: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (valued.has(a)) value = args[++i] ?? '';
    if (pm === 'npm' && a.startsWith('--')) {
      const neg = a.startsWith('--no-');
      f.config[neg ? a.slice(5) : a.slice(2)] = neg ? 'false' : (value ?? 'true');
    }
    switch (a) {
      case '-D':
      case '--save-dev':
      case '--dev':
        f.dev = true;
        break;
      case '-d':
        // npm: --loglevel info; bun: --dev
        if (pm === 'bun') f.dev = true;
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
        f.omitDev = value !== 'false';
        break;
      case '-P':
        // npm: --save-prod
        if (pm === 'pnpm') f.omitDev = true;
        break;
      case '-p':
        if (value !== undefined) f.packages.push(value);
        else if (pm === 'bun') f.omitDev = true;
        break;
      case '--package':
        if (value !== undefined) f.packages.push(value);
        break;
      case '--omit':
        if (value === 'dev') f.omitDev = true;
        if (value === 'optional') f.omitOptional = true;
        break;
      case '--include':
        if (value === 'dev') f.omitDev = false;
        if (value === 'optional') f.omitOptional = false;
        break;
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
      case '--no':
      case '--no-yes':
        f.yes = false;
        break;
      case '-s':
      case '--silent':
        f.silent = true;
        break;
      case '--loglevel':
      case '--reporter':
        if (value === 'silent') f.silent = true;
        break;
      case '--legacy-peer-deps':
      case '--force':
        f.legacyPeerDeps = true;
        break;
      case '--json':
        f.json = true;
        break;
      case '--if-present':
        f.ifPresent = true;
        break;
      case '--frozen-lockfile':
      case '--pure-lockfile':
      case '--no-lockfile':
        if (pm === 'yarn') f.noLockfile = true;
        break;
      case '-h':
      case '--help':
        f.help = true;
        break;
      case '-v':
      case '--version':
        f.version = true;
        break;
      case '-w':
      case '--workspace':
        if (value !== undefined) f.workspaces.push(value);
        else if (pm === 'pnpm') f.workspaceRoot = true;
        break;
      case '--workspace-root':
        f.workspaceRoot = true;
        break;
      case '--workspaces':
      case '-ws':
        f.allWorkspaces = value !== 'false';
        break;
      case '--include-workspace-root':
        f.includeWorkspaceRoot = true;
        break;
      case '--filter':
      case '-F':
        if (value !== undefined) f.filters.push(value);
        break;
      case '-r':
      case '--recursive':
        if (pm === 'pnpm') f.recursive = true;
        break;
      case '-c':
      case '--call':
        if (value !== undefined) f.call = value;
        else if (pm === 'pnpm') f.shellMode = true;
        break;
      case '--shell-mode':
        f.shellMode = true;
        break;
      case '--prefix':
      case '-C':
      case '--dir':
      case '--cwd':
        if (value !== undefined) f.prefix = value;
        break;
      default:
      // other flags are accepted and ignored (--no-fund, --no-audit, --save, …)
    }
  }
  return f;
}

/** Commands of each front end. A command a client doesn't have runs a script of that name instead. */
type Op =
  | 'install' | 'add' | 'ci' | 'update' | 'remove' | 'run' | 'script' | 'exec' | 'dlx' | 'local' | 'shell' | 'create' | 'init' | 'view' | 'ls'
  | 'why' | 'reinstall' | 'config' | 'get' | 'set' | 'prefix' | 'root' | 'bin' | 'pkg' | 'cache' | 'help' | 'global' | 'workspace' | 'workspaces'
  | 'bunpm' | 'unsupported' | 'unsupported0';
function table(spec: Partial<Record<Op, string>>): Map<string, Op> {
  const m = new Map<string, Op>();
  for (const [op, names] of Object.entries(spec)) for (const n of names!.split(' ')) m.set(n, op as Op);
  return m;
}
const COMMANDS: Record<Pm, Map<string, Op>> = {
  npm: table({
    install: 'install i in ins inst insta instal isnt isnta isntal isntall add',
    ci: 'ci clean-install ic install-clean isntall-clean',
    update: 'update up upgrade udpate',
    remove: 'uninstall unlink remove rm r un',
    run: 'run run-script rum urn',
    script: 'test t tst start stop restart',
    exec: 'exec x',
    init: 'init create innit',
    view: 'view info show v',
    ls: 'ls list la ll',
    why: 'why explain',
    reinstall: 'prune dedupe ddp rebuild rb',
    config: 'config c',
    get: 'get',
    set: 'set',
    prefix: 'prefix',
    root: 'root',
    pkg: 'pkg',
    cache: 'cache',
    help: 'help',
    unsupported0: 'audit fund',
    unsupported: 'doctor outdated login logout adduser publish unpublish whoami link ln pack version deprecate dist-tag owner search token team access',
  }),
  pnpm: table({
    install: 'install i',
    add: 'add',
    ci: 'ci',
    update: 'update up upgrade',
    remove: 'remove rm uninstall un uni',
    run: 'run run-script',
    script: 'test t tst start restart',
    local: 'exec',
    dlx: 'dlx',
    create: 'create',
    init: 'init',
    view: 'view info show v',
    ls: 'list ls la ll',
    why: 'why',
    reinstall: 'prune dedupe rebuild rb',
    config: 'config c',
    get: 'get',
    set: 'set',
    prefix: 'prefix',
    root: 'root',
    bin: 'bin',
    pkg: 'pkg',
    help: 'help',
    unsupported0: 'audit',
    unsupported: 'outdated publish login logout whoami doctor link ln unlink pack patch patch-commit store fetch deploy env setup server licenses import install-test it recursive m multi',
  }),
  yarn: table({
    install: 'install',
    add: 'add',
    update: 'upgrade',
    remove: 'remove',
    run: 'run',
    local: 'exec',
    dlx: 'dlx',
    create: 'create',
    init: 'init',
    view: 'info',
    ls: 'list',
    why: 'why',
    config: 'config',
    cache: 'cache',
    bin: 'bin',
    global: 'global',
    workspace: 'workspace',
    workspaces: 'workspaces',
    help: 'help',
    unsupported0: 'audit',
    unsupported: 'outdated login logout publish link unlink pack version versions check autoclean import licenses owner policies tag team access generate-lock-entry upgrade-interactive unplug node',
  }),
  bun: table({
    install: 'install i',
    add: 'add a',
    update: 'update',
    remove: 'remove rm',
    run: 'run',
    dlx: 'x',
    shell: 'exec',
    create: 'create c',
    init: 'init',
    view: 'info',
    why: 'why',
    bunpm: 'pm',
    help: 'help',
    unsupported0: 'audit',
    unsupported: 'test build outdated link unlink publish patch patch-commit upgrade repl list',
  }),
};
const SCRIPT_ALIASES: Record<string, string> = { t: 'test', tst: 'test' };

const GLOBAL_DIR = '/usr/local/lib/node_modules/.ov-global';

interface Project {
  name: string;
  dir: string;
  pkg: any;
}

class Npm {
  /** npm: the command line's `--name` options, given to scripts as npm_config_<name> */
  cliConfig: Record<string, string> = {};
  constructor(public ctx: ProgramContext, public pm: Pm) {}

  out(s: string) {
    this.ctx.out(s);
  }
  err(s: string) {
    this.ctx.err(s);
  }

  userAgent() {
    return `${this.pm}/${PM_VERSIONS[this.pm]} npm/? node/v${NODE_VERSION} linux x64 workspaces/false`;
  }

  async install(dir: string, f: Flags, opts: { noLock?: boolean; saveLock?: boolean } = {}): Promise<number> {
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
      omitDev: f.omitDev ?? ctx.env.NODE_ENV === 'production',
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
    // yarn keeps yarn.lock up to date (v1 format)
    let savedLock = false;
    if (this.pm === 'yarn' && opts.saveLock !== false && !f.noLockfile) {
      const text = inst.yarnLockfile();
      const file = path.join(dir, 'yarn.lock');
      let old: string | null = null;
      try {
        old = dec.decode(ctx.vfs.readFile(file));
      } catch {}
      if (old !== text) {
        ctx.vfs.writeFile(file, text);
        savedLock = true;
      }
    }
    if (!f.ignoreScripts) {
      for (const s of ['install', 'postinstall', 'preprepare', 'prepare', 'postprepare']) {
        const c = await this.runLifecycle(dir, rootPkg, s);
        if (c) return c;
      }
    }
    if (!f.silent) {
      if (this.pm === 'pnpm') this.out(`Packages: +${res.added}\nDone in ${fmtTime(performance.now() - t0)}\n`);
      else if (this.pm === 'yarn') this.out(`${savedLock ? 'success Saved lockfile.\n' : res.added ? '' : 'success Already up-to-date.\n'}Done in ${fmtTime(performance.now() - t0)}.\n`);
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
    for (const [k, v] of Object.entries(this.cliConfig)) env[`npm_config_${k.replace(/-/g, '_')}`] = v;
    return env;
  }

  async runScript(dir: string, pkg: any, name: string, args: string[], o: { quiet: boolean }): Promise<number> {
    const script = pkg.scripts?.[name];
    if (script === undefined) return 0;
    const quoted = args.map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
    const full = quoted ? `${script} ${quoted}` : script;
    if (!o.quiet) {
      if (this.pm === 'yarn') this.out(`$ ${full}\n`);
      else this.out(`\n> ${pkg.name ?? ''}${pkg.version ? '@' + pkg.version : ''} ${name}${this.pm === 'pnpm' ? ' ' + dir : ''}\n> ${full}\n\n`);
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
      if (f.ifPresent) return 0;
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

  /** Adds packages to `dir`'s package.json, then installs `installDir` (the workspace root). */
  async add(dir: string, specs: string[], f: Flags, installDir = dir): Promise<number> {
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
          // a dist-tag (latest, next…) is saved as ^<the version it points to>, like npm
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
    return this.install(installDir, f);
  }

  async remove(dir: string, names: string[], f: Flags, installDir = dir): Promise<number> {
    const pjPath = path.join(dir, 'package.json');
    const pkg = readJsonFile(this.ctx.vfs, pjPath);
    if (!pkg) return 1;
    for (const n of names) {
      for (const fld of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (pkg[fld]) delete pkg[fld][n];
    }
    writeJson(this.ctx, pjPath, pkg);
    return this.install(installDir, f);
  }

  /** node_modules/.bin/<name> in `dir` or an ancestor. */
  findLocalBin(dir: string, name: string): string | null {
    let d = dir;
    for (;;) {
      const b = path.join(d, 'node_modules/.bin', name);
      if (this.ctx.vfs.tryLookup(b)) return b;
      const p = path.dirname(d);
      if (p === d) return null;
      d = p;
    }
  }

  /**
   * Runs a command with the project's binaries on PATH, without installing anything (pnpm exec, yarn
   * exec, and pnpm/yarn/bun commands that are neither built in nor a script).
   */
  async runLocal(dir: string, args: string[], o: { anyCommand: boolean }): Promise<number> {
    const [cmd, ...rest] = args;
    const pkg = readJsonFile(this.ctx.vfs, path.join(dir, 'package.json')) ?? {};
    const env = this.scriptEnv(dir, pkg, cmd, args.join(' '));
    const bin = this.findLocalBin(dir, cmd) ?? (o.anyCommand ? this.ctx.kernel.which(cmd, env, dir) : null);
    if (!bin) {
      if (this.pm === 'pnpm') this.err(` ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "${cmd}" not found\n`);
      else if (this.pm === 'bun') this.err(`error: Script not found "${cmd}"\n`);
      else this.err(`error Command "${cmd}" not found.\n`);
      return 1;
    }
    return this.ctx.run([bin, ...rest], { env, cwd: dir });
  }

  /** npx / npm exec / pnpm dlx / yarn dlx / bunx */
  async exec(dir: string, args: string[], f: Flags, opts: { forceInstall?: boolean; cwd?: string } = {}): Promise<number> {
    const vfs = this.ctx.vfs;
    const packages = f.packages;
    const call = f.call ?? (f.shellMode && args.length ? args.join(' ') : undefined);
    if (!args.length && call === undefined) {
      this.err('npm error npx requires a command\n');
      return 1;
    }
    const cwd = opts.cwd ?? this.ctx.cwd;
    const projectPkg = () => readJsonFile(vfs, path.join(dir, 'package.json')) ?? {};
    const [first, ...rest] = args;
    const { name, range } = splitSpec(first ?? '');
    const binName = packages.length ? first : name.replace(/^@[^/]+\//, '');
    // local bin?
    if (!opts.forceInstall && !packages.length && call === undefined && !range) {
      const b = this.findLocalBin(dir, first);
      if (b) return this.ctx.run([b, ...rest], { env: this.scriptEnv(dir, projectPkg(), 'npx', args.join(' ')), cwd });
      const g = this.ctx.kernel.which(first, this.ctx.env, this.ctx.cwd);
      if (g && !g.startsWith('/bin/') && !first.startsWith('create-')) return this.ctx.run([g, ...rest], { cwd });
    }
    if (call !== undefined && !packages.length) {
      const env = this.scriptEnv(dir, projectPkg(), 'npx', call);
      return this.ctx.run(['/bin/sh', '-c', call], { env, cwd });
    }
    // install into a cache dir
    const pkgs = packages.length ? packages : [first];
    const key = pkgs.join(' ').replace(/[^\w@.-]+/g, '_').slice(0, 100);
    const home = this.ctx.env.HOME ?? '/home/user';
    const cacheDir = path.join(home, '.npm/_npx', key);
    const fresh = !vfs.exists(path.join(cacheDir, 'node_modules/.package-lock.json'));
    if (fresh || opts.forceInstall) {
      // npm asks before installing; without a terminal to ask on it goes ahead with a warning (as npm
      // does when stdin is not a TTY), and --no refuses
      if (fresh && this.pm === 'npm' && f.yes === false) {
        this.err(`npm error npx canceled due to missing packages and no YES option: ${JSON.stringify(pkgs)}\n`);
        return 1;
      }
      vfs.mkdir(cacheDir, 0o755, true);
      const deps: Record<string, string> = {};
      for (const p of pkgs) {
        const s = splitSpec(p);
        deps[s.name] = s.range || 'latest';
      }
      writeJson(this.ctx, path.join(cacheDir, 'package.json'), { name: 'npx-cache', private: true, dependencies: deps });
      const code = await this.install(cacheDir, { ...f, silent: true, ignoreScripts: true, omitDev: true }, { saveLock: false });
      if (code) return code;
      if (fresh && this.pm === 'npm' && f.yes === undefined && !f.silent) {
        const installed = Object.keys(deps).map((n) => `${n}@${readJsonFile(vfs, path.join(cacheDir, 'node_modules', n, 'package.json'))?.version ?? deps[n]}`);
        this.err(`npm warn exec The following package${installed.length > 1 ? 's were' : ' was'} not found and will be installed: ${installed.join(', ')}\n`);
      }
    }
    const env = this.scriptEnv(dir, projectPkg(), 'npx', call ?? args.join(' '));
    env.PATH = `${path.join(cacheDir, 'node_modules/.bin')}:${env.PATH}`;
    if (call !== undefined) return this.ctx.run(['/bin/sh', '-c', call], { env, cwd });
    // find the bin
    let bin: string;
    if (packages.length) bin = path.join(cacheDir, 'node_modules/.bin', first);
    else {
      const pj = readJsonFile(vfs, path.join(cacheDir, 'node_modules', name, 'package.json'));
      const bins = typeof pj?.bin === 'string' ? { [name.replace(/^@[^/]+\//, '')]: pj.bin } : (pj?.bin ?? {});
      if (bins[binName]) bin = path.join(cacheDir, 'node_modules/.bin', binName);
      else if (Object.keys(bins).length === 1) bin = path.join(cacheDir, 'node_modules/.bin', Object.keys(bins)[0]);
      else bin = path.join(cacheDir, 'node_modules/.bin', binName);
    }
    if (!vfs.tryLookup(bin)) {
      this.err(`npm error could not determine executable to run for ${first}\n`);
      return 1;
    }
    return this.ctx.run([bin, ...rest], { env, cwd });
  }

  /** The full registry document (the installer's abbreviated one has no description, license, …). */
  private async fullPackument(dir: string, name: string): Promise<any> {
    const url = getRegistry(this.ctx, dir).registryFor(name) + name.replace('/', '%2f');
    const res = await getNetFetch()(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) throw Object.assign(new Error(`404 Not Found - GET ${url} - '${name}' is not in this registry.`), { code: 'E404' });
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - GET ${url}`), { code: 'E' + res.status });
    return res.json();
  }

  async view(dir: string, args: string[], f: Flags): Promise<number> {
    let [spec, ...fields] = args;
    if (!spec || spec === '.') {
      // no argument: the project's own package
      const own = readJsonFile(this.ctx.vfs, path.join(findProjectRoot(this.ctx, dir) ?? dir, 'package.json'));
      if (!own?.name) {
        this.err('npm error code EUSAGE\nnpm error Usage: npm view [<package-spec>] [<field>[.subfield]...]\n');
        return 1;
      }
      spec = own.name;
    }
    const { name, range } = splitSpec(spec);
    let p: any;
    try {
      p = await this.fullPackument(dir, name);
    } catch (e: any) {
      this.err(`npm error code ${e?.code ?? 'E404'}\nnpm error ${e?.message}\n`);
      return 1;
    }
    const all = Object.keys(p.versions ?? {});
    const tag = p['dist-tags']?.[range || 'latest'];
    const versions = tag && p.versions[tag] ? [tag] : semver.validRange(range) ? all.filter((v) => semver.satisfies(v, range)) : [];
    if (!versions.length) {
      this.err(`npm error code E404\nnpm error 404 No match found for version ${range}\nnpm error 404\nnpm error 404  '${spec}' is not in this registry.\n`);
      return 1;
    }
    versions.sort((a, b) => semver.compare(a, b));
    const dataOf = (v: string) => {
      const { versions: _v, ...top } = p;
      return { ...top, ...p.versions[v], versions: all, 'dist-tags': p['dist-tags'], time: p.time };
    };
    if (f.json) {
      const vals = versions.map((v) => {
        const d = dataOf(v);
        if (!fields.length) return d;
        if (fields.length === 1) return lookup(d, fields[0]);
        return Object.fromEntries(fields.map((fld) => [fld, lookup(d, fld)]));
      });
      this.out(JSON.stringify(vals.length === 1 ? vals[0] : vals, null, 2) + '\n');
      return 0;
    }
    for (const v of versions) {
      const d = dataOf(v);
      if (fields.length) {
        const multi = versions.length > 1;
        for (const fld of fields) {
          const val = lookup(d, fld);
          if (val === undefined) continue;
          const shown = fields.length === 1 && !multi && typeof val === 'string' ? val : inspect(val);
          this.out(`${multi ? `${name}@${v} ` : ''}${fields.length > 1 ? `${fld} = ` : ''}${shown}\n`);
        }
      } else this.out(viewSummary(d, all.length));
    }
    return 0;
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

  async globalInstall(specs: string[], f: Flags): Promise<number> {
    const ctx = this.ctx;
    ctx.vfs.mkdir(GLOBAL_DIR, 0o755, true);
    if (!ctx.vfs.exists(path.join(GLOBAL_DIR, 'package.json'))) writeJson(ctx, path.join(GLOBAL_DIR, 'package.json'), { name: 'global', private: true });
    const code = await this.add(GLOBAL_DIR, specs, { ...f, dev: false, ignoreScripts: true });
    if (code) return code;
    this.linkGlobalBins();
    return 0;
  }

  async globalRemove(names: string[], f: Flags): Promise<number> {
    if (!this.ctx.vfs.exists(path.join(GLOBAL_DIR, 'package.json'))) return 0;
    const code = await this.remove(GLOBAL_DIR, names, { ...f, ignoreScripts: true });
    this.linkGlobalBins();
    return code;
  }

  /** Links the binaries of the globally installed packages (not of their dependencies) into /usr/local/bin. */
  private linkGlobalBins() {
    const vfs = this.ctx.vfs;
    const bdir = path.join(GLOBAL_DIR, 'node_modules/.bin');
    const want = new Map<string, string>();
    const gpkg = readJsonFile(vfs, path.join(GLOBAL_DIR, 'package.json')) ?? {};
    for (const n of Object.keys(gpkg.dependencies ?? {})) {
      const pj = readJsonFile(vfs, path.join(GLOBAL_DIR, 'node_modules', n, 'package.json'));
      const bins = typeof pj?.bin === 'string' ? [n.replace(/^@[^/]+\//, '')] : Object.keys(pj?.bin ?? {});
      for (const b of bins) if (vfs.tryLookup(path.join(bdir, b), false)) want.set(b, path.join(bdir, b));
    }
    // drop links to packages that are gone
    try {
      for (const b of vfs.readdir('/usr/local/bin')) {
        const link = `/usr/local/bin/${b}`;
        const ino = vfs.tryLookup(link, false);
        if (ino && isLink(ino) && vfs.readlink(link).startsWith(GLOBAL_DIR + '/') && !want.has(b)) vfs.unlink(link);
      }
    } catch {}
    for (const [b, target] of want) {
      const link = `/usr/local/bin/${b}`;
      if (vfs.tryLookup(link, false)) vfs.unlink(link);
      vfs.symlink(target, link);
    }
  }
}

/** A path into `npm view` data: `dist.tarball`, `dependencies.react`. */
function lookup(o: any, field: string): any {
  return field.split('.').reduce((x: any, k) => x?.[k], o);
}

/** Values the way npm view prints them (util.inspect without colors, on one line when short). */
function inspect(v: any, indent = ''): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (v === null || typeof v !== 'object') return String(v);
  const inner = indent + '  ';
  const items = Array.isArray(v) ? v.map((x) => inspect(x, inner)) : Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : inspect(k)}: ${inspect(x, inner)}`);
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  if (!items.length) return open + close;
  const one = `${open} ${items.join(', ')} ${close}`;
  if (one.length + indent.length <= 72 && !one.includes('\n')) return one;
  return `${open}\n${items.map((x) => inner + x).join(',\n')}\n${indent}${close}`;
}

function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** The summary npm view prints without fields. */
function viewSummary(d: any, versionCount: number): string {
  const person = (p: any) => (typeof p === 'string' ? p : `${p.name ?? ''}${p.email ? ` <${p.email}>` : ''}`);
  const license = typeof d.license === 'string' ? d.license : (d.license?.type ?? 'Proprietary');
  const deps = Object.entries<string>(d.dependencies ?? {});
  let s = `\n${d.name}@${d.version} | ${license} | deps: ${deps.length || 'none'} | versions: ${versionCount}\n`;
  if (d.deprecated) s += `DEPRECATED - ${d.deprecated}\n`;
  if (d.description) s += `${d.description}\n`;
  if (d.homepage) s += `${d.homepage}\n`;
  if (Array.isArray(d.keywords) && d.keywords.length) s += `\nkeywords: ${d.keywords.join(', ')}\n`;
  const bins = typeof d.bin === 'string' ? [d.name.replace(/^@[^/]+\//, '')] : Object.keys(d.bin ?? {});
  if (bins.length) s += `\nbin: ${bins.join(', ')}\n`;
  if (d.dist) {
    s += `\ndist\n.tarball: ${d.dist.tarball}\n`;
    if (d.dist.shasum) s += `.shasum: ${d.dist.shasum}\n`;
    if (d.dist.integrity) s += `.integrity: ${d.dist.integrity}\n`;
    if (d.dist.unpackedSize) s += `.unpackedSize: ${fmtBytes(d.dist.unpackedSize)}\n`;
  }
  if (deps.length) s += `\ndependencies:\n${deps.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  if (Array.isArray(d.maintainers) && d.maintainers.length) s += `\nmaintainers:\n${d.maintainers.map((m: any) => `- ${person(m)}`).join('\n')}\n`;
  s += `\ndist-tags:\n${Object.entries(d['dist-tags'] ?? {}).map(([k, x]) => `${k}: ${x}`).join('\n')}\n`;
  const when = d.time?.[d.version];
  if (when) s += `\npublished ${when.slice(0, 10)}${d._npmUser ? ` by ${person(d._npmUser)}` : ''}\n`;
  return s;
}

function splitSpec(spec: string): { name: string; range: string } {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    return at === -1 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
  }
  const at = spec.indexOf('@');
  return at === -1 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/** Converts a pnpm/bun filter or npm workspace pattern with `*` into a regexp. */
function globRe(pat: string): RegExp {
  return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
}

/**
 * Projects picked by npm -w/--workspace/--workspaces, pnpm --filter/-r and bun --filter, or null when
 * none of these were given. pnpm and bun filters: a name (with `*`), `./path` or `{path}` (with `*`),
 * `!` to exclude; pnpm's `...`/`^` dependency selectors are reduced to the package itself.
 */
function selectProjects(ctx: ProgramContext, pm: Pm, root: string, f: Flags): Project[] | { error: string } | null {
  const rootPkg = readJsonFile(ctx.vfs, path.join(root, 'package.json')) ?? {};
  const ws: Project[] = listWorkspaces(ctx.vfs, root, rootPkg);
  const rootProject: Project = { name: rootPkg.name ?? path.basename(root), dir: root, pkg: rootPkg };
  if (pm === 'npm') {
    if (!f.workspaces.length && !f.allWorkspaces) return null;
    let picked: Project[];
    if (f.allWorkspaces) picked = ws;
    else {
      picked = [];
      for (const sel of f.workspaces) {
        const abs = ctx.resolve(sel);
        const hits = ws.filter((w) => w.name === sel || w.dir === abs || w.dir.startsWith(abs + '/'));
        if (!hits.length) return { error: `npm error No workspaces found:\nnpm error   --workspace=${sel}\n` };
        for (const h of hits) if (!picked.includes(h)) picked.push(h);
      }
    }
    if (!picked.length) return { error: 'npm error No workspaces found!\n' };
    return f.includeWorkspaceRoot ? [rootProject, ...picked] : picked;
  }
  if (!f.filters.length && !f.recursive) return null;
  const candidates = [rootProject, ...ws];
  if (!f.filters.length) return f.includeWorkspaceRoot ? candidates : ws;
  const matches = (p: Project, sel: string) => {
    sel = sel.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').replace(/^\^/, '');
    const pathSel = /^\{(.*)\}$/.exec(sel)?.[1] ?? (sel.startsWith('.') || sel.startsWith('/') ? sel : null);
    if (pathSel !== null) return globRe(path.resolve(root, pathSel)).test(p.dir);
    return globRe(sel).test(p.name);
  };
  const inc = f.filters.filter((s) => !s.startsWith('!'));
  const exc = f.filters.filter((s) => s.startsWith('!')).map((s) => s.slice(1));
  return candidates.filter((p) => (inc.length ? inc.some((s) => matches(p, s)) : p !== rootProject) && !exc.some((s) => matches(p, s)));
}

const USAGE = (pm: Pm) => `Usage: ${pm} <command>\n\nCommands: install, ci, add, remove, run, exec, test, start, init, view, ls, create\n(OpenVessel ${pm}-compatible front end)\n`;

async function main(ctx: ProgramContext, pm: Pm, argv: string[]): Promise<number> {
  const npm = new Npm(ctx, pm);
  // the client's own options come before the command; what follows the command is parsed per command
  const lead = parseFlags(argv, pm, { stopAtPositional: true });
  const leadArgs = argv.slice(0, lead.stop);
  const cmd = lead.dashDash ? lead.passthrough[0] : argv[lead.stop];
  const after = lead.dashDash ? lead.passthrough.slice(1) : argv.slice(lead.stop + 1);
  /** Flags of the whole command line (npm parses options anywhere before `--`). */
  const all = (o: { exec?: boolean } = {}) => parseFlags([...leadArgs, ...after], pm, o);
  if (lead.help) {
    ctx.out(USAGE(pm));
    return 0;
  }
  if (lead.version && !cmd) {
    ctx.out(PM_VERSIONS[pm] + '\n');
    return 0;
  }
  const baseDir = lead.prefix ? ctx.resolve(lead.prefix) : ctx.cwd;
  const projectDir = () => findProjectRoot(ctx, baseDir) ?? baseDir;
  const wsRoot = (dir: string) => findWorkspaceRoot(ctx, dir) ?? dir;

  if (!cmd) {
    if (pm === 'yarn' || pm === 'pnpm' || pm === 'bun') return npm.install(wsRoot(projectDir()), lead);
    ctx.out(`npm <command>\n\nUsage:\n\nnpm install        install all the dependencies in your project\nnpm install <foo>  add the <foo> dependency to your project\nnpm test           run this project's tests\nnpm run <foo>      run the script named <foo>\n\nnpm@${NPM_VERSION}\n`);
    return 1;
  }

  let op = COMMANDS[pm].get(cmd);
  if (!op && pm !== 'npm') {
    // pnpm, yarn and bun run a script when the name is not one of their commands
    const dir = projectDir();
    const pkg = readJsonFile(ctx.vfs, path.join(dir, 'package.json'));
    // with -r/--filter the name is a script of the selected projects (pnpm falls back to `run`)
    if (pkg?.scripts?.[cmd] !== undefined || ((pm === 'pnpm' || pm === 'bun') && (lead.recursive || lead.filters.length))) op = 'script';
    else if (pm === 'bun' && /\.(m?[jt]s|cjs|tsx?)$/.test(cmd)) return ctx.run(['node', cmd, ...after]);
    else return npm.runLocal(dir, [cmd, ...after], { anyCommand: pm === 'pnpm' });
  }
  if (!op) {
    ctx.err(`Unknown command: "${cmd}"\n\nTo see a list of supported npm commands, run:\n  npm help\n`);
    return 1;
  }

  // flags for commands other than the ones that pass their arguments on
  const passesArgs = op === 'run' || op === 'script' || op === 'dlx' || op === 'local' || op === 'shell' || op === 'workspace' || op === 'workspaces' || op === 'global' || op === 'bunpm';
  const f = pm === 'npm' || !passesArgs ? all({ exec: op === 'exec' }) : lead;
  if (pm === 'npm') {
    // npm keeps an unknown option as config (a script sees it in its environment) and warns about it
    npm.cliConfig = f.config;
    for (const k of Object.keys(f.config)) {
      if (!NPM_CONFIGS.has(k) && !f.silent) ctx.err(`npm warn Unknown cli config "--${k}". This will stop working in the next major version of npm.\n`);
    }
  }
  if (f.help) {
    ctx.out(USAGE(pm));
    return 0;
  }

  /** Runs `fn` in each selected project, or in `dir` when nothing was selected. */
  const eachProjectWith = async (sf: Flags, dir: string, fn: (p: Project) => Promise<number>, o: { needScript?: string } = {}): Promise<number> => {
    const sel = selectProjects(ctx, pm, wsRoot(dir), sf);
    if (sel === null) return fn({ name: '', dir, pkg: null });
    if ('error' in sel) {
      ctx.err(sel.error);
      return 1;
    }
    if (!sel.length) {
      if (pm === 'pnpm') ctx.out(`No projects matched the filters in "${wsRoot(dir)}"\n`);
      else ctx.err(pm === 'bun' ? 'error: No packages matched the filter\n' : 'npm error No workspaces found!\n');
      return pm === 'pnpm' ? 0 : 1;
    }
    // pnpm/bun -r/--filter run a script only in the selected projects that have it; none is an error
    const name = o.needScript;
    const todo = name && pm !== 'npm' ? sel.filter((p) => p.pkg?.scripts?.[name] !== undefined) : sel;
    if (!todo.length && !sf.ifPresent) {
      ctx.err(pm === 'bun' ? `error: No packages matched the filter or have the script "${name}"\n` : ` ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "${name}" script\n`);
      return 1;
    }
    // npm goes on after a failure and reports it at the end; pnpm and bun stop
    let last = 0;
    for (const p of todo) {
      const code = await fn(p);
      if (code) {
        last = code;
        if (pm !== 'npm') return code;
      }
    }
    return last;
  };
  const eachProject = (dir: string, fn: (p: Project) => Promise<number>) => eachProjectWith(f, dir, fn);

  /** Runs a script in the project, or in each selected workspace. */
  const runScript = (name: string | undefined, args: string[], sf: Flags) => {
    const dir = pm === 'pnpm' && sf.workspaceRoot ? wsRoot(projectDir()) : projectDir();
    return eachProjectWith(sf, dir, (p) => npm.run(p.dir, name, args, sf), { needScript: name });
  };

  /** yarn and bun drop a `--` right after the script name (yarn warns); pnpm passes it on. */
  const scriptArgs = (args: string[]) => {
    if (args[0] !== '--' || pm === 'pnpm' || pm === 'npm') return args;
    if (pm === 'yarn') ctx.err('warning From Yarn 1.0 onwards, scripts don\'t require "--" for options to be forwarded. In a future version, any explicit "--" will be forwarded as-is to the scripts.\n');
    return args.slice(1);
  };

  switch (op) {
    case 'install':
    case 'add': {
      if (f.global) return npm.globalInstall(f.rest, f);
      const dir = projectDir();
      const root = wsRoot(dir);
      if (f.rest.length) {
        if (pm === 'pnpm' && f.workspaceRoot) return npm.add(root, f.rest, f, root);
        const sel = selectProjects(ctx, pm, root, f);
        if (sel && 'error' in sel) {
          ctx.err(sel.error);
          return 1;
        }
        if (sel?.length) {
          // add to every selected workspace, then install once
          for (const p of sel.slice(0, -1)) {
            const code = await npm.add(p.dir, f.rest, { ...f, silent: true }, root);
            if (code) return code;
          }
          return npm.add(sel[sel.length - 1].dir, f.rest, f, root);
        }
        return npm.add(dir, f.rest, f, root);
      }
      if (op === 'add') {
        ctx.err(`${pm} add requires at least one package\n`);
        return 1;
      }
      return npm.install(root, f);
    }
    case 'ci': {
      const dir = wsRoot(projectDir());
      ctx.vfs.rmrf(path.join(dir, 'node_modules'));
      return npm.install(dir, f);
    }
    case 'update':
      return npm.install(wsRoot(projectDir()), f, { noLock: true });
    case 'remove': {
      if (f.global) return npm.globalRemove(f.rest, f);
      const dir = projectDir();
      const root = wsRoot(dir);
      const sel = selectProjects(ctx, pm, root, f);
      if (sel && 'error' in sel) {
        ctx.err(sel.error);
        return 1;
      }
      if (sel?.length) {
        for (const p of sel.slice(0, -1)) {
          const code = await npm.remove(p.dir, f.rest, { ...f, silent: true }, root);
          if (code) return code;
        }
        return npm.remove(sel[sel.length - 1].dir, f.rest, f, root);
      }
      return npm.remove(dir, f.rest, f, root);
    }
    case 'run': {
      if (pm === 'npm') return runScript(f.rest[0], [...f.rest.slice(1), ...f.passthrough], f);
      // options between `run` and the script name are the client's; everything after the name is the script's
      const g = parseFlags(after, pm, { stopAtPositional: true });
      const sf = parseFlags([...leadArgs, ...after.slice(0, g.stop)], pm);
      if (sf.help) {
        ctx.out(USAGE(pm));
        return 0;
      }
      if (g.dashDash) return runScript(g.passthrough[0], scriptArgs(g.passthrough.slice(1)), sf);
      return runScript(after[g.stop], scriptArgs(after.slice(g.stop + 1)), sf);
    }
    case 'script': {
      // (t/tst are aliases of test only where the client has them as commands)
      const name = COMMANDS[pm].has(cmd) ? (SCRIPT_ALIASES[cmd] ?? cmd) : cmd;
      if (pm === 'npm') return runScript(name, [...f.rest, ...f.passthrough], f);
      return runScript(name, scriptArgs(after), lead);
    }
    case 'exec': {
      // npm exec: options anywhere before `--`; npx puts its own `--` after the command name
      const execArgs = [...f.rest, ...f.passthrough];
      return eachProject(baseDir, (p) => npm.exec(p.pkg ? p.dir : baseDir, execArgs, f, { cwd: p.pkg ? p.dir : undefined }));
    }
    case 'dlx': {
      // options up to the package name are the client's; the rest goes to the command
      const g = parseFlags(after, pm, { exec: true, stopAtPositional: true });
      const xf = parseFlags([...leadArgs, ...after.slice(0, g.stop)], pm, { exec: true });
      if (xf.help) {
        ctx.out(USAGE(pm));
        return 0;
      }
      const execArgs = g.dashDash ? g.passthrough : after.slice(g.stop);
      return npm.exec(baseDir, execArgs, xf, { forceInstall: pm === 'pnpm' || pm === 'yarn' });
    }
    case 'local': {
      // pnpm exec / yarn exec: options up to the command name are the client's
      const g = parseFlags(after, pm, { stopAtPositional: true });
      const args = g.dashDash ? g.passthrough : after.slice(g.stop);
      if (!args.length) {
        ctx.err(pm === 'pnpm' ? " ERR_PNPM_EXEC_MISSING_COMMAND  'pnpm exec' requires a command to run\n" : 'error No command specified.\n');
        return 1;
      }
      const ef = parseFlags([...leadArgs, ...after.slice(0, g.stop)], pm);
      const dir = pm === 'pnpm' && ef.workspaceRoot ? wsRoot(projectDir()) : projectDir();
      return eachProjectWith(ef, dir, (p) => npm.runLocal(p.dir, args, { anyCommand: true }));
    }
    case 'shell': {
      // bun exec "<shell script>"
      const dir = projectDir();
      const script = after.join(' ');
      return ctx.run(['/bin/sh', '-c', script], { env: npm.scriptEnv(dir, readJsonFile(ctx.vfs, path.join(dir, 'package.json')) ?? {}, 'exec', script), cwd: ctx.cwd });
    }
    case 'create':
    case 'init': {
      if (!f.rest.length || (op === 'init' && pm !== 'npm')) {
        if (op === 'create') {
          ctx.err(pm === 'pnpm' ? ' ERR_PNPM_MISSING_ARGS  Missing the template package name.\n' : `${pm} create requires a package name\n`);
          return 1;
        }
        return npm.init(baseDir, f);
      }
      // the create-* package gets everything after its name, flags included
      const at = after.indexOf(f.rest[0]);
      const init = f.rest[0];
      const iargs = pm === 'npm' ? [...f.rest.slice(1), ...f.passthrough] : after.slice(at + 1).filter((a, i) => !(i === 0 && a === '--'));
      let pkgName: string;
      if (init.startsWith('@')) {
        const [scope, n] = init.split('/');
        pkgName = n ? `${scope}/create-${n.replace(/@.*$/, '')}` : `${scope}/create`;
      } else pkgName = `create-${init}`;
      const version = !init.startsWith('@') && init.includes('@') ? '@' + init.split('@')[1] : '';
      return npm.exec(baseDir, [pkgName.replace(/@[^/]*$/, '') + version, ...iargs], { ...f, packages: [] }, { forceInstall: true });
    }
    case 'view':
      return npm.view(baseDir, f.rest, f);
    case 'ls':
    case 'why':
      return npm.ls(f.global ? GLOBAL_DIR : projectDir());
    case 'reinstall':
      return npm.install(wsRoot(projectDir()), f);
    case 'get':
    case 'set':
    case 'config': {
      const rest = op === 'config' ? f.rest : [op, ...f.rest];
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
      // global packages live in the .ov-global project's node_modules
      ctx.out((f.global ? path.join(GLOBAL_DIR, 'node_modules') : path.join(projectDir(), 'node_modules')) + '\n');
      return 0;
    case 'bin':
      ctx.out((f.global ? '/usr/local/bin' : path.join(projectDir(), 'node_modules/.bin')) + '\n');
      return 0;
    case 'pkg': {
      const dir = projectDir();
      const pjPath = path.join(dir, 'package.json');
      const pkg = readJsonFile(ctx.vfs, pjPath) ?? {};
      if (f.rest[0] === 'get') {
        const v = f.rest[1] ? f.rest[1].split('.').reduce((o: any, k) => o?.[k], pkg) : pkg;
        ctx.out(JSON.stringify(v, null, 2) + '\n');
        return 0;
      }
      if (f.rest[0] === 'set') {
        for (const kv of f.rest.slice(1)) {
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
      if (f.rest[0] === 'clean' || f.rest[0] === 'clear' || f.rest[0] === 'verify' || f.rest[0] === 'rm') {
        if (typeof caches !== 'undefined') await caches.delete('openvessel-npm-v1').catch(() => {});
        ctx.out('Cache cleaned\n');
      }
      return 0;
    case 'help':
      if (pm === 'npm') {
        ctx.out(`npm <command>\n\nUsage:\n\nnpm install        install all the dependencies in your project\nnpm install <foo>  add the <foo> dependency to your project\nnpm test           run this project's tests\nnpm run <foo>      run the script named <foo>\n\nnpm@${NPM_VERSION}\n`);
      } else ctx.out(USAGE(pm));
      return 0;
    case 'global': {
      // yarn global add|remove|bin|list
      const [sub, ...rest] = after;
      if (sub === 'add') return main(ctx, pm, [...leadArgs, 'add', '-g', ...rest]);
      if (sub === 'remove') return main(ctx, pm, [...leadArgs, 'remove', '-g', ...rest]);
      if (sub === 'bin') return main(ctx, pm, [...leadArgs, 'bin', '-g']);
      if (sub === 'list') return npm.ls(GLOBAL_DIR);
      ctx.err(`yarn global ${sub ?? ''} is not supported in OpenVessel\n`);
      return 1;
    }
    case 'workspace': {
      // yarn workspace <name> <command…>: the command runs as if started in that workspace
      const [name, ...rest] = after;
      const root = wsRoot(projectDir());
      const ws = listWorkspaces(ctx.vfs, root).find((w) => w.name === name);
      if (!ws) {
        ctx.err(`error Unknown workspace "${name ?? ''}".\n`);
        return 1;
      }
      return main(ctx, pm, [...leadArgs, '--cwd', ws.dir, ...rest]);
    }
    case 'workspaces': {
      // yarn workspaces run <command…> | info
      const [sub, ...rest] = after;
      const root = wsRoot(projectDir());
      const list = listWorkspaces(ctx.vfs, root);
      if (sub === 'run') {
        for (const ws of list) {
          const code = await main(ctx, pm, [...leadArgs, '--cwd', ws.dir, 'run', ...rest]);
          if (code) return code;
        }
        return 0;
      }
      if (sub === 'info') {
        const names = new Set(list.map((w) => w.name));
        const info: Record<string, unknown> = {};
        for (const w of list) {
          const deps = Object.keys({ ...w.pkg.dependencies, ...w.pkg.devDependencies, ...w.pkg.optionalDependencies }).filter((n) => names.has(n));
          info[w.name] = { location: path.relative(root, w.dir), workspaceDependencies: deps, mismatchedWorkspaceDependencies: [] };
        }
        ctx.out(JSON.stringify(info, null, 2) + '\n');
        return 0;
      }
      ctx.err(`yarn workspaces ${sub ?? ''} is not supported in OpenVessel\n`);
      return 1;
    }
    case 'bunpm': {
      // bun pm ls|bin|cache|view
      const [sub, ...rest] = after;
      if (sub === 'ls') return main(ctx, 'npm', [...leadArgs, 'ls', ...rest]);
      if (sub === 'bin') {
        ctx.out((rest.includes('-g') ? '/usr/local/bin' : path.join(projectDir(), 'node_modules/.bin')) + '\n');
        return 0;
      }
      if (sub === 'cache') {
        if (rest[0] === 'rm') {
          if (typeof caches !== 'undefined') await caches.delete('openvessel-npm-v1').catch(() => {});
          ctx.out('Cache cleaned\n');
        }
        return 0;
      }
      if (sub === 'view') return npm.view(baseDir, rest, parseFlags(rest, pm));
      ctx.err(`bun pm ${sub ?? ''} is not supported in OpenVessel\n`);
      return 1;
    }
    case 'unsupported0':
    case 'unsupported':
      ctx.err(`${pm} ${cmd} is not supported in OpenVessel\n`);
      return op === 'unsupported0' ? 0 : 1;
  }
}

/**
 * npx: the options before the command name are npm's, the rest belongs to the command, so like npm's
 * npx-cli an `--` goes after the command name.
 */
function npxArgv(args: string[]): string[] {
  const g = parseFlags(args, 'npm', { exec: true, stopAtPositional: true });
  if (g.dashDash || g.stop >= args.length) return ['exec', ...args];
  return ['exec', ...args.slice(0, g.stop), '--', ...args.slice(g.stop)];
}

export function installNpm(kernel: Kernel) {
  const front = (pm: Pm) => async (ctx: ProgramContext) => main(ctx, pm, ctx.argv.slice(1));
  kernel.registerProgram('npm', front('npm'), ['/usr/bin']);
  kernel.registerProgram('pnpm', front('pnpm'), ['/usr/bin']);
  kernel.registerProgram('yarn', front('yarn'), ['/usr/bin']);
  kernel.registerProgram('bun', front('bun'), ['/usr/bin']);
  kernel.registerProgram('npx', async (ctx) => main(ctx, 'npm', npxArgv(ctx.argv.slice(1))), ['/usr/bin']);
  kernel.registerProgram('pnpx', async (ctx) => main(ctx, 'pnpm', ['dlx', ...ctx.argv.slice(1)]), ['/usr/bin']);
  kernel.registerProgram('bunx', async (ctx) => main(ctx, 'bun', ['x', ...ctx.argv.slice(1)]), ['/usr/bin']);
  kernel.registerProgram('corepack', async (ctx) => {
    ctx.err('corepack: package managers are built into OpenVessel; nothing to do\n');
    return 0;
  }, ['/usr/bin']);
}
