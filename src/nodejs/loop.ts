// The libuv side of Node, in a Web Worker: handle/request accounting, timers, immediates,
// the callback scope that runs process.nextTick work, and process exit.

import { S } from './state.ts';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const perfNow = performance.now.bind(performance);

// -----------------------------------------------------------------------------
// macrotasks (faster than setTimeout(0))

const channel = new MessageChannel();
const macroQueue: (() => void)[] = [];
channel.port1.onmessage = () => {
  const fn = macroQueue.shift();
  fn?.();
};
// (under Node, e.g. in unit tests, the port must not keep the process alive)
(channel.port1 as any).unref?.();
export function macrotask(fn: () => void) {
  macroQueue.push(fn);
  channel.port2.postMessage(0);
}

// -----------------------------------------------------------------------------
// handles and requests

/** Anything that can keep the loop alive (uv_handle_t). */
export interface LoopHandle {
  /** uv_is_active */
  active: boolean;
  /** uv_has_ref */
  refed: boolean;
  /** shown by process.getActiveResourcesInfo() */
  resourceName?: string;
  /** the JS object process._getActiveHandles() reports (HandleWrap::GetOwner) */
  owner?: object;
}

export const handles = new Set<LoopHandle>();
let pendingReqs = 0;
const reqNames: string[] = [];
/** requests in flight (ReqWrap::GetOwner), for process._getActiveRequests() */
const reqs = new Set<{ name: string; owner?: object }>();

export function addHandle(h: LoopHandle) {
  handles.add(h);
}
export function removeHandle(h: LoopHandle) {
  handles.delete(h);
  scheduleAliveCheck();
}

/** A request (uv_req_t) in flight keeps the loop alive until done(). */
export function startReq(name = 'FSReqCallback', owner?: object): () => void {
  pendingReqs++;
  reqNames.push(name);
  const req = { name, owner };
  reqs.add(req);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pendingReqs--;
    reqs.delete(req);
    const i = reqNames.indexOf(name);
    if (i >= 0) reqNames.splice(i, 1);
    scheduleAliveCheck();
  };
}

/** Keeps the loop alive while native browser async work (WebAssembly.compile, crypto.subtle…) is pending. */
export function track<T>(p: Promise<T>): Promise<T> {
  const done = startReq('Promise');
  return p.finally(done);
}

/** GetActiveResourcesInfo: requests, ref'd handles, then one entry per ref'd Timeout and Immediate. */
export function activeResources(): string[] {
  const out = reqNames.filter((n) => n !== 'HandleClose'); // uv_close is not a request
  for (const h of handles) if (h.refed) out.push(h.resourceName ?? 'Handle');
  const timeouts = timeoutInfo ? timeoutInfo[0] : timer.id !== null && timer.refed ? 1 : 0;
  for (let i = 0; i < timeouts; i++) out.push('Timeout');
  const immediates = immediateInfo ? immediateInfo[kRefCount] : 0;
  for (let i = 0; i < immediates; i++) out.push('Immediate');
  return out;
}

/** process._getActiveHandles(): owners of the ref'd handles. */
export function activeHandleOwners(): object[] {
  const out: object[] = [];
  for (const h of handles) if (h.refed && h.owner) out.push(h.owner);
  return out;
}

/** process._getActiveRequests(): owners of requests in flight. */
export function activeRequestOwners(): object[] {
  const out: object[] = [];
  // closing a handle is not a request in libuv
  for (const r of reqs) if (r.name !== 'HandleClose') out.push(r.owner ?? {});
  return out;
}

let timeoutInfo: Int32Array | null = null;
export function setTimeoutInfo(info: Int32Array) {
  timeoutInfo = info;
}

// -----------------------------------------------------------------------------
// callback scope (InternalCallbackScope)

let tickCallback: (() => void) | null = null;
let tickInfo: Uint8Array | null = null;
const kHasTickScheduled = 0;
const kHasRejectionToWarn = 1;
let inTicks = false;
let scopeDepth = 0;
/** set when a scope() call ended in an uncaught exception */
let scopeThrew = false;
/** calling a phase's callback again after an uncaught exception: no tick processing in between */
let retrying = false;

export function setTickCallback(fn: () => void, info: Uint8Array) {
  tickCallback = fn;
  tickInfo = info;
}

/** Runs pending nextTicks and promise-rejection processing if any are due. */
export function runTicks() {
  if (!tickCallback || !tickInfo || inTicks) return;
  if (tickInfo[kHasTickScheduled] !== 1 && tickInfo[kHasRejectionToWarn] !== 1) return;
  inTicks = true;
  try {
    tickCallback.call(S.process);
  } catch (e) {
    inTicks = false;
    triggerUncaughtException(e, false);
    return;
  } finally {
    inTicks = false;
  }
}

