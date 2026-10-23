// node:stream on top of readable-stream (Node's own stream implementation, packaged for browsers).

// @ts-ignore - CommonJS package without types
import RS from 'readable-stream/lib/ours/browser.js';
import { Buffer } from 'buffer';

const rs: any = RS;
export const Readable: any = rs.Readable;
export const Writable: any = rs.Writable;
export const Duplex: any = rs.Duplex;
export const Transform: any = rs.Transform;
export const PassThrough: any = rs.PassThrough;
export const pipeline: any = rs.pipeline;
export const finished: any = rs.finished;
export const addAbortSignal: any = rs.addAbortSignal;
export const compose: any = rs.compose;
export const destroy: any = rs.destroy;
export const isDisturbed: any = rs.isDisturbed;
export const isErrored: any = rs.isErrored;
export const isReadable: any = rs.isReadable;
export const promises: any = rs.promises ?? rs.Stream?.promises;

let defaultHwm = 64 * 1024;
let defaultObjHwm = 16;
export function getDefaultHighWaterMark(objectMode: boolean) {
  return objectMode ? defaultObjHwm : defaultHwm;
}
export function setDefaultHighWaterMark(objectMode: boolean, value: number) {
  if (objectMode) defaultObjHwm = value;
  else defaultHwm = value;
}

export function isWritable(s: any) {
  return !!s && s.writable !== false && !s.destroyed && !s.writableEnded;
}

/** Readable.fromWeb: Node readable over a WHATWG ReadableStream. */
Readable.fromWeb = function fromWeb(web: ReadableStream, opts: any = {}) {
  const reader = web.getReader();
  return new Readable({
    ...opts,
    async read(this: any) {
      try {
        const { value, done } = await reader.read();
        if (done) this.push(null);
        else this.push(opts.objectMode || typeof value === 'string' ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      } catch (e) {
        this.destroy(e);
      }
    },
    destroy(err: any, cb: any) {
      reader.cancel(err).catch(() => {});
      cb(err);
    },
  });
};

/** Readable.toWeb: WHATWG ReadableStream over a Node readable. */
Readable.toWeb = function toWeb(node: any, _opts?: any) {
  let closed = false;
  return new ReadableStream({
    start(ctrl) {
      node.on('data', (chunk: any) => {
        if (closed) return;
        ctrl.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        if ((ctrl.desiredSize ?? 1) <= 0) node.pause();
      });
      node.on('end', () => {
        if (!closed) {
          closed = true;
          ctrl.close();
        }
      });
      node.on('error', (e: any) => {
        if (!closed) {
          closed = true;
          ctrl.error(e);
        }
      });
    },
    pull() {
      node.resume();
    },
    cancel(reason) {
      closed = true;
      node.destroy(reason);
    },
  });
};

Writable.fromWeb = function fromWeb(web: WritableStream, opts: any = {}) {
  const writer = web.getWriter();
  return new Writable({
    ...opts,
    write(chunk: any, _enc: any, cb: any) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb: any) {
      writer.close().then(() => cb(), cb);
    },
    destroy(err: any, cb: any) {
      writer.abort(err).catch(() => {});
      cb(err);
    },
  });
};

Writable.toWeb = function toWeb(node: any) {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ok = node.write(chunk, (err: any) => (err ? reject(err) : undefined));
        if (ok) resolve();
        else node.once('drain', resolve);
      });
    },
    close() {
      return new Promise<void>((resolve) => node.end(resolve));
    },
    abort(reason) {
      node.destroy(reason);
    },
  });
};

Duplex.fromWeb = function fromWeb(pair: { readable: ReadableStream; writable: WritableStream }, opts: any = {}) {
  const r = Readable.fromWeb(pair.readable, opts);
  const w = Writable.fromWeb(pair.writable, opts);
  return Duplex.from({ readable: r, writable: w });
};

Duplex.toWeb = function toWeb(d: any) {
  return { readable: Readable.toWeb(d), writable: Writable.toWeb(d) };
};

export function duplexPair(opts?: any) {
  const a: any = new Duplex({ ...opts, read() {}, write(c: any, e: any, cb: any) { b.push(c, e); cb(); }, final(cb: any) { b.push(null); cb(); } });
  const b: any = new Duplex({ ...opts, read() {}, write(c: any, e: any, cb: any) { a.push(c, e); cb(); }, final(cb: any) { a.push(null); cb(); } });
  return [a, b];
}

/** The legacy `Stream` (require('stream') itself is a constructor). */
export const Stream: any = rs.Stream;
Object.assign(Stream, {
  Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, addAbortSignal, compose, destroy,
  isDisturbed, isErrored, isReadable, isWritable, getDefaultHighWaterMark, setDefaultHighWaterMark, duplexPair, Stream,
});
if (!('promises' in Stream)) Object.defineProperty(Stream, 'promises', { get: () => promises, enumerable: true, configurable: true });

export const streamPromises = {
  pipeline: promises?.pipeline ?? ((...s: any[]) => new Promise((res, rej) => pipeline(...s, (e: any) => (e ? rej(e) : res(undefined))))),
  finished: promises?.finished ?? ((s: any, o?: any) => new Promise((res, rej) => finished(s, o ?? {}, (e: any) => (e ? rej(e) : res(undefined))))),
};

export const consumers = {
  async arrayBuffer(s: any) {
    const b = await consumers.buffer(s);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async buffer(s: any) {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
    return Buffer.concat(chunks);
  },
  async text(s: any) {
    return (await consumers.buffer(s)).toString('utf8');
  },
  async json(s: any) {
    return JSON.parse(await consumers.text(s));
  },
  async blob(s: any) {
    return new Blob([await consumers.buffer(s)]);
  },
};

export default Stream;
