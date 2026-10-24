// Node's command-line parser (node_options.cc), driven by the option table dumped from real Node.

import proc from '../node/data/process.json';

const T = proc.types as Record<string, number>;
const INFO = new Map<string, { type: number; envVarSettings: number; defaultIsTrue: boolean }>(proc.optionInfo.options as any);
const ALIASES = new Map<string, string[]>(proc.optionInfo.aliases as any);

export interface ParsedCommandLine {
  /** Node options (what process.execArgv shows). */
  execArgv: string[];
  /** process.argv before patching: [argv0, script?, ...args] */
  argv: string[];
  values: Record<string, unknown>;
  /** Set when the command line is invalid: each line printed as `node: <error>`, exit code 9. */
  error?: string;
}

export function defaultOptionValues(): Record<string, unknown> {
  return structuredClone(proc.optionValues as Record<string, unknown>);
}

function expand(arg: string, next: string | undefined): { names: string[]; value?: string; consumedNext: boolean } {
  let name = arg;
  let value: string | undefined;
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) {
    name = arg.slice(0, eq);
    value = arg.slice(eq + 1);
  }
  // aliases like "--inspect=" (only with a value) or "--print <arg>" (only followed by an argument)
  if (value !== undefined && ALIASES.has(name + '=')) return { names: ALIASES.get(name + '=')!, value, consumedNext: false };
  if (ALIASES.has(name + ' <arg>') && next !== undefined && !next.startsWith('-') && value === undefined) {
    return { names: ALIASES.get(name + ' <arg>')!.flatMap((a) => ALIASES.get(a) ?? [a]), consumedNext: false };
  }
  const al = ALIASES.get(name);
  if (al) {
    // aliases chain: -p → --print, and "--print <arg>" → -pe → --print --eval
    if (al.length === 1 && al[0] !== name && (ALIASES.has(al[0]) || ALIASES.has(al[0] + ' <arg>'))) return expand(al[0] + (value !== undefined ? `=${value}` : ''), next);
    return { names: al.flatMap((a) => (a !== name && ALIASES.has(a) ? ALIASES.get(a)! : [a])), value, consumedNext: false };
  }
  return { names: [name], value, consumedNext: false };
}

/** Applies one option. Returns how many following args it consumed, or an error string. */
function apply(values: Record<string, unknown>, arg: string, next: string | undefined, fromEnv: boolean): number | string {
  const { names, value } = expand(arg, next);
  let consumed = 0;
  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    let negated = false;
    let info = INFO.get(name);
    if (!info && name.startsWith('--no-') && INFO.has('--' + name.slice(5))) {
      negated = true;
      name = '--' + name.slice(5);
      info = INFO.get(name);
    }
    if (!info) {
      // V8 flags are passed through to V8 in Node; here they are accepted and ignored
      if (/^--(max-old-space-size|max-semi-space-size|stack-size|expose-gc|harmony|js-|allow-natives-syntax|max-http-header-size|enable-sharedarraybuffer-per-context)/.test(name) || name.startsWith('--v8-') || name.startsWith('--no-')) return consumed;
      return `bad option: ${arg}`;
    }
    if (fromEnv && info.envVarSettings === proc.envSettings.kDisallowedInEnvvar) return `${name} is not allowed in NODE_OPTIONS`;
    const isLast = i === names.length - 1;
    switch (info.type) {
      case T.kNoOp:
      case T.kV8Option:
        break;
      case T.kBoolean:
        values[name] = !negated;
        if (('--no-' + name.slice(2)) in values) values['--no-' + name.slice(2)] = negated;
        if (!negated) for (const t of IMPLICATIONS.get(name) ?? []) values[t] = true;
        break;
      default: {
        let v = isLast ? value : undefined;
        if (v === undefined && isLast) {
          if (next === undefined) return `${arg} requires an argument`;
          v = next;
          consumed = 1;
        }
        if (v === undefined) break;
        if (info.type === T.kInteger || info.type === T.kUInteger) values[name] = Number(v);
        else if (info.type === T.kStringList) values[name] = [...((values[name] as string[]) ?? []), v];
        else values[name] = v;
      }
    }
  }
  return consumed;
}

function splitNodeOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Options that take a value as the next argument even without "=". */
function takesValue(arg: string): boolean {
  if (arg.includes('=')) return false;
  const { names } = expand(arg, 'x');
  const last = names[names.length - 1];
  const info = INFO.get(last);
  return !!info && info.type !== T.kBoolean && info.type !== T.kNoOp && info.type !== T.kV8Option;
}

export function parseCommandLine(argv: string[], nodeOptions = ''): ParsedCommandLine {
  const values = defaultOptionValues();
  const execArgv: string[] = [];
  const rest: string[] = [argv[0] ?? 'node'];
  // NODE_OPTIONS first, then the command line (which wins)
  const envArgs = splitNodeOptions(nodeOptions);
  for (let i = 0; i < envArgs.length; i++) {
    const r = apply(values, envArgs[i], envArgs[i + 1], true);
    if (typeof r === 'string') return { execArgv, argv: rest, values, error: r };
    i += r;
  }
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-' || !a.startsWith('-')) break;
    const next = argv[i + 1];
    const r = apply(values, a, takesValue(a) ? next : undefined, false);
    if (typeof r === 'string') return { execArgv, argv: rest, values, error: r };
    execArgv.push(a);
    if (r) execArgv.push(argv[i + 1]);
    i += r;
  }
  rest.push(...argv.slice(i));
  const errors = checkOptions(values);
  if (errors.length) return { execArgv, argv: rest, values, error: errors.join('\n') };
  return { execArgv, argv: rest, values };
}

/**
 * node_options.cc Implies(): options that switch others on when given (not part of the dumped
 * option table). A later option on the command line still overrides them.
 */
const IMPLICATIONS = new Map<string, string[]>([['--experimental-transform-types', ['--experimental-strip-types', '--enable-source-maps']]]);

const isPowerOf2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** PerProcessOptions::CheckOptions (the checks that apply in a browser). */
function checkOptions(values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const heap = Number(values['--secure-heap'] ?? 0);
  const heapMin = Number(values['--secure-heap-min'] ?? 2);
  if (heap && !isPowerOf2(heap)) errors.push('--secure-heap must be a power of 2');
  if (!isPowerOf2(heapMin)) errors.push('--secure-heap-min must be a power of 2');
  return errors;
}

/** Options of PerProcessOptionsParser (node_options.cc): a worker thread can't take these. */
const PER_PROCESS = new Set(
  '--completion-bash --debug-arraybuffer-allocations --disable-proto --enable-fips --experimental-sea-config --force-fips --help --icu-data-dir --node-memory-debug --node-snapshot --openssl-config --openssl-legacy-provider --openssl-shared-config --report-compact --report-dir --report-directory --report-filename --report-on-fatalerror --run --secure-heap --secure-heap-min --security-revert --security-reverts --snapshot-blob --title --tls-cipher-list --trace-event-categories --trace-event-file-pattern --trace-events-enabled --trace-sigint --use-bundled-ca --use-largepages --use-openssl-ca --use-system-ca --v8-options --v8-pool-size --zero-fill-buffers -h -v'.split(' '),
);

/** Worker::New's checks of a thread's execArgv (or of the NODE_OPTIONS in its env): the errors, or null. */
export function workerOptionErrors(args: string[] | string, fromEnv: boolean): string[] | null {
  const list = typeof args === 'string' ? splitNodeOptions(args) : args;
  const values = defaultOptionValues();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('-') || a === '-' || a === '--') continue;
    if (PER_PROCESS.has(a.split('=')[0])) return [a];
    const r = apply(values, a, takesValue(a) ? list[i + 1] : undefined, fromEnv);
    if (typeof r === 'string') return [r.startsWith('bad option: ') ? a : r];
    i += r;
  }
  return null;
}
