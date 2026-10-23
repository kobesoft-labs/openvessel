// src/nodejs/loop.ts posts macrotasks through a MessageChannel, whose ref'd port would keep the
// node:test process alive forever. Imported first by bindings-zlib.test.ts, before loop.ts loads.
class ImmediateChannel {
  port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
  port2 = {
    postMessage: (data: unknown) => {
      setImmediate(() => this.port1.onmessage?.({ data }));
    },
  };
}
(globalThis as any).MessageChannel = ImmediateChannel;
