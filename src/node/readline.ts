// node:readline and node:readline/promises

import { EventEmitter } from './events.ts';
import { StringDecoder } from './string_decoder.ts';

const kKeypressDecoder = Symbol('keypress-decoder');

export interface Key {
  sequence: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
}

const ESC_KEYS: Record<string, Partial<Key>> = {
  '[A': { name: 'up' },
  '[B': { name: 'down' },
  '[C': { name: 'right' },
  '[D': { name: 'left' },
  '[E': { name: 'clear' },
  '[F': { name: 'end' },
  '[H': { name: 'home' },
  OA: { name: 'up' },
  OB: { name: 'down' },
  OC: { name: 'right' },
  OD: { name: 'left' },
  OF: { name: 'end' },
  OH: { name: 'home' },
  OP: { name: 'f1' },
  OQ: { name: 'f2' },
  OR: { name: 'f3' },
  OS: { name: 'f4' },
  '[1~': { name: 'home' },
  '[2~': { name: 'insert' },
  '[3~': { name: 'delete' },
  '[4~': { name: 'end' },
  '[5~': { name: 'pageup' },
  '[6~': { name: 'pagedown' },
  '[7~': { name: 'home' },
  '[8~': { name: 'end' },
  '[Z': { name: 'tab', shift: true },
  '[1;2A': { name: 'up', shift: true },
  '[1;2B': { name: 'down', shift: true },
  '[1;2C': { name: 'right', shift: true },
  '[1;2D': { name: 'left', shift: true },
  '[1;5A': { name: 'up', ctrl: true },
  '[1;5B': { name: 'down', ctrl: true },
  '[1;5C': { name: 'right', ctrl: true },
  '[1;5D': { name: 'left', ctrl: true },
  '[1;3C': { name: 'right', meta: true },
  '[1;3D': { name: 'left', meta: true },
};

/** Splits terminal input into key events. */
export function parseKeys(s: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const base: Key = { sequence: c, ctrl: false, meta: false, shift: false };
    if (c === '\x1b') {
      const rest = s.slice(i + 1);
      const m = /^(\[[0-9;]*[A-Za-z~]|O[A-Z])/.exec(rest);
      if (m) {
        const seq = m[1];
        const k = ESC_KEYS[seq] ?? { name: 'undefined' };
        keys.push({ ...base, ...k, sequence: '\x1b' + seq, code: seq } as Key);
        i += 1 + seq.length;
        continue;
      }
      if (rest.length === 0) {
        keys.push({ ...base, name: 'escape' });
        i++;
        continue;
      }
      // meta + key
      const n = rest[0];
      keys.push({ ...base, sequence: '\x1b' + n, name: n === '\x7f' ? 'backspace' : n.toLowerCase(), meta: true, shift: /[A-Z]/.test(n) });
      i += 2;
      continue;
    }
    if (c === '\r') base.name = 'return';
    else if (c === '\n') base.name = 'enter';
    else if (c === '\t') base.name = 'tab';
    else if (c === '\x7f' || c === '\b') base.name = 'backspace';
    else if (c === ' ') base.name = 'space';
    else if (c <= '\x1a' && c >= '\x01') {
      base.name = String.fromCharCode(c.charCodeAt(0) + 96);
      base.ctrl = true;
    } else if (/[a-z0-9]/.test(c)) base.name = c;
    else if (/[A-Z]/.test(c)) {
      base.name = c.toLowerCase();
      base.shift = true;
    }
    keys.push(base);
    i++;
  }
  return keys;
}

export function emitKeypressEvents(stream: any, _iface?: unknown) {
  if (stream[kKeypressDecoder]) return;
  stream[kKeypressDecoder] = new StringDecoder('utf8');
  const onData = (b: any) => {
    if (stream.listenerCount('keypress') === 0) return;
    const s = typeof b === 'string' ? b : stream[kKeypressDecoder].write(b);
    for (const k of parseKeys(s)) stream.emit('keypress', k.name && k.name.length === 1 && !k.ctrl && !k.meta ? k.sequence : k.name === 'space' ? ' ' : k.sequence.length === 1 && !k.ctrl ? k.sequence : undefined, k);
  };
  const onNew = (ev: string) => {
    if (ev === 'keypress') {
      stream.on('data', onData);
      stream.removeListener('newListener', onNew);
    }
  };
  if (stream.listenerCount('keypress') > 0) stream.on('data', onData);
  else stream.on('newListener', onNew);
}