let tickTaskQueued = false;
/**
 * nextTick was called outside a callback scope (e.g. from a promise job). Node runs such ticks
 * only once the microtask queue has drained (runMicrotasks() inside processTicksAndRejections, or
 * the checkpoint when a callback scope closes), so: a task, not a microtask. Any callback that
 * gets in first runs them before itself (see scope()).
 */
export function onTickScheduled() {
  if (inTicks || scopeDepth > 0 || tickTaskQueued) return;
  tickTaskQueued = true;
  macrotask(() => {
    tickTaskQueued = false;
    if (scopeDepth === 0) {
      runTicks();
      afterCallback();
    }
  });
}

/** Calls a JS entry point the way libuv → C++ → JS would, then drains ticks. */
export function scope<T>(fn: (...a: any[]) => T, thisArg?: unknown, ...args: any[]): T | undefined {
  // ticks left by promise jobs come before the next callback from the loop
  if (scopeDepth === 0 && tickTaskQueued && !retrying) runTicks();
  scopeDepth++;
  let r: T | undefined;
  try {
    r = fn.apply(thisArg, args);
  } catch (e) {
    scopeDepth--;
    scopeThrew = true;
    triggerUncaughtException(e, false);
    afterCallback();
    return undefined;
  }
  scopeDepth--;
  if (scopeDepth === 0) {
    runTicks();
    afterCallback();
  }
  return r;
}

function afterCallback() {
  scheduleImmediates();
  scheduleAliveCheck();
}

// -----------------------------------------------------------------------------
// timers (one uv_timer for all of Node's JS timers)

let processTimers: ((now: number) => number) | null = null;
let processImmediate: (() => void) | null = null;
const loopStart = perfNow();
const timer = { id: null as ReturnType<typeof setTimeout> | null, refed: true, due: 0 };

export function setupTimers(immediate: () => void, timers: (now: number) => number) {
  processImmediate = immediate;
  processTimers = timers;
}

/** uv_now(): milliseconds since the loop started. */
export function now(): number {
  return Math.floor(perfNow() - loopStart) + 1;
}

export function scheduleTimer(ms: number) {
  if (timer.id !== null) nativeClearTimeout(timer.id);
  const delay = Math.max(1, ms);
  timer.due = now() + delay;
  timer.id = nativeSetTimeout(fireTimers, delay);
}

export function toggleTimerRef(refed: boolean) {
  timer.refed = refed;
  scheduleAliveCheck();
}

function fireTimers() {
  timer.id = null;
  if (!processTimers || S.exiting) return;
  const t = now();
  // Environment::RunTimers calls processTimers again after an uncaught exception: the rest of
  // the due timers still run
  let next: number;
  do {
    scopeThrew = false;
    next = scope(processTimers, S.process, t) ?? 0;
    retrying = true;
  } while (scopeThrew && !S.exiting);
  retrying = false;
  if (next !== 0 && timer.id === null) {
    const abs = Math.abs(next);
    timer.refed = next > 0;
    scheduleTimer(Math.max(1, abs - now()));
  }
  scheduleAliveCheck();
}

// -----------------------------------------------------------------------------
// immediates (the check phase)

let immediateInfo: Uint32Array | null = null;
const kCount = 0;
const kRefCount = 1;
const kHasOutstanding = 2;
let immediateQueued = false;

export function setImmediateInfo(info: Uint32Array) {
  immediateInfo = info;
}

export function toggleImmediateRef(refed: boolean) {
  // lib refs a new Immediate before counting it (kCount is still 0 here). Inside a callback scope
  // afterCallback looks again (keeping immediates behind the browser's unhandledrejection task);
  // outside one (e.g. after a top-level await) nothing would: take the turn now
  if (refed && scopeDepth === 0) scheduleImmediates(true);
  scheduleAliveCheck();
}

function scheduleImmediates(force = false) {
  if (immediateQueued || !immediateInfo || !processImmediate) return;
  if (!force && immediateInfo[kCount] === 0 && immediateInfo[kHasOutstanding] === 0) return;
  immediateQueued = true;
  macrotask(() => {
    immediateQueued = false;
    if (S.exiting || !immediateInfo) return;
    if (immediateInfo[kCount] === 0 && immediateInfo[kHasOutstanding] === 0) return;
    // only unref'd immediates and nothing else alive: the loop ends without running them
    if (started && immediateInfo[kRefCount] === 0 && !alive()) return scheduleAliveCheck();
    // Environment::CheckImmediate: after an uncaught exception, the rest of the queue
    // (kHasOutstanding) runs in the same check phase
    do {
      scopeThrew = false;
      scope(processImmediate!, S.process);
      retrying = true;
    } while (scopeThrew && immediateInfo[kHasOutstanding] && !S.exiting);
    retrying = false;
  });
}

