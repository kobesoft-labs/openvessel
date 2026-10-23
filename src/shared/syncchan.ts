// Synchronous request/response channel over a SharedArrayBuffer.
//
// Layout: Int32 header (16 slots) followed by a data region.
//   [0] state   0 = idle, 1 = request written, 2 = response written
//   [1] json length of the whole message
//   [2] binary length of the whole message
//   [3] bytes of the message in the data region this round
//   [4] flags   1 = more chunks follow
// A message is the UTF-8 JSON followed by the binary payload. Messages larger
// than the data region are sent in several rounds.

export const HEADER_BYTES = 64;
export const DEFAULT_CHANNEL_BYTES = 4 * 1024 * 1024;
const FLAG_MORE = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ChanMessage {
  json: unknown;
  bin?: Uint8Array;
}

export function createChannelBuffer(size = DEFAULT_CHANNEL_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(size);
}

function encodeMessage(m: ChanMessage): { bytes: Uint8Array; jl: number; bl: number } {
  const j = enc.encode(JSON.stringify(m.json ?? null));
  const bl = m.bin ? m.bin.length : 0;
  if (!bl) return { bytes: j, jl: j.length, bl: 0 };
  const bytes = new Uint8Array(j.length + bl);
  bytes.set(j, 0);
  bytes.set(m.bin!, j.length);
  return { bytes, jl: j.length, bl };
}

function decodeMessage(bytes: Uint8Array, jl: number, bl: number): ChanMessage {
  // TextDecoder cannot read from shared memory directly: copy first.
  const json = JSON.parse(dec.decode(bytes.slice(0, jl)));
  const bin = bl ? bytes.slice(jl, jl + bl) : undefined;
  return { json, bin };
}

/** Worker side: blocks with Atomics.wait. */
export class SyncClient {
  private ctl: Int32Array;
  private data: Uint8Array;
  private cap: number;
  constructor(public sab: SharedArrayBuffer, private notify: () => void) {
    this.ctl = new Int32Array(sab, 0, HEADER_BYTES / 4);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = this.data.length;
  }

  private roundTrip() {
    Atomics.store(this.ctl, 0, 1);
    this.notify();
    while (Atomics.load(this.ctl, 0) === 1) Atomics.wait(this.ctl, 0, 1);
  }

  call(m: ChanMessage): ChanMessage {
    const { bytes, jl, bl } = encodeMessage(m);
    const total = bytes.length;
    let off = 0;
    // send
    for (;;) {
      const n = Math.min(this.cap, total - off);
      this.data.set(bytes.subarray(off, off + n), 0);
      off += n;
      this.ctl[1] = jl;
      this.ctl[2] = bl;
      this.ctl[3] = n;
      this.ctl[4] = off < total ? FLAG_MORE : 0;
      this.roundTrip();
      if (off >= total) break;
    }
    // receive
    const rjl = this.ctl[1];
    const rbl = this.ctl[2];
    const rtotal = rjl + rbl;
    let n = this.ctl[3];
    if (!(this.ctl[4] & FLAG_MORE)) {
      const res = decodeMessage(this.data.subarray(0, n), rjl, rbl);
      Atomics.store(this.ctl, 0, 0);
      return res;
    }
    const buf = new Uint8Array(rtotal);
    let got = 0;
    for (;;) {
      buf.set(this.data.subarray(0, n), got);
      got += n;
      if (!(this.ctl[4] & FLAG_MORE)) break;
      // ask for the next chunk with an empty "continue" round
      this.ctl[1] = 0;
      this.ctl[2] = 0;
      this.ctl[3] = 0;
      this.ctl[4] = 0;
      this.roundTrip();
      n = this.ctl[3];
    }
    Atomics.store(this.ctl, 0, 0);
    return decodeMessage(buf, rjl, rbl);
  }
}

/** Kernel side. Call `onSignal()` when the worker pinged; it returns a full request when complete. */
export class SyncServer {
  private ctl: Int32Array;
  private data: Uint8Array;
  private cap: number;
  private inbuf: Uint8Array | null = null;
  private inOff = 0;
  private outbuf: Uint8Array | null = null;
  private outOff = 0;
  private outJl = 0;
  private outBl = 0;
  constructor(public sab: SharedArrayBuffer) {
    this.ctl = new Int32Array(sab, 0, HEADER_BYTES / 4);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = this.data.length;
  }

  /** Returns the request when fully received, or null if this was an intermediate round. */
  receive(): ChanMessage | null {
    if (Atomics.load(this.ctl, 0) !== 1) return null;
    // continuation of a chunked response
    if (this.outbuf) {
      this.sendNextChunk();
      return null;
    }
    const jl = this.ctl[1];
    const bl = this.ctl[2];
    const n = this.ctl[3];
    const more = this.ctl[4] & FLAG_MORE;
    if (!more && !this.inbuf) {
      return decodeMessage(this.data.subarray(0, n), jl, bl);
    }
    if (!this.inbuf) {
      this.inbuf = new Uint8Array(jl + bl);
      this.inOff = 0;
    }
    this.inbuf.set(this.data.subarray(0, n), this.inOff);
    this.inOff += n;
    if (more) {
      // ack this chunk
      this.ctl[3] = 0;
      this.ctl[4] = 0;
      this.wake();
      return null;
    }
    const buf = this.inbuf;
    this.inbuf = null;
    return decodeMessage(buf, jl, bl);
  }

  respond(m: ChanMessage) {
    const { bytes, jl, bl } = encodeMessage(m);
    if (bytes.length <= this.cap) {
      this.data.set(bytes, 0);
      this.ctl[1] = jl;
      this.ctl[2] = bl;
      this.ctl[3] = bytes.length;
      this.ctl[4] = 0;
      this.wake();
      return;
    }
    this.outbuf = bytes;
    this.outOff = 0;
    this.outJl = jl;
    this.outBl = bl;
    this.sendNextChunk();
  }

  private sendNextChunk() {
    const buf = this.outbuf!;
    const n = Math.min(this.cap, buf.length - this.outOff);
    this.data.set(buf.subarray(this.outOff, this.outOff + n), 0);
    this.outOff += n;
    this.ctl[1] = this.outJl;
    this.ctl[2] = this.outBl;
    this.ctl[3] = n;
    const more = this.outOff < buf.length;
    this.ctl[4] = more ? FLAG_MORE : 0;
    if (!more) this.outbuf = null;
    this.wake();
  }

  private wake() {
    Atomics.store(this.ctl, 0, 2);
    Atomics.notify(this.ctl, 0);
  }
}
