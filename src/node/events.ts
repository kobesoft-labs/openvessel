// node:events

type Listener = (...args: any[]) => any;
const kCapture = Symbol('kCapture');
const kOnce = Symbol('once');

export const errorMonitor = Symbol('events.errorMonitor');
export const captureRejectionSymbol = Symbol.for('nodejs.rejection');
let defaultMaxListeners = 10;

interface Wrapped extends Listener {
  listener?: Listener;
  [kOnce]?: boolean;
}

class EventEmitterImpl {
  static get defaultMaxListeners() {
    return defaultMaxListeners;
  }
  static set defaultMaxListeners(n: number) {
    defaultMaxListeners = n;
  }
  static errorMonitor = errorMonitor;
  static captureRejectionSymbol = captureRejectionSymbol;
  static captureRejections = false;
  static usingDomains = false;
  static EventEmitter: typeof EventEmitter;
  static once: typeof once;
  static on: typeof on;
  static getEventListeners: typeof getEventListeners;
  static setMaxListeners: typeof setMaxListeners;
  static listenerCount: typeof listenerCount;
  static addAbortListener: typeof addAbortListener;
  static EventEmitterAsyncResource: any;

  declare _events: Record<string | symbol, Listener | Listener[] | undefined>;
  declare _eventsCount: number;
  declare _maxListeners: number | undefined;


  setMaxListeners(n: number) {
    this._maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? defaultMaxListeners;
  }

  private _ev() {
    if (!this._events) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    }
    return this._events;
  }

  emit(type: string | symbol, ...args: any[]): boolean {
    const events = this._ev();
    if (type === 'error' && events[errorMonitor]) this.emit(errorMonitor, ...args);
    const handler = events[type];
    if (handler === undefined) {
      if (type === 'error') {
        const er = args[0];
        if (er instanceof Error) throw er;
        const err = new Error(`Unhandled error. (${er})`) as Error & { context?: unknown; code?: string };
        err.context = er;
        err.code = 'ERR_UNHANDLED_ERROR';
        throw err;
      }
      return false;
    }
    if (typeof handler === 'function') {
      callListener(this, handler, args);
    } else {
      const list = handler.slice();
      for (const fn of list) callListener(this, fn, args);
    }
    return true;
  }

  private _add(type: string | symbol, listener: Listener, prepend: boolean) {
    checkListener(listener);
    const events = this._ev();
    if (events.newListener !== undefined) {
      this.emit('newListener', type, (listener as Wrapped).listener ?? listener);
    }
    const existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      this._eventsCount++;
    } else if (typeof existing === 'function') {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) existing.unshift(listener);
    else existing.push(listener);
    return this;
  }

  on(type: string | symbol, listener: Listener) {
    return this._add(type, listener, false);
  }
  addListener(type: string | symbol, listener: Listener) {
    return this._add(type, listener, false);
  }
  prependListener(type: string | symbol, listener: Listener) {
    return this._add(type, listener, true);
  }

  private _onceWrap(type: string | symbol, listener: Listener): Wrapped {
    checkListener(listener);
    let fired = false;
    const self = this;
    const w: Wrapped = function (this: unknown, ...args: any[]) {
      if (fired) return;
      fired = true;
      self.removeListener(type, w);
      return listener.apply(self, args);
    };
    w.listener = listener;
    return w;
  }

  once(type: string | symbol, listener: Listener) {
    return this.on(type, this._onceWrap(type, listener));
  }
  prependOnceListener(type: string | symbol, listener: Listener) {
    return this.prependListener(type, this._onceWrap(type, listener));
  }

  removeListener(type: string | symbol, listener: Listener) {
    checkListener(listener);
    const events = this._ev();
    const list = events[type];
    if (list === undefined) return this;
    if (list === listener || (list as Wrapped).listener === listener) {
      if (--this._eventsCount === 0) this._events = Object.create(null);
      else delete events[type];
      if (events.removeListener) this.emit('removeListener', type, (list as Wrapped).listener ?? listener);
    } else if (typeof list !== 'function') {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || (list[i] as Wrapped).listener === listener) {
          const removed = list[i];
          list.splice(i, 1);
          if (list.length === 1) events[type] = list[0];
          if (events.removeListener !== undefined) this.emit('removeListener', type, (removed as Wrapped).listener ?? listener);
          break;
        }
      }
    }
    return this;
  }
  off(type: string | symbol, listener: Listener) {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type?: string | symbol) {
    const events = this._ev();
    if (events.removeListener === undefined) {
      if (type === undefined) {
        this._events = Object.create(null);
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) this._events = Object.create(null);
        else delete events[type];
      }
      return this;
    }
    if (type === undefined) {
      for (const key of Reflect.ownKeys(events)) {
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = Object.create(null);
      this._eventsCount = 0;
      return this;
    }
    const listeners = events[type];
    if (typeof listeners === 'function') this.removeListener(type, listeners);
    else if (listeners) for (let i = listeners.length - 1; i >= 0; i--) this.removeListener(type, listeners[i]);
    return this;
  }

  listeners(type: string | symbol): Listener[] {
    const l = this._ev()[type];
    if (!l) return [];
    if (typeof l === 'function') return [(l as Wrapped).listener ?? l];
    return l.map((x) => (x as Wrapped).listener ?? x);
  }

  rawListeners(type: string | symbol): Listener[] {
    const l = this._ev()[type];
    if (!l) return [];
    return typeof l === 'function' ? [l] : l.slice();
  }

  listenerCount(type: string | symbol, listener?: Listener): number {
    const l = this._ev()[type];
    if (!l) return 0;
    if (typeof l === 'function') return listener ? +(l === listener || (l as Wrapped).listener === listener) : 1;
    if (listener) return l.filter((x) => x === listener || (x as Wrapped).listener === listener).length;
    return l.length;
  }

  eventNames(): (string | symbol)[] {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._ev()) : [];
  }
}

