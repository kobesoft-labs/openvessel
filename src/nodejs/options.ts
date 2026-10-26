// Node's command-line parser (node_options.cc), driven by the option table dumped from real Node.

import proc from '../node/data/process.json';
import v8Options from './data/v8-options.json';

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
  /** What V8 printed about a flag it rejected (before `error`, as is). */
  v8Error?: string;
}

/** `node --v8-options`: V8's help text (dumped from real Node). */
export const v8Help: string = v8Options.text;

let v8Flags: Map<string, string> | null = null;
/** The type of a V8 flag (bool, int, string…), from V8's own list. */
function v8FlagType(name: string): string | undefined {
  if (!v8Flags) {
    v8Flags = new Map();
    for (const m of v8Help.matchAll(/^ {2}(--\S+) .*\n {8}type: (\S+)/gm)) v8Flags.set(m[1], m[2]);
  }
  return v8Flags.get(name);
}

/**
 * V8's FlagList::SetFlagsFromCommandLine for an argument Node passes on: null if V8 takes it, else
 * what V8 prints. Node passes the argument alone, so a flag that needs a value has it after '='.
 */
function v8Check(arg: string, name: string, value: string | undefined): string | null | undefined {
  let type = v8FlagType(name);
  let negated = false;
  if (!type && name.startsWith('--no-')) {
    type = v8FlagType('--' + name.slice(5));
    negated = true;
  }
  if (!type) return undefined;
  const bool = type === 'bool' || type === 'maybe_bool';
  let ok: boolean;
  if (bool) ok = value === undefined;
  else if (negated || value === undefined) ok = false;
  else if (type === 'int') ok = /^[-+]?\d+$/.test(value);
  else if (type === 'uint' || type === 'uint64' || type === 'size_t') ok = /^\+?\d+$/.test(value);
  else if (type === 'float') ok = value.trim() !== '' && !Number.isNaN(Number(value));
  else ok = true;
  if (ok) return null;
  return `Error: illegal value for flag ${arg} of type ${type}\n${bool ? 'To set or unset a boolean flag, use --flag or --no-flag.\n' : ''}Try --help for options\n`;
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
  // Node normalizes '_' to '-' in option names (--stack_trace_limit, --expose_gc)
  if (name.startsWith('--')) name = '--' + name.slice(2).replaceAll('_', '-');
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

/** Applies one option. Returns how many following args it consumed, or an error. */
function apply(values: Record<string, unknown>, arg: string, next: string | undefined, fromEnv: boolean): number | string | { v8: string; error: string } {
  const { names, value } = expand(arg, next);
  let consumed = 0;
  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    // an alias that ends option parsing (--prof-process → --prof-process --)
    if (name === '--') continue;
    let negated = false;
    let info = INFO.get(name);
    if (!info && name.startsWith('--no-') && INFO.has('--' + name.slice(5))) {
      negated = true;
      name = '--' + name.slice(5);
      info = INFO.get(name);
    }
    if (!info) {
      // Node hands what it doesn't know to V8, which takes its own flags (they have no effect
      // here) and rejects the rest; NODE_OPTIONS takes only the options in Node's table
      if (fromEnv) return `${name} is not allowed in NODE_OPTIONS`;
      const v8 = v8Check(arg, name, value);
      if (v8 === null) return consumed;
      return v8 ? { v8, error: `bad option: ${arg}` } : `bad option: ${arg}`;
    }
    if (fromEnv && info.envVarSettings === proc.envSettings.kDisallowedInEnvvar) return `${name} is not allowed in NODE_OPTIONS`;
    // options V8 reads too: V8 checks the value
    if (info.type === T.kV8Option || name === '--stack-trace-limit') {
      const v8 = v8Check(arg, negated ? '--no-' + name.slice(2) : name, isLastValue(names, i, value));
      if (v8) return { v8, error: `bad option: ${arg}` };
    }
    const isLast = i === names.length - 1;
    switch (info.type) {
      case T.kNoOp:
      case T.kV8Option:
        break;
      case T.kBoolean:
        values[name] = !negated;
        if (('--no-' + name.slice(2)) in values) values['--no-' + name.slice(2)] = negated;
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
    if (!negated && info.type !== T.kNoOp && info.type !== T.kV8Option) for (const t of IMPLICATIONS.get(name) ?? []) values[t] = true;
  }
  return consumed;
}

const isLastValue = (names: string[], i: number, value: string | undefined) => (i === names.length - 1 ? value : undefined);

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
    if (typeof r === 'object') return { execArgv, argv: rest, values, error: r.error, v8Error: r.v8 };
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
    if (typeof r === 'object') return { execArgv, argv: rest, values, error: r.error, v8Error: r.v8 };
    execArgv.push(a);
    if (r) execArgv.push(argv[i + 1]);
    i += r;
    // an alias that expands to "... --": the rest are arguments
    if (expand(a, undefined).names.includes('--')) {
      i++;
      break;
    }
  }
  rest.push(...argv.slice(i));
  const errors = checkOptions(values, rest);
  if (errors.length) return { execArgv, argv: rest, values, error: errors.join('\n') };
  return { execArgv, argv: rest, values };
}

/**
 * node_options.cc Implies(): options that switch others on when given (not part of the dumped
 * option table). A later option on the command line still overrides them.
 */
const IMPLICATIONS = new Map<string, string[]>([
  ['--inspect-brk', ['--inspect']],
  ['--inspect-brk-node', ['--inspect']],
  ['--inspect-wait', ['--inspect']],
  ['--env-file', ['[has_env_file_string]']],
  ['--env-file-if-exists', ['[has_env_file_string]']],
  ['--trace-env-js-stack', ['--trace-env']],
  ['--trace-env-native-stack', ['--trace-env']],
  ['--watch-path', ['--watch']],
  ['--eval', ['[has_eval_string]']],
  ['--experimental-strip-types', ['--experimental-detect-module']],
  ['--experimental-transform-types', ['--experimental-strip-types', '--experimental-detect-module', '--enable-source-maps']],
  ['--report-signal', ['--report-on-signal']],
  ['--node-memory-debug', ['--debug-arraybuffer-allocations', '--verify-base-objects']],
]);

const isPowerOf2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** PerProcessOptions::CheckOptions and EnvironmentOptions::CheckOptions (the checks that apply in a browser). */
function checkOptions(values: Record<string, unknown>, argv: string[]): string[] {
  const errors: string[] = [];
  if (values['--watch']) {
    if (values['--check']) errors.push('either --watch or --check can be used, not both');
    else if (values['[has_eval_string]']) errors.push('either --watch or --eval can be used, not both');
    else if (values['--interactive']) errors.push('either --watch or --interactive can be used, not both');
    else if (values['--test-force-exit']) errors.push('either --watch or --test-force-exit can be used, not both');
    else if (!values['--test'] && !argv[1]) errors.push('--watch requires specifying a file');
  }
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
    if (typeof r === 'object') return [a];
    i += r;
  }
  return null;
}
