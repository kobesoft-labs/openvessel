// Process-wide state of the ported Node.js runtime (one per process or worker-thread Worker).

export interface InitMsg {
  t: 'init';
  kind: 'main' | 'thread';
  pid: number;
  ppid: number;
  tid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  sab: SharedArrayBuffer;
  ttys: Record<number, { cols: number; rows: number } | null>;
  hostname: string;
  // worker threads
  file?: string;
  eval?: boolean;
  evalType?: string;
  execArgv?: string[];
  workerData?: unknown;
  envData?: [unknown, unknown][];
  port?: MessagePort;
  name?: string;
}

/** Filled in during bootstrap; bindings read it lazily. */
export const S = {
  init: null as unknown as InitMsg,
  isMainThread: true,
  /** The `process` object handed to Node's bootstrap. */
  process: null as any,
  primordials: null as any,
  privateSymbols: {} as Record<string, symbol>,
  perIsolateSymbols: {} as Record<string, symbol>,
  /** Node's internal require (set by builtins.setInternalLoaders). */
  requireBuiltin: null as unknown as (id: string) => any,
  internalBinding: null as unknown as (name: string) => any,
  /** process.execArgv / argv as parsed from the command line. */
  execArgv: [] as string[],
  /** -e/-p/--eval/--print was given. */
  hasEval: false,
  argv: [] as string[],
  /** The origin serving the runtime (for ESM URLs). */
  runtimeOrigin: '',
  cwd: '/',
  exiting: false,
  /** Set by the task_queue binding; called from the Worker's rejection events. */
  onUnhandledRejection: null as null | ((promise: Promise<unknown>, reason: unknown) => void),
  onRejectionHandled: null as null | ((promise: Promise<unknown>) => void),
  /** errors.setPrepareStackTraceCallback / setEnhanceStackForFatalException */
  prepareStackTrace: null as null | ((global: unknown, error: Error, trace: unknown[]) => string),
  enhanceStack: null as null | { before: (e: Error) => string; after: (e: Error) => string },
  /** internalBinding('builtins'), built at boot from the bundled lib. */
  builtinsBinding: null as any,
  /** Parsed CLI option values (internalBinding('options').getCLIOptionsValues()). */
  optionValues: {} as Record<string, unknown>,
  /** What the per_context scripts exported (DOMException, emitMessage, …). */
  perContextExports: {} as Record<string, any>,
  /** Handlers for messages the kernel posts to this worker, by message type. */
  kernelHandlers: new Map<string, (msg: any) => void>(),
};

/** Lazily requires a Node builtin (only valid after realm bootstrap). */
export function lib<T = any>(id: string): T {
  return S.requireBuiltin(id);
}