/** Function constructor so legacy `EventEmitter.call(this)` works. */
export const EventEmitter: any = function EventEmitter(this: any, opts?: { captureRejections?: boolean }) {
  EventEmitter.init.call(this, opts);
};
EventEmitter.prototype = EventEmitterImpl.prototype;
Object.defineProperty(EventEmitterImpl.prototype, 'constructor', { value: EventEmitter, writable: true, configurable: true });
for (const k of Object.getOwnPropertyNames(EventEmitterImpl)) {
  if (k === 'prototype' || k === 'length' || k === 'name') continue;
  Object.defineProperty(EventEmitter, k, Object.getOwnPropertyDescriptor(EventEmitterImpl, k)!);
}
EventEmitter.init = function (this: any, opts?: { captureRejections?: boolean }) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners || undefined;
  if (opts?.captureRejections) this[kCapture] = true;
};

function callListener(target: any, fn: Listener, args: any[]) {
  const r = fn.apply(target, args);
  if (r && typeof r.then === 'function' && (EventEmitter.captureRejections || (target as any)[kCapture])) {
    r.then(undefined, (err: unknown) => {
      queueMicrotask(() => {
        const h = (target as any)[captureRejectionSymbol];
        if (typeof h === 'function') h.call(target, err);
        else target.emit('error', err);
      });
    });
  }
}

function checkListener(l: unknown) {
  if (typeof l !== 'function') {
    const err = new TypeError(`The "listener" argument must be of type function. Received ${l === null ? 'null' : typeof l}`) as TypeError & { code: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

export function once(emitter: any, name: string | symbol, opts: { signal?: AbortSignal } = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (typeof emitter.addEventListener === 'function' && typeof emitter.on !== 'function') {
      emitter.addEventListener(name, (...a: any[]) => resolve(a), { once: true });
      return;
    }
    const onError = (err: unknown) => {
      emitter.removeListener(name, resolver);
      reject(err);
    };
    const resolver = (...args: any[]) => {
      if (name !== 'error') emitter.removeListener('error', onError);
      resolve(args);
    };
    emitter.once(name, resolver);
    if (name !== 'error') emitter.once('error', onError);
    opts.signal?.addEventListener('abort', () => {
      emitter.removeListener(name, resolver);
      emitter.removeListener('error', onError);
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    });
  });
}

export function on(emitter: any, name: string | symbol, opts: { signal?: AbortSignal } = {}): AsyncIterableIterator<any[]> {
  const queue: any[][] = [];
  const waiters: { resolve: (v: IteratorResult<any[]>) => void; reject: (e: unknown) => void }[] = [];
  let error: unknown = null;
  let done = false;
  const handler = (...args: any[]) => {
    const w = waiters.shift();
    if (w) w.resolve({ value: args, done: false });
    else queue.push(args);
  };
  const errHandler = (err: unknown) => {
    done = true;
    const w = waiters.shift();
    if (w) w.reject(err);
    else error = err;
  };
  emitter.on(name, handler);
  if (name !== 'error') emitter.on('error', errHandler);
  const cleanup = () => {
    emitter.removeListener(name, handler);
    emitter.removeListener('error', errHandler);
  };
  opts.signal?.addEventListener('abort', () => errHandler(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })));
  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (error) {
        const e = error;
        error = null;
        return Promise.reject(e);
      }
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return() {
      cleanup();
      done = true;
      for (const w of waiters) w.resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown) {
      cleanup();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncIterableIterator<any[]>;
}

export function getEventListeners(emitter: any, name: string | symbol) {
  if (typeof emitter.listeners === 'function') return emitter.listeners(name);
  return [];
}

export function setMaxListeners(n = defaultMaxListeners, ...targets: any[]) {
  if (!targets.length) defaultMaxListeners = n;
  for (const t of targets) t.setMaxListeners?.(n);
}

export function listenerCount(emitter: any, type: string | symbol) {
  return emitter.listenerCount(type);
}

export function addAbortListener(signal: AbortSignal, listener: () => void) {
  if (signal.aborted) queueMicrotask(listener);
  else signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose ?? Symbol.for('dispose')]() {
    signal.removeEventListener('abort', listener);
  } };
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.once = once;
EventEmitter.on = on;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.setMaxListeners = setMaxListeners;
EventEmitter.listenerCount = listenerCount;
EventEmitter.addAbortListener = addAbortListener;
EventEmitter.EventEmitterAsyncResource = class extends (EventEmitter as any) {};
(EventEmitter.prototype as any)._events = undefined;
(EventEmitter.prototype as any)._eventsCount = 0;
(EventEmitter.prototype as any)._maxListeners = undefined;

export default EventEmitter;
