// Event loop bookkeeping: Node exits when no ref'd handles remain.

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

let refs = 0;
let onIdle: (() => void) | null = null;
let checkScheduled = false;
let idleGeneration = 0;

const channel = new MessageChannel();
const macrotasks: (() => void)[] = [];
channel.port1.onmessage = () => {
  const fn = macrotasks.shift();
  fn?.();
};

/** Runs fn as a macrotask (after microtasks), faster than setTimeout(0). */
export function macrotask(fn: () => void) {
  macrotasks.push(fn);
  channel.port2.postMessage(0);
}

export function ref() {
  refs++;
  idleGeneration++;
}

export function unref() {
  refs--;
  if (refs < 0) refs = 0;
  idleGeneration++;
  if (refs === 0) scheduleIdleCheck();
}

export function activeRefs() {
  return refs;
}

export function setIdleHandler(fn: () => void) {
  onIdle = fn;
}

export function scheduleIdleCheck() {
  if (checkScheduled) return;
  checkScheduled = true;
  const gen = idleGeneration;
  // two macrotask turns plus a short delay, to let native async work (blob reads, etc.) settle
  macrotask(() => {
    nativeSetTimeout(() => {
      checkScheduled = false;
      if (refs === 0 && gen === idleGeneration && onIdle) onIdle();
      else if (refs === 0) scheduleIdleCheck();
    }, 4);
  });
}

/** Keeps the loop alive while a promise is pending. */
export function track<T>(p: Promise<T>): Promise<T> {
  ref();
  return p.finally(() => unref());
}

// -----------------------------------------------------------------------------
// process.nextTick

const tickQueue: { fn: (...a: any[]) => void; args: any[] }[] = [];
let tickScheduled = false;
let tickErrorHandler: (e: unknown) => void = (e) => {
  throw e;
};

export function setTickErrorHandler(fn: (e: unknown) => void) {
  tickErrorHandler = fn;
}

export function runTicks() {
  tickScheduled = false;
  while (tickQueue.length) {
    const t = tickQueue.shift()!;
    try {
      t.fn(...t.args);
    } catch (e) {
      tickErrorHandler(e);
    }
  }
}

export function nextTick(fn: (...a: any[]) => void, ...args: any[]) {
  if (typeof fn !== 'function') {
    const err = new TypeError('The "callback" argument must be of type function') as TypeError & { code: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  tickQueue.push({ fn, args });
  if (!tickScheduled) {
    tickScheduled = true;
    queueMicrotask(runTicks);
  }
}

// -----------------------------------------------------------------------------
// timers

let nextTimerId = 1;
const kHandle = Symbol('handle');

export class Timeout {
  [kHandle]: any;
  _idleTimeout: number;
  _onTimeout: (...a: any[]) => void;
  _timerArgs: any[];
  _repeat: number | null;
  _destroyed = false;
  private _ref = true;
  private _id = nextTimerId++;

  constructor(fn: (...a: any[]) => void, ms: number, args: any[], repeat: boolean) {
    this._onTimeout = fn;
    this._idleTimeout = ms;
    this._timerArgs = args;
    this._repeat = repeat ? ms : null;
    ref();
    this._start();
  }

  private _start() {
    const ms = Math.max(1, Math.min(this._idleTimeout || 1, 2 ** 31 - 1));
    if (this._repeat !== null) {
      this[kHandle] = nativeSetInterval(() => this._fire(), ms);
    } else {
      this[kHandle] = nativeSetTimeout(() => this._fire(), ms);
    }
  }

  private _fire() {
    if (this._repeat === null) this._finish();
    try {
      this._onTimeout(...this._timerArgs);
    } catch (e) {
      tickErrorHandler(e);
    }
  }

  private _finish() {
    if (this._destroyed) return;
    this._destroyed = true;
    timersById.delete(this._id);
    if (this._ref) unref();
  }

  close() {
    if (this._repeat !== null) nativeClearInterval(this[kHandle]);
    else nativeClearTimeout(this[kHandle]);
    this._finish();
    return this;
  }

  ref() {
    if (!this._ref && !this._destroyed) {
      this._ref = true;
      ref();
    }
    return this;
  }

  unref() {
    if (this._ref && !this._destroyed) {
      this._ref = false;
      unref();
    }
    return this;
  }

  hasRef() {
    return this._ref;
  }

  refresh() {
    if (this._destroyed) return this;
    if (this._repeat !== null) nativeClearInterval(this[kHandle]);
    else nativeClearTimeout(this[kHandle]);
    this._start();
    return this;
  }

  [Symbol.toPrimitive]() {
    return this._id;
  }
}

const timersById = new Map<number, Timeout>();

export function setTimeout(fn: (...a: any[]) => void, ms?: number, ...args: any[]): Timeout {
  const t = new Timeout(fn, Number(ms) || 0, args, false);
  timersById.set(+t, t);
  return t;
}

export function setInterval(fn: (...a: any[]) => void, ms?: number, ...args: any[]): Timeout {
  const t = new Timeout(fn, Number(ms) || 0, args, true);
  timersById.set(+t, t);
  return t;
}

export function clearTimeout(t: Timeout | number | undefined | null) {
  if (t == null) return;
  if (typeof t === 'number' || typeof t === 'string') {
    const tt = timersById.get(Number(t));
    tt?.close();
    timersById.delete(Number(t));
    return;
  }
  if (t instanceof Timeout) {
    t.close();
    timersById.delete(+t);
  }
}
export const clearInterval = clearTimeout;

export class Immediate {
  _onImmediate: (...a: any[]) => void;
  _argv: any[];
  _destroyed = false;
  private _ref = true;
  constructor(fn: (...a: any[]) => void, args: any[]) {
    this._onImmediate = fn;
    this._argv = args;
    ref();
    macrotask(() => {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._ref) unref();
      try {
        fn(...args);
      } catch (e) {
        tickErrorHandler(e);
      }
    });
  }
  ref() {
    if (!this._ref && !this._destroyed) {
      this._ref = true;
      ref();
    }
    return this;
  }
  unref() {
    if (this._ref && !this._destroyed) {
      this._ref = false;
      unref();
    }
    return this;
  }
  hasRef() {
    return this._ref;
  }
}

export function setImmediate(fn: (...a: any[]) => void, ...args: any[]): Immediate {
  return new Immediate(fn, args);
}

export function clearImmediate(i: Immediate | undefined | null) {
  if (!i || i._destroyed) return;
  i._destroyed = true;
  if (i.hasRef()) unref();
}

/** A generic ref'able handle (servers, sockets, child processes). */
export class Handle {
  private _ref = false;
  private _active = false;
  activate() {
    if (this._active) return;
    this._active = true;
    if (!this._unrefed) {
      this._ref = true;
      ref();
    }
  }
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._ref) {
      this._ref = false;
      unref();
    }
  }
  private _unrefed = false;
  ref() {
    this._unrefed = false;
    if (this._active && !this._ref) {
      this._ref = true;
      ref();
    }
  }
  unref() {
    this._unrefed = true;
    if (this._ref) {
      this._ref = false;
      unref();
    }
  }
  hasRef() {
    return this._active && this._ref;
  }
}
