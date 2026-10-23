// Differential tests for internalBinding('zlib'): the transcripts in fixtures/zlib.json were recorded
// from real Node v22.20.0 by test/fixtures-gen/zlib.mjs, driving the binding the way lib/zlib.js
// does; here the same driver runs against OpenVessel's binding.
import './zlib-loop-shim.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/zlib.json';
// @ts-ignore -- plain JS module shared with the fixture generator
import { runSpec } from '../fixtures-gen/zlib-driver.mjs';
import { createZlib } from '../../src/nodejs/bindings/zlib.ts';

const binding = createZlib();
const inputs: Record<string, Uint8Array> = Object.fromEntries(Object.entries(fixture.inputs).map(([k, v]) => [k, new Uint8Array(Buffer.from(v as string, 'base64'))]));

test('binding members', () => {
  assert.equal(binding.ZLIB_VERSION, fixture.ZLIB_VERSION);
  for (const name of ['Zlib', 'BrotliEncoder', 'BrotliDecoder', 'ZstdCompress', 'ZstdDecompress']) {
    assert.equal(typeof binding[name], 'function', name);
    assert.equal(binding[name].name, name);
    for (const m of ['write', 'writeSync', 'close', 'init', 'params', 'reset']) assert.equal(typeof binding[name].prototype[m], 'function', `${name}.${m}`);
  }
  // zlib.js defines an accessor on the prototype
  Object.defineProperty(binding.Zlib.prototype, 'jsref', { configurable: true, get() {}, set() {} });
});

test('crc32', () => {
  for (const c of fixture.crc32 as any[]) {
    const data = typeof c.data === 'string' ? c.data : new Uint8Array(Buffer.from(c.data.b64, 'base64'));
    assert.equal(binding.crc32(data, c.value), c.expected, JSON.stringify(c.data).slice(0, 40));
  }
});

const groups = new Map<string, any[]>();
for (const r of fixture.results as any[]) {
  const g = r.spec.cls === 'Zlib' ? (/^(UN|IN|GUN)/.test(r.spec.name) ? 'inflate' : 'deflate') : r.spec.cls;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g)!.push(r);
}

for (const [group, results] of groups) {
  test(`transcripts: ${group}`, async (t) => {
    for (const r of results) {
      await t.test(r.spec.name, async () => {
        const got = await runSpec(binding, r.spec, inputs);
        assert.deepStrictEqual(got, r.transcript);
      });
    }
  });
}

test('close() during an async write is deferred until the callback', async () => {
  const h = new binding.Zlib(1);
  const ws = new Uint32Array(2);
  let calls = 0;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  h.init(15, 6, 8, 0, ws, () => {
    calls++;
    resolve();
  }, undefined);
  const out = new Uint8Array(1024);
  h.write(4, inputs.small, 0, inputs.small.length, out, 0, 1024);
  assert.equal(calls, 0);
  h.close();
  await done;
  assert.equal(calls, 1);
  assert.ok(ws[0] < 1024);
  assert.throws(() => h.writeSync(4, null, 0, 0, out, 0, 1024), /already finalized/);
});

test('write() while another write is in flight is rejected', () => {
  const h = new binding.Zlib(2);
  h.init(0, -1, 8, 0, new Uint32Array(2), () => {}, undefined);
  const out = new Uint8Array(64);
  h.write(0, inputs.deflated, 0, 10, out, 0, 64);
  assert.throws(() => h.write(0, inputs.deflated, 10, 10, out, 0, 64));
});

test('brotli and zstd round trips through our own encoders', () => {
  const run = (h: any, flush: number, input: Uint8Array) => {
    const ws = new Uint32Array(2);
    const chunks: Uint8Array[] = [];
    h.onerror = (m: string) => assert.fail(m);
    return { ws, chunks, h, flush, input };
  };
  for (const [Enc, Dec, encMode, decMode, finish, init] of [
    ['BrotliEncoder', 'BrotliDecoder', 9, 8, 2, (h: any, ws: Uint32Array) => h.init(new Uint32Array(10).fill(-1), ws, () => {})],
    ['ZstdCompress', 'ZstdDecompress', 0, 0, 2, (h: any, ws: Uint32Array) => h.init(new Uint32Array(1001).fill(-1), undefined, ws, () => {})],
  ] as const) {
    const pump = (h: any, ws: Uint32Array, input: Uint8Array) => {
      const parts: Uint8Array[] = [];
      let off = 0;
      let left = input.length;
      for (;;) {
        const out = new Uint8Array(4096);
        h.writeSync(finish, input, off, left, out, 0, 4096);
        parts.push(out.slice(0, 4096 - ws[0]));
        off += left - ws[1];
        left = ws[1];
        if (ws[0] !== 0) break;
      }
      return Buffer.concat(parts);
    };
    const e = new binding[Enc](encMode);
    const d = new binding[Dec](decMode);
    const s1 = run(e, finish, inputs.text);
    const s2 = run(d, finish, inputs.text);
    init(e, s1.ws);
    init(d, s2.ws);
    const packed = pump(e, s1.ws, inputs.text);
    assert.ok(packed.length < inputs.text.length / 2);
    assert.deepEqual(new Uint8Array(pump(d, s2.ws, new Uint8Array(packed))), inputs.text);
  }
});