// -----------------------------------------------------------------------------
// liveness and exit

export function alive(): boolean {
  if (pendingReqs > 0) return true;
  if (timer.id !== null && timer.refed) return true;
  if (immediateInfo && immediateInfo[kRefCount] > 0) return true;
  for (const h of handles) if (h.active && h.refed) return true;
  return false;
}

let checkQueued = false;
let checkGen = 0;
export function scheduleAliveCheck() {
  checkGen++;
  if (checkQueued || S.exiting) return;
  checkQueued = true;
  const gen = checkGen;
  // a macrotask and a short timeout, so work the browser finishes on its own (blob reads, …) can land
  macrotask(() => {
    nativeSetTimeout(() => {
      checkQueued = false;
      if (S.exiting) return;
      if (gen !== checkGen) return scheduleAliveCheck();
      if (!alive()) onLoopEmpty();
    }, 2);
  });
}

let started = false;
/** Called once the main script has run (uv_run starts). */
export function startLoop() {
  started = true;
  scheduleImmediates();
  scheduleAliveCheck();
}

function exitInfo(): Int32Array {
  return S.process[S.privateSymbols.exit_info_private_symbol];
}

export function currentExitCode(): number {
  const f = exitInfo();
  return f[2] /* kHasExitCode */ ? f[1] /* kExitCode */ : 0;
}

function onLoopEmpty() {
  if (!started || S.exiting) return;
  // EmitProcessBeforeExit
  if (!exitInfo()[0]) {
    scope(() => S.process.emit('beforeExit', currentExitCode()));
    if (alive()) return;
  }
  // the loop ran dry while a module's top-level await is still pending: kUnsettledTopLevelAwait
  const f = exitInfo();
  const stalled = !f[0] && !f[2] ? S.unsettledTopLevelAwait?.() : null;
  if (stalled) {
    f[1] = 13;
    f[2] = 1;
    printStalled(stalled);
  }
  emitProcessExit();
}

function printStalled(s: { url: string; line: number; source: string }) {
  const text = s.source.split('\n')[s.line - 1] ?? '';
  const col = Math.max(0, text.search(/\bawait\b/));
  try {
    S.process._rawDebug?.(`Warning: Detected unsettled top-level await at ${s.url}:${s.line}\n${text}\n${' '.repeat(col)}^\n\n`);
  } catch {}
}

/** EmitProcessExitInternal: 'exit' event, then terminate with process.exitCode. */
export function emitProcessExit(): never {
  const f = exitInfo();
  if (!f[0]) {
    f[0] = 1; // kExiting
    try {
      S.process.emit('exit', currentExitCode());
    } catch (e) {
      triggerUncaughtException(e, false);
    }
  }
  return reallyExit(currentExitCode());
}

let exitHook: (code: number) => never = () => {
  throw new Error('exit hook not installed');
};
export function setExitHook(fn: (code: number) => never) {
  exitHook = fn;
}
export function reallyExit(code: number): never {
  S.exiting = true;
  return exitHook(code | 0);
}

// -----------------------------------------------------------------------------
// uncaught exceptions (node::errors::TriggerUncaughtException)

let printFatal: (err: unknown) => void = (e) => console.error(e);
export function setFatalPrinter(fn: (err: unknown) => void) {
  printFatal = fn;
}

let inFatal = false;
export function triggerUncaughtException(err: unknown, fromPromise: boolean) {
  if (S.exiting) return;
  const fe = S.process?._fatalException;
  if (inFatal || typeof fe !== 'function') {
    printFatal(err);
    // kInvalidFatalExceptionMonkeyPatching when process._fatalException was replaced
    reallyExit(inFatal || !S.process ? 7 : 6);
  }
  inFatal = true;
  let handled = false;
  try {
    handled = fe.call(S.process, err, fromPromise);
  } catch (e2) {
    inFatal = false;
    printFatal(e2);
    reallyExit(7); // kExceptionInFatalExceptionHandler
  }
  inFatal = false;
  if (handled) return;
  printFatal(err);
  const f = exitInfo();
  reallyExit(f[2] ? f[1] : 1); // env->exit_code(kGenericUserError): an exit handler may have set it
}