export function clearLine(stream: any, dir: number, cb?: () => void) {
  stream?.write?.(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K', cb);
  return true;
}
export function clearScreenDown(stream: any, cb?: () => void) {
  stream?.write?.('\x1b[0J', cb);
  return true;
}
export function cursorTo(stream: any, x: number, y?: any, cb?: any) {
  if (typeof y === 'function') {
    cb = y;
    y = undefined;
  }
  stream?.write?.(typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, cb);
  return true;
}
export function moveCursor(stream: any, dx: number, dy: number, cb?: () => void) {
  let s = '';
  if (dx < 0) s += `\x1b[${-dx}D`;
  else if (dx > 0) s += `\x1b[${dx}C`;
  if (dy < 0) s += `\x1b[${-dy}A`;
  else if (dy > 0) s += `\x1b[${dy}B`;
  stream?.write?.(s, cb);
  return true;
}

export class Interface extends EventEmitter {
  input: any;
  output: any;
  terminal: boolean;
  line = '';
  cursor = 0;
  history: string[] = [];
  closed = false;
  private _prompt = '> ';
  private decoder = new StringDecoder('utf8');
  private buf = '';
  private paused = false;
  private questionCb: ((a: string) => void) | null = null;
  private crlfDelay: number;
  private histIdx = -1;
  private onData = (d: any) => this._data(typeof d === 'string' ? d : this.decoder.write(d));
  private onEnd = () => {
    if (this.buf.length) {
      const l = this.buf;
      this.buf = '';
      this._line(l);
    }
    this.close();
  };

  constructor(input: any, output?: any, completer?: unknown, terminal?: boolean) {
    super();
    let opts: any = input;
    if (!input || typeof input.on === 'function' || input.readable !== undefined) opts = { input, output, completer, terminal };
    this.input = opts.input;
    this.output = opts.output;
    this.terminal = opts.terminal ?? !!this.output?.isTTY;
    this.crlfDelay = opts.crlfDelay ?? 100;
    if (opts.prompt !== undefined) this._prompt = opts.prompt;
    if (opts.history) this.history = [...opts.history];
    if (this.input) {
      if (this.terminal && typeof this.input.setRawMode === 'function') {
        emitKeypressEvents(this.input);
        this.input.setRawMode(true);
        this.input.on('keypress', this.onKey);
      } else {
        this.input.on('data', this.onData);
      }
      this.input.on('end', this.onEnd);
      this.input.resume?.();
    }
    opts.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  private onKey = (_s: string | undefined, key: Key) => {
    if (this.closed || !key) return;
    if (key.ctrl && key.name === 'c') {
      if (this.listenerCount('SIGINT')) this.emit('SIGINT');
      else {
        this.close();
        (globalThis as any).process.kill((globalThis as any).process.pid, 'SIGINT');
      }
      return;
    }
    if (key.ctrl && key.name === 'd' && this.line === '') {
      this.close();
      return;
    }
    switch (key.name) {
      case 'return':
      case 'enter': {
        const l = this.line;
        this.output?.write?.('\r\n');
        this.line = '';
        this.cursor = 0;
        this.histIdx = -1;
        if (l) this.history.unshift(l);
        this._line(l);
        return;
      }
      case 'backspace':
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor--;
          this._refresh();
        }
        return;
      case 'delete':
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this._refresh();
        return;
      case 'left':
        if (this.cursor > 0) this.cursor--;
        this._refresh();
        return;
      case 'right':
        if (this.cursor < this.line.length) this.cursor++;
        this._refresh();
        return;
      case 'home':
        this.cursor = 0;
        this._refresh();
        return;
      case 'end':
        this.cursor = this.line.length;
        this._refresh();
        return;
      case 'up':
        if (this.histIdx + 1 < this.history.length) {
          this.histIdx++;
          this.line = this.history[this.histIdx];
          this.cursor = this.line.length;
          this._refresh();
        }
        return;
      case 'down':
        if (this.histIdx > 0) {
          this.histIdx--;
          this.line = this.history[this.histIdx];
        } else {
          this.histIdx = -1;
          this.line = '';
        }
        this.cursor = this.line.length;
        this._refresh();
        return;
    }
    if (key.ctrl || key.meta) return;
    const ch = key.sequence;
    if (ch && ch.length >= 1 && ch >= ' ') {
      this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
      this.cursor += ch.length;
      this._refresh();
    }
  };

  private _refresh() {
    if (!this.output?.write) return;
    this.output.write(`\r\x1b[K${this._prompt}${this.line}`);
    const back = this.line.length - this.cursor;
    if (back > 0) this.output.write(`\x1b[${back}D`);
  }

  private _data(s: string) {
    this.buf += s;
    let idx: number;
    while ((idx = this.buf.search(/\r\n|\n|\r/)) !== -1) {
      const l = this.buf.slice(0, idx);
      const nl = this.buf[idx] === '\r' && this.buf[idx + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(idx + nl);
      this._line(l);
      if (this.closed) return;
    }
  }

  private _line(l: string) {
    if (this.questionCb) {
      const cb = this.questionCb;
      this.questionCb = null;
      cb(l);
      return;
    }
    this.emit('line', l);
  }

  getPrompt() {
    return this._prompt;
  }
  setPrompt(p: string) {
    this._prompt = p;
  }
  prompt(_preserveCursor?: boolean) {
    if (this.paused) this.resume();
    this.output?.write?.(this._prompt);
  }
  question(q: string, opts?: any, cb?: (a: string) => void) {
    if (typeof opts === 'function') cb = opts;
    if (this.closed) {
      const e = Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
      throw e;
    }
    this.questionCb = cb ?? null;
    this.output?.write?.(q);
  }
  write(d: any, key?: Key) {
    if (key) this.onKey(undefined, key);
    else if (d !== undefined && d !== null) this._data(String(d));
  }
  pause() {
    if (this.paused) return this;
    this.paused = true;
    this.input?.pause?.();
    this.emit('pause');
    return this;
  }
  resume() {
    if (!this.paused) return this;
    this.paused = false;
    this.input?.resume?.();
    this.emit('resume');
    return this;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.input) {
      this.input.removeListener('data', this.onData);
      this.input.removeListener('end', this.onEnd);
      this.input.removeListener('keypress', this.onKey);
      if (this.terminal && typeof this.input.setRawMode === 'function') this.input.setRawMode(false);
      this.input.pause?.();
    }
    this.emit('close');
  }
  getCursorPos() {
    return { rows: 0, cols: this.cursor + this._prompt.length };
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    const waiters: ((r: IteratorResult<string>) => void)[] = [];
    let done = this.closed;
    this.on('line', (l: string) => {
      const w = waiters.shift();
      if (w) w({ value: l, done: false });
      else queue.push(l);
    });
    this.on('close', () => {
      done = true;
      for (const w of waiters.splice(0)) w({ value: undefined as any, done: true });
    });
    return {
      next: () => (queue.length ? Promise.resolve({ value: queue.shift()!, done: false }) : done ? Promise.resolve({ value: undefined as any, done: true }) : new Promise((r) => waiters.push(r))),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as any, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  [Symbol.dispose ?? Symbol.for('dispose')]() {
    this.close();
  }
}

export function createInterface(input: any, output?: any, completer?: unknown, terminal?: boolean) {
  return new Interface(input, output, completer, terminal);
}

class PromisesInterface extends Interface {
  override question(q: string, opts?: any): any {
    return new Promise<string>((resolve, reject) => {
      if (opts?.signal) {
        if (opts.signal.aborted) return reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
      }
      super.question(q, resolve);
    });
  }
}

export class Readline {
  private ops: string[] = [];
  constructor(private stream: any) {}
  clearLine(dir: number) {
    this.ops.push(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
    return this;
  }
  clearScreenDown() {
    this.ops.push('\x1b[0J');
    return this;
  }
  cursorTo(x: number, y?: number) {
    this.ops.push(typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`);
    return this;
  }
  moveCursor(dx: number, dy: number) {
    if (dx) this.ops.push(dx < 0 ? `\x1b[${-dx}D` : `\x1b[${dx}C`);
    if (dy) this.ops.push(dy < 0 ? `\x1b[${-dy}A` : `\x1b[${dy}B`);
    return this;
  }
  commit() {
    this.stream.write(this.ops.join(''));
    this.ops = [];
    return Promise.resolve();
  }
  rollback() {
    this.ops = [];
    return this;
  }
}

export const promises = {
  Interface: PromisesInterface,
  Readline,
  createInterface: (input: any, output?: any, completer?: unknown, terminal?: boolean) => new PromisesInterface(input, output, completer, terminal),
};

export default { Interface, createInterface, emitKeypressEvents, clearLine, clearScreenDown, cursorTo, moveCursor, promises };
