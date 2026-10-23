// internalBinding('blob') — node_blob.cc. A blob handle is a list of byte parts (memory, other
// blobs or a file read on demand) plus a window [start, end); readers hand out the parts in order.

import { sys } from '../../node/sys.ts';
import { fromShape } from './shape.ts';

type Part = Uint8Array | BlobHandle | FilePart;

class FilePart {
  constructor(
    readonly path: string,
    readonly size: number,
  ) {}
  read(): Uint8Array {
    return sys<Uint8Array>('readFile', { p: this.path });
  }
}

const partLength = (p: Part) => (p instanceof Uint8Array ? p.byteLength : p instanceof FilePart ? p.size : p.length);

class BlobHandle {
  readonly length: number;
  constructor(
    private parts: Part[],
    private start = 0,
    end?: number,
  ) {
    const total = parts.reduce((n, p) => n + partLength(p), 0);
    this.length = Math.max(0, (end ?? total) - start);
  }

  slice(start: number, end: number) {
    const s = Math.max(0, Math.min(this.length, start));
    const e = Math.max(s, Math.min(this.length, end));
    return new BlobHandle(this.parts, this.start + s, this.start + e);
  }

  /** The bytes of this handle, as a list of chunks. */
  chunks(): Uint8Array[] {
    const out: Uint8Array[] = [];
    let pos = 0;
    const from = this.start;
    const to = this.start + this.length;
    for (const p of this.parts) {
      const len = partLength(p);
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + len);
      if (a < b) {
        if (p instanceof Uint8Array) out.push(p.subarray(a - pos, b - pos));
        else if (p instanceof FilePart) out.push(p.read().subarray(a - pos, b - pos));
        else out.push(...p.slice(a - pos, b - pos).chunks());
      }
      pos += len;
      if (pos >= to) break;
    }
    return out;
  }

  getReader() {
    const handle = this;
    let queue: Uint8Array[] | null = null;
    return {
      pull(cb: (status: number, buffer?: ArrayBuffer) => void) {
        try {
          queue ??= handle.chunks();
        } catch {
          cb(-2 /* UV_ENOENT */);
          return;
        }
        const next = queue.shift();
        if (!next) cb(0);
        else cb(1, next.slice().buffer as ArrayBuffer);
      },
    };
  }
}

export function createBlob() {
  const b = fromShape('blob');
  const store = new Map<string, [BlobHandle, number, string]>();
  return Object.assign(b, {
    createBlob(sources: (Uint8Array | BlobHandle)[], _length: number) {
      return new BlobHandle(sources.map((s) => (s instanceof BlobHandle ? s : new Uint8Array(s.buffer, s.byteOffset, s.byteLength))));
    },
    createBlobFromFilePath(path: string) {
      try {
        const st = sys<{ size: number }>('stat', { p: path });
        const h = new BlobHandle([new FilePart(path, st.size)]);
        return [h, st.size];
      } catch {
        return undefined;
      }
    },
    concat(buffers: (ArrayBuffer | ArrayBufferView)[]) {
      const views = buffers.map((x) => (ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x)));
      const out = new Uint8Array(views.reduce((n, v) => n + v.byteLength, 0));
      let o = 0;
      for (const v of views) {
        out.set(v, o);
        o += v.byteLength;
      }
      return out.buffer;
    },
    storeDataObject(id: string, handle: BlobHandle, length: number, type: string) {
      store.set(id, [handle, length, type]);
    },
    getDataObject: (id: string) => store.get(id),
    revokeObjectURL(id: string) {
      store.delete(id);
    },
  });
}
