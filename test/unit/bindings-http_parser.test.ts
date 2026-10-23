// Replays the byte streams recorded from real Node 22.20.0 (test/fixtures-gen/http_parser.mjs)
// against internalBinding('http_parser') and compares callbacks and execute() results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/http_parser.json';
import { createHttpParser } from '../../src/nodejs/bindings/http_parser.ts';
import { createBuffer } from '../../src/nodejs/bindings/buffer.ts';

createBuffer().setBufferPrototype(Buffer.prototype);
const binding = createHttpParser();
const { HTTPParser, ConnectionsList } = binding;

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

function describeResult(r: any, lingering: boolean) {
  if (r instanceof Error) {
    const e = r as any;
    const o: any = { error: { code: e.code, reason: e.reason, message: e.message } };
    if (!lingering) o.error.bytesParsed = e.bytesParsed;
    return o;
  }
  return { value: r === undefined ? null : r };
}

// Same harness as the generator.
function runCase(c: any) {
  const events: unknown[] = [];
  const parser = new HTTPParser();
  let errored = false;
  if (!c.noCallbacks) {
    parser[HTTPParser.kOnHeaders] = function (headers: string[], url: string) {
      events.push(['headers', headers, url]);
      if (c.throwIn === 'headers') throw new Error('boom headers');
    };
    parser[HTTPParser.kOnHeadersComplete] = function (this: any, major: number, minor: number, headers: unknown, method: unknown, url: unknown, statusCode: unknown, statusMessage: unknown, upgrade: boolean, keepAlive: boolean) {
      events.push(['hc', major, minor, headers ?? null, method ?? null, url ?? null, statusCode ?? null, statusMessage ?? null, upgrade, keepAlive]);
      if (c.throwIn === 'hc') throw new Error('boom hc');
      if (c.pauseInHeadersComplete) this.pause();
      return c.hc ?? 0;
    };
    parser[HTTPParser.kOnBody] = function (b: Uint8Array) {
      events.push(['body', latin1(b), Buffer.isBuffer(b)]);
      if (c.throwIn === 'body') throw new Error('boom body');
    };
    parser[HTTPParser.kOnMessageComplete] = function (this: any) {
      events.push(['mc', this.getCurrentBuffer().length]);
      if (c.throwIn === 'mc') throw new Error('boom mc');
    };
  }
  const init = (type: number) => {
    parser.initialize(type, {}, c.max ?? 0, c.lenient ?? 0);
    errored = false;
  };
  init(c.type);
  const exec = (s: string) => {
    let r;
    try {
      r = parser.execute(bytes(s));
    } catch (e) {
      events.push(['throw', e.message]);
      errored = true;
      return;
    }
    events.push(['exec', describeResult(r, errored)]);
    if (r instanceof Error) errored = true;
  };
  const ops = c.ops ?? [...(c.chunks ?? [c.input]).map((s: string) => ['exec', s]), ...(c.finish ? [['finish']] : [])];
  for (const op of ops) {
    if (op[0] === 'exec') exec(op[1]);
    else if (op[0] === 'finish') {
      let r;
      try {
        r = parser.finish();
      } catch (e) {
        events.push(['throw', e.message]);
        continue;
      }
      events.push(['finish', describeResult(r, true)]);
    } else if (op[0] === 'pause') {
      parser.pause();
      errored = true;
    } else if (op[0] === 'resume') {
      parser.resume();
    } else if (op[0] === 'init') {
      init(op[1]);
    }
  }
  if (c.pauseInHeadersComplete) {
    for (const e of events as any[]) if (e[0] === 'exec' && e[1].error?.code === 'HPE_PAUSED') delete e[1].error.bytesParsed;
  }
  parser.close();
  return events;
}

test('constants, methods and prototype match Node', () => {
  assert.deepEqual(binding.methods, fixtures.methods);
  assert.deepEqual(binding.allMethods, fixtures.allMethods);
  const constants = Object.fromEntries(Object.keys(fixtures.constants).map((k) => [k, (HTTPParser as any)[k]]));
  assert.deepEqual(constants, fixtures.constants);
  assert.deepEqual(Object.getOwnPropertyNames(HTTPParser.prototype).sort(), fixtures.proto);
  assert.equal(typeof HTTPParser.prototype.getAsyncId, 'function');
});

test('byte streams replay like Node 22.20.0', () => {
  const failures: string[] = [];
  for (const c of fixtures.cases as any[]) {
    const got = runCase(c) as any[];
    // where Node returned a stale pointer difference, any value is accepted
    c.events.forEach((e: any, i: number) => {
      if (e[0] === 'exec' && e[1].value === 'stale' && got[i]?.[0] === 'exec' && typeof got[i][1].value === 'number') got[i][1].value = 'stale';
    });
    try {
      assert.deepEqual(got, c.events);
    } catch {
      failures.push(`${c.name}\n  expected ${JSON.stringify(c.events)}\n  got      ${JSON.stringify(got)}`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length}/${fixtures.cases.length} cases differ:\n${failures.slice(0, 15).join('\n')}`);
});

test('ConnectionsList membership', () => {
  const list = new ConnectionsList();
  const a: any = new HTTPParser();
  const b: any = new HTTPParser();
  a.tag = 'a';
  b.tag = 'b';
  const snap = (label: string) => ({ label, all: list.all().map((p: any) => p.tag), idle: list.idle().map((p: any) => p.tag), active: list.active().map((p: any) => p.tag) });
  const steps: unknown[] = [];
  steps.push(snap('empty'));
  a.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  steps.push(snap('a initialized'));
  b.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  steps.push(snap('b initialized'));
  a.execute(bytes('GET / HTTP/1.1\r\n\r\n'));
  steps.push(snap('a complete'));
  b.execute(bytes('GET / HTTP/1.1\r\nHost'));
  steps.push(snap('b mid headers'));
  a.execute(bytes('GET /2 HTTP/1.1\r\n'));
  steps.push(snap('a second started'));
  steps.push({ label: 'expired 0 0', expired: list.expired(0, 0).map((p: any) => p.tag) });
  steps.push({ label: 'expired big', expired: list.expired(1e9, 1e9).map((p: any) => p.tag) });
  b.remove();
  steps.push(snap('b removed'));
  a.remove();
  steps.push(snap('a removed'));
  assert.deepEqual(steps, fixtures.connections);
});

test('ConnectionsList.expired picks connections past their deadlines', async () => {
  const list = new ConnectionsList();
  const slowHeaders: any = new HTTPParser();
  const done: any = new HTTPParser();
  slowHeaders.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  done.initialize(HTTPParser.REQUEST, {}, 0, 0, list);
  done.execute(bytes('GET / HTTP/1.1\r\n\r\n'));
  slowHeaders.execute(bytes('GET / HTTP/1.1\r\nHo'));
  await new Promise((r) => setTimeout(r, 30));
  const expired = list.expired(10, 0);
  assert.deepEqual(expired, [slowHeaders]);
  // removed from the active set once reported
  assert.deepEqual(list.expired(10, 0), []);
  assert.deepEqual(list.idle(), [done]);
});

test('getCurrentBuffer outside execute is empty; Buffers carry Buffer.prototype', () => {
  const p = new HTTPParser();
  p.initialize(HTTPParser.REQUEST, {});
  const b = p.getCurrentBuffer();
  assert.ok(Buffer.isBuffer(b));
  assert.equal(b.length, 0);
});
