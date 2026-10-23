// Minimal WebSocket frame codec used to bridge a virtual socket (where a server
// library such as `ws` speaks the wire protocol) to message-based transport.
import { getRandomValues } from './native.ts';

export function encodeClientFrame(data: Uint8Array, opcode: number): Uint8Array {
  // client → server frames must be masked
  const len = data.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  const out = new Uint8Array(headerLen + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) {
    out[1] = 0x80 | 126;
    out[2] = len >> 8;
    out[3] = len & 0xff;
  } else {
    out[1] = 0x80 | 127;
    const dv = new DataView(out.buffer);
    dv.setUint32(2, Math.floor(len / 2 ** 32));
    dv.setUint32(6, len >>> 0);
  }
  const mask = getRandomValues(new Uint8Array(4));
  out.set(mask, headerLen);
  for (let i = 0; i < len; i++) out[headerLen + 4 + i] = data[i] ^ mask[i & 3];
  return out;
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Incremental parser for server → client frames. */
export class FrameParser {
  private buf = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private fragOpcode = 0;
  constructor(private onMessage: (opcode: number, payload: Uint8Array) => void) {}

  push(chunk: Uint8Array) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
    for (;;) {
      const f = this.next();
      if (!f) break;
      if (f.opcode === 0) {
        this.fragments.push(f.payload);
        if (f.fin) {
          const total = this.fragments.reduce((a, x) => a + x.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const x of this.fragments) {
            all.set(x, off);
            off += x.length;
          }
          this.fragments = [];
          this.onMessage(this.fragOpcode, all);
        }
      } else if (f.opcode < 8 && !f.fin) {
        this.fragOpcode = f.opcode;
        this.fragments = [f.payload];
      } else {
        this.onMessage(f.opcode, f.payload);
      }
    }
  }

  private next(): Frame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = (b[2] << 8) | b[3];
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const dv = new DataView(b.buffer, b.byteOffset);
      len = dv.getUint32(2) * 2 ** 32 + dv.getUint32(6);
      off = 10;
    }
    let mask: Uint8Array | null = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }
}
