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
  /** Set when the command line is invalid: printed as `node: <error>` with exit code 9. */
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
  if (al) return { names: al.flatMap((a) => (a !== name && ALIASES.has(a) ? ALIASES.get(a)! : [a])), value, consumedNext: false };
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
      if (/^--(max-old-space-size|max-semi-space-size|stack-size|expose-gc|harmony|js-|allow-natives-syntax|max-http-header-size)/.test(name) || name.startsWith('--v8-') || name.startsWith('--no-')) return consumed;
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
  return { execArgv, argv: rest, values };
}
