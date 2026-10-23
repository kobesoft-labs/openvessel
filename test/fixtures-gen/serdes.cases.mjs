// Inputs for internalBinding('serdes'): values serialized the way lib/v8.js does it (DefaultSerializer:
// array buffer views as host objects) and with the plain Serializer, the bytes read back, and
// hand-written byte sequences for the deserializer. Runs against the real binding (fixture
// generation) and against OpenVessel's (unit test).

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const toHex = (u8) => {
  const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
};
export const fromHex = (h) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};

const viewTypes = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView, null, BigInt64Array, BigUint64Array];

/** DefaultSerializer / DefaultDeserializer from lib/v8.js, over a given binding. */
export function makeClasses({ Serializer, Deserializer }) {
  class Ser extends Serializer {}
  Ser.prototype._getDataCloneError = Error;
  class DefaultSer extends Ser {
    constructor() {
      super();
      this._setTreatArrayBufferViewsAsHostObjects(true);
    }
    _writeHostObject(abView) {
      let i = 10;
      if (!(typeof Buffer !== 'undefined' && abView.constructor === Buffer)) {
        i = viewTypes.indexOf(abView.constructor);
        if (i === -1) i = viewTypes.findIndex((C) => C && abView instanceof C);
        if (i === -1) throw new this._getDataCloneError('Unserializable host object');
      }
      this.writeUint32(i);
      this.writeUint32(abView.byteLength);
      this.writeRawBytes(new Uint8Array(abView.buffer, abView.byteOffset, abView.byteLength));
    }
  }
  class DefaultDes extends Deserializer {
    _readHostObject() {
      const typeIndex = this.readUint32();
      const ctor = typeIndex === 10 ? Uint8Array : viewTypes[typeIndex];
      const byteLength = this.readUint32();
      const byteOffset = this._readRawBytes(byteLength);
      const per = ctor.BYTES_PER_ELEMENT || 1;
      const copy = new Uint8Array(byteLength);
      copy.set(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + byteOffset, byteLength));
      return new ctor(copy.buffer, 0, byteLength / per);
    }
  }
  return { Ser, DefaultSer, Des: Deserializer, DefaultDes };
}

/** A JSON-able description of a value, stable across runtimes (cycles become {ref}). */
export function describe(v, seen = new Map()) {
  switch (typeof v) {
    case 'undefined':
      return { t: 'undefined' };
    case 'number':
      return { t: 'number', v: Object.is(v, -0) ? '-0' : String(v) };
    case 'bigint':
      return { t: 'bigint', v: String(v) };
    case 'string':
      return { t: 'string', v };
    case 'boolean':
      return { t: 'boolean', v };
    case 'symbol':
      return { t: 'symbol', v: String(v) };
    case 'function':
      return { t: 'function' };
  }
  if (v === null) return { t: 'null' };
  if (seen.has(v)) return { ref: seen.get(v) };
  const id = seen.size;
  seen.set(v, id);
  const tag = Object.prototype.toString.call(v).slice(8, -1);
  const out = { id, tag, proto: protoName(v) };
  const props = (skip) =>
    Object.keys(v)
      .filter((k) => !skip(k))
      .map((k) => [k, describe(v[k], seen)]);
  if (Array.isArray(v)) {
    out.length = v.length;
    out.props = props(() => false);
  } else if (tag === 'Date') out.time = String(v.getTime());
  else if (tag === 'RegExp') Object.assign(out, { source: v.source, flags: v.flags });
  else if (tag === 'Map') out.entries = [...v].map(([k, x]) => [describe(k, seen), describe(x, seen)]);
  else if (tag === 'Set') out.values = [...v].map((x) => describe(x, seen));
  else if (tag === 'ArrayBuffer') Object.assign(out, { bytes: toHex(new Uint8Array(v)), resizable: !!v.resizable, max: v.maxByteLength });
  else if (ArrayBuffer.isView(v)) Object.assign(out, { bytes: toHex(v), byteLength: v.byteLength });
  else if (tag === 'Error') {
    const own = (k) => Object.getOwnPropertyDescriptor(v, k);
    Object.assign(out, {
      name: v.name,
      message: own('message') ? { v: own('message').value } : null,
      stack: own('stack') ? describe(v.stack, seen) : null,
      cause: own('cause') ? describe(own('cause').value, seen) : null,
    });
  } else if (tag === 'Number' || tag === 'String' || tag === 'Boolean' || tag === 'BigInt') out.value = describe(v.valueOf(), seen);
  else out.props = props(() => false);
  return out;
}

function protoName(v) {
  const p = Object.getPrototypeOf(v);
  if (p === null) return null;
  return Object.getOwnPropertyDescriptor(p, 'constructor')?.value?.name ?? '?';
}

function errorOf(e) {
  return { error: `${e?.name}: ${e?.message}`, code: e?.code };
}

const stacked = (e, stack = 'STACK') => {
  e.stack = stack;
  return e;
};

/** name → () => value. Values are built fresh for each run. */
export const values = {
  undefined: () => undefined,
  null: () => null,
  true: () => true,
  false: () => false,
  zero: () => 0,
  negZero: () => -0,
  one: () => 1,
  minusOne: () => -1,
  i63: () => 63,
  i64: () => 64,
  im64: () => -64,
  im65: () => -65,
  i127: () => 127,
  i128: () => 128,
  i2p30m1: () => 2 ** 30 - 1,
  i2p30: () => 2 ** 30,
  i2p31m1: () => 2 ** 31 - 1,
  i2p31: () => 2 ** 31,
  im2p31: () => -(2 ** 31),
  im2p31m1: () => -(2 ** 31) - 1,
  i2p32: () => 2 ** 32,
  half: () => 1.5,
  nan: () => NaN,
  inf: () => Infinity,
  ninf: () => -Infinity,
  maxSafe: () => Number.MAX_SAFE_INTEGER,
  minDenorm: () => 5e-324,
  big0: () => 0n,
  big1: () => 1n,
  bigm1: () => -1n,
  big2p64: () => 2n ** 64n,
  bigm2p64: () => -(2n ** 64n),
  big2p63m1: () => 2n ** 63n - 1n,
  bigHuge: () => 12345678901234567890123456789012345678901234567890n,
  strEmpty: () => '',
  strAscii: () => 'abc',
  strLatin1: () => 'é ÿ',
  strCJK: () => '日本語',
  strEmoji: () => '😀',
  strLong: () => 'a'.repeat(200),
  strMixed: () => 'aé日',
  strLoneSurrogate: () => '\ud800x',
  strPadArr: () => ['日', 'x日', 'ab', '本'],
  strPadObj1: () => ({ a: '日' }),
  strPadObj2: () => ({ ab: '日', cde: 'ü', f: '語' }),
  strLongTwoByte: () => '日'.repeat(100),
  objEmpty: () => ({}),
  objOne: () => ({ a: 1 }),
  objMixed: () => ({ a: 1, b: 'x', c: [1, 2], d: { e: null } }),
  objIndexKeys: () => ({ b: 2, 1: 'a', 0: 'z' }),
  objBigIndexKeys: () => ({ 4294967294: 1, 4294967295: 2, 2147483647: 3, 2147483648: 4 }),
  objOddKeys: () => ({ '-1': 1, '01': 2, 1.5: 3, '': 4 }),
  objNullProto: () => Object.assign(Object.create(null), { x: 1 }),
  objClass: () => {
    class Foo {
      constructor() {
        this.a = 1;
      }
      m() {}
    }
    return new Foo();
  },
  objProtoKey: () => JSON.parse('{"__proto__": 1, "a": 2}'),
  objGetter: () => ({
    get x() {
      return 5;
    },
    y: 1,
  }),
  objNonEnum: () => Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }),
  objSymbolKey: () => ({ [Symbol('s')]: 1, a: 2 }),
  objNested: () => ({ a: { b: { c: { d: [{}] } } } }),
  arrEmpty: () => [],
  arrSmi: () => [1, 2, 3],
  arrDouble: () => [1.5, 2],
  arrMixed: () => [1, 'a'],
  arrMixedDouble: () => [1.5, 'a', 2],
  arrUndefNull: () => [undefined, null],
  arrHoleFirst: () => [, 1], // eslint-disable-line no-sparse-arrays
  arrHoleMid: () => [1, , 3], // eslint-disable-line no-sparse-arrays
  arrSparse: () => {
    const a = [];
    a[9] = 'x';
    return a;
  },
  arrSparseProps: () => {
    const a = [1, , 3]; // eslint-disable-line no-sparse-arrays
    a.foo = 'bar';
    return a;
  },
  arrExtraProp: () => Object.assign([1, 2], { foo: 1 }),
  arrNested: () => [[1], [[2]], []],
  arrBigNum: () => [2 ** 31],
  arrNegZero: () => [-0],
  arrNaN: () => [NaN, 1],
  arrStrings: () => ['a', 'b'],
  arrObjects: () => [{ a: 1 }, { b: 2 }],
  refShared: () => {
    const o = { x: 1 };
    return [o, o, { o }];
  },
  refSelfArray: () => {
    const a = [];
    a.push(a);
    return a;
  },
  refSelfObject: () => {
    const o = { a: 1 };
    o.self = o;
    return o;
  },
  refMap: () => {
    const m = new Map();
    m.set(m, m);
    return m;
  },
  dateEpoch: () => new Date(0),
  date: () => new Date(1.5e12),
  dateInvalid: () => new Date(NaN),
  reSimple: () => /a/,
  reFlags: () => /a+b/gimsuy,
  reIndices: () => /x/d,
  reEmpty: () => new RegExp(''),
  reSlash: () => /\/[/]/,
  reUnicodeSets: () => /[\p{L}--[a-z]]/v,
  reTwoByte: () => /日本/,
  mapEmpty: () => new Map(),
  map: () => new Map([[1, 'a'], [{}, []], ['k', new Map()]]),
  set: () => new Set([1, 'a', {}, [2]]),
  setEmpty: () => new Set(),
  mapWithProps: () => Object.assign(new Map([[1, 2]]), { extra: 1 }),
  boxNumber: () => Object(1),
  boxNegZero: () => Object(-0),
  boxTrue: () => Object(true),
  boxFalse: () => Object(false),
  boxString: () => Object('str'),
  boxStringTwoByte: () => Object('日'),
  boxBigInt: () => Object(1n),
  abEmpty: () => new ArrayBuffer(0),
  ab: () => Uint8Array.of(1, 2, 3).buffer,
  abResizable: () => {
    const ab = new ArrayBuffer(4, { maxByteLength: 8 });
    new Uint8Array(ab).set([9, 8, 7, 6]);
    return ab;
  },
  u8: () => Uint8Array.of(1, 2, 3),
  i8: () => Int8Array.of(-1, 2),
  u8c: () => Uint8ClampedArray.of(255, 0),
  i16: () => Int16Array.of(-2, 3),
  u16: () => Uint16Array.of(65535),
  i32: () => Int32Array.of(-5),
  u32: () => Uint32Array.of(4294967295, 1),
  f32: () => Float32Array.of(1.5, -0),
  f64: () => Float64Array.of(Math.PI),
  bi64: () => BigInt64Array.of(-1n),
  bu64: () => BigUint64Array.of(2n ** 64n - 1n),
  dataView: () => new DataView(Uint8Array.of(1, 2, 3, 4).buffer, 1, 2),
  u8Sub: () => Uint8Array.of(0, 1, 2, 3, 4, 5).subarray(2, 4),
  u16Offset: () => new Uint16Array(Uint8Array.of(0, 0, 1, 0, 2, 0).buffer, 2, 2),
  viewEmpty: () => new Uint8Array(0),
  buffer: () => (typeof Buffer !== 'undefined' ? Buffer.from('hi') : Uint8Array.of(104, 105)),
  viewShared: () => {
    const u = Uint8Array.of(7);
    return [u, u];
  },
  viewAndBuffer: () => {
    const u = Uint8Array.of(1, 2, 3, 4);
    return { ab: u.buffer, u, f: new Uint16Array(u.buffer, 2, 1) };
  },
  error: () => stacked(new Error('boom')),
  typeError: () => stacked(new TypeError('t')),
  rangeError: () => stacked(new RangeError('r')),
  evalError: () => stacked(new EvalError('e')),
  referenceError: () => stacked(new ReferenceError('f')),
  syntaxError: () => stacked(new SyntaxError('s')),
  uriError: () => stacked(new URIError('u')),
  errorNoMessage: () => stacked(new Error()),
  errorCause: () => stacked(new Error('outer', { cause: stacked(new TypeError('inner'), 'S2') })),
  errorCausePrimitive: () => stacked(new Error('x', { cause: 42 })),
  errorSubclass: () => {
    class MyErr extends RangeError {}
    return stacked(new MyErr('m'));
  },
  errorRenamed: () => {
    const e = stacked(new Error('n'));
    e.name = 'TypeError';
    return e;
  },
  errorCustomName: () => {
    const e = stacked(new Error('n'));
    e.name = 'Custom';
    return e;
  },
  errorExtraProps: () => Object.assign(stacked(new Error('p')), { code: 'E_X', extra: 1 }),
  errorNonStringStack: () => stacked(new Error('q'), 42),
  errorNonStringMessage: () => {
    const e = stacked(new Error());
    e.message = 12;
    return e;
  },
  errorTwoByte: () => stacked(new Error('日本'), 'スタック'),
  errorInArray: () => [stacked(new Error('a')), 1],
  // built from source text, so that bundling the cases does not reformat it
  mapSubclass: () => {
    class M extends Map {}
    return new M([[1, 2]]);
  },
  dateSubclass: () => {
    class D extends Date {}
    return new D(5);
  },
  errorCauseSelf: () => {
    const e = stacked(new Error('self'));
    e.cause = e;
    return e;
  },
  arrLong: () => {
    const a = [];
    for (let i = 0; i < 200; i++) a.push(i * 3);
    return a;
  },
  arrFilled: () => new Array(3).fill(0),
  arrFrom: () => Array.from({ length: 3 }, (_, i) => i),
  objManyKeys: () => {
    const o = {};
    for (let i = 0; i < 150; i++) o['k' + i] = i;
    delete o.k5;
    return o;
  },
  objGetterDeletes: () => ({
    get a() {
      delete this.b;
      return 1;
    },
    b: 2,
    c: 3,
  }),
  rabViews: () => {
    const rab = new ArrayBuffer(4, { maxByteLength: 8 });
    return [new Uint8Array(rab), new Uint8Array(rab, 0, 2), new DataView(rab, 1)];
  },
  fn: () => (0, eval)('(() => {})'),
  namedFn: () => new Function('a', 'b', 'return a + b'),
  longFn: () => new Function('x', `return x + ${'1 + '.repeat(60)}0`),
  symbol: () => Symbol('sym'),
  symbolInObject: () => ({ a: Symbol() }),
  weakMap: () => new WeakMap(),
  weakSet: () => new WeakSet(),
  promise: () => Promise.resolve(1),
  arguments: () =>
    (function () {
      return arguments; // eslint-disable-line prefer-rest-params
    })(1, 2),
  generator: () => (function* () {})(),
  mapIterator: () => new Map().keys(),
  boxSymbol: () => Object(Symbol('b')),
  sab: () => new SharedArrayBuffer(4),
  detached: () => {
    const ab = new ArrayBuffer(8);
    structuredClone(ab, { transfer: [ab] });
    return ab;
  },
};

/** Values for the plain Serializer (array buffer views written by V8, not as host objects). */
export const plainValues = ['rabViews', 'u8', 'i8', 'u8c', 'i16', 'u16', 'i32', 'u32', 'f32', 'f64', 'bi64', 'bu64', 'dataView', 'u8Sub', 'u16Offset', 'viewEmpty', 'viewShared', 'viewAndBuffer', 'ab', 'abResizable', 'objMixed', 'error'];

/** Hand-written inputs for the deserializer. */
export const rawInputs = [
  'ff0f4902',
  '4902', // no header
  'ff0d4902', // version 13
  'ff0e4902',
  'ff104902', // newer than supported
  'ff0f',
  'ff0f49',
  'ff0f000049ff',
  'ff0f55ffffffff0f',
  'ff0f5303e697a5',
  'ff0f53026869',
  'ff0f3f0149ff', // verify-object-count
  'ff0f5e00', // reference to an unknown id
  'ff0f41032d49022d240003', // dense array with holes
  'ff0f61034902220178400103', // sparse array
  'ff0f6f2201614902', // unterminated object
  'ff0f6f22016149027b02', // wrong property count
  'ff0f630361', // odd two-byte length
  'ff0f630261', // truncated two-byte
  'ff0f5222016100', // regexp, no flags
  'ff0f52220161ff07', // regexp, bad flags
  'ff0f52220128ff00', // regexp, bad pattern
  'ff0f42040102030456420001020000', // ArrayBuffer + Uint8Array view
  'ff0f4204010203045664000400', // Int32Array view, flags missing
  'ff0f420401020304566401040000', // misaligned Int32Array view
  'ff0f42040102030456770008020000', // view past the end
  'ff0f740000', // transferred buffer that was not registered
  'ff0f5a10ffffffffffffffff', // BigInt
  'ff0f5a0101', // BigInt length not a multiple of 8? (1 byte -> bitfield 2 with sign? )
  'ff0f72012e', // Error with eval prototype
  'ff0f72066d22017873220173632249022e', // Error with message, stack, cause
  'ff0f7a', // truncated
  'ff0f7e0204010203', // resizable, max < length
  'ff0f2a', // unknown tag
  'ff0f6f490122017e7b01', // key not string/number? (number key)
  'ff0f6f6f7b007b01', // object as key
  'ff0f3b49024904493a02', // map with odd count (count mismatch)
  'ff0f27490249042c02', // set
  'ff0f75000000', // SharedArrayBuffer id
  'ff0f5c', // host object
];

/** Integers for the Serializer's raw writes. */
const uint32s = [0, 1, 127, 128, 255, 16383, 16384, 2 ** 31, 2 ** 32 - 1, -1, 2 ** 32, 1.9, '12', NaN];
const uint64s = [[0, 0], [0, 1], [1, 0], [0xffffffff, 0xffffffff], [0x12345678, 0x9abcdef0]];
const doubles = [0, -0, 1.5, NaN, Infinity, 1e300];

function run1(fn) {
  try {
    return fn();
  } catch (e) {
    return errorOf(e);
  }
}

export function serializeWith(C, v, setup) {
  const s = new C();
  setup?.(s);
  s.writeHeader();
  s.writeValue(v);
  return toHex(s.releaseBuffer());
}

export function deserializeWith(C, hex, setup) {
  const d = new C(fromHex(hex));
  setup?.(d);
  d.readHeader();
  const v = d.readValue();
  return describe(v);
}

export function run(binding) {
  const { Ser, DefaultSer, Des, DefaultDes } = makeClasses(binding);
  const results = { serialize: [], plain: [], raw: [], rawPlain: [], methods: [], transfer: [], sab: [] };
  for (const [name, make] of Object.entries(values)) {
    const ser = run1(() => serializeWith(DefaultSer, make()));
    const r = typeof ser === 'string' ? { hex: ser, back: run1(() => deserializeWith(DefaultDes, ser)) } : ser;
    results.serialize.push({ args: [name], r });
  }
  for (const name of plainValues) {
    const ser = run1(() => serializeWith(Ser, values[name]()));
    const r = typeof ser === 'string' ? { hex: ser, back: run1(() => deserializeWith(Des, ser)) } : ser;
    results.plain.push({ args: [name], r });
  }
  for (const hex of rawInputs) {
    results.raw.push({ args: [hex], r: run1(() => deserializeWith(DefaultDes, hex)) });
    results.rawPlain.push({ args: [hex], r: run1(() => deserializeWith(Des, hex)) });
  }
  // the raw read/write methods
  for (const n of uint32s) results.methods.push({ args: ['writeUint32', String(n)], r: run1(() => { const s = new Ser(); s.writeUint32(n); return toHex(s.releaseBuffer()); }) });
  for (const [hi, lo] of uint64s) results.methods.push({ args: ['writeUint64', hi, lo], r: run1(() => { const s = new Ser(); s.writeUint64(hi, lo); const hex = toHex(s.releaseBuffer()); const d = new Des(fromHex(hex)); return [hex, d.readUint64()]; }) });
  for (const n of doubles) results.methods.push({ args: ['writeDouble', String(n)], r: run1(() => { const s = new Ser(); s.writeDouble(n); const hex = toHex(s.releaseBuffer()); return [hex, String(new Des(fromHex(hex)).readDouble())]; }) });
  results.methods.push({ args: ['writeRawBytes'], r: run1(() => { const s = new Ser(); s.writeRawBytes(Uint16Array.of(0x102, 0x304)); s.writeRawBytes(new DataView(Uint8Array.of(9, 8, 7).buffer, 1)); return toHex(s.releaseBuffer()); }) });
  results.methods.push({ args: ['writeRawBytes bad'], r: run1(() => new Ser().writeRawBytes([1, 2])) });
  results.methods.push({ args: ['release twice'], r: run1(() => { const s = new Ser(); s.writeHeader(); s.writeValue(1); const a = toHex(s.releaseBuffer()); s.writeValue(2); return [a, toHex(s.releaseBuffer())]; }) });
  results.methods.push({ args: ['writeValue returns'], r: run1(() => { const s = new Ser(); return [s.writeHeader() ?? 'undef', s.writeValue(1)]; }) });
  results.methods.push({ args: ['readUint32'], r: run1(() => { const d = new Des(Uint8Array.of(0x80, 0x01, 0xff, 0xff, 0xff, 0xff, 0x0f)); return [d.readUint32(), d.readUint32()]; }) });
  results.methods.push({ args: ['readUint32 eof'], r: run1(() => new Des(Uint8Array.of(0x80)).readUint32()) });
  results.methods.push({ args: ['readUint64 eof'], r: run1(() => new Des(Uint8Array.of()).readUint64()) });
  results.methods.push({ args: ['readDouble eof'], r: run1(() => new Des(Uint8Array.of(1, 2)).readDouble()) });
  results.methods.push({ args: ['_readRawBytes'], r: run1(() => { const d = new Des(Uint8Array.of(1, 2, 3, 4, 5)); return [d._readRawBytes(2), d._readRawBytes(3)]; }) });
  results.methods.push({ args: ['_readRawBytes eof'], r: run1(() => new Des(Uint8Array.of(1))._readRawBytes(2)) });
  results.methods.push({ args: ['readHeader returns'], r: run1(() => { const d = new Des(fromHex('ff0f4902')); return [d.getWireFormatVersion(), d.readHeader(), d.getWireFormatVersion()]; }) });
  results.methods.push({ args: ['version no header'], r: run1(() => { const d = new Des(fromHex('4902')); return [d.readHeader(), d.getWireFormatVersion()]; }) });
  results.methods.push({ args: ['Deserializer bad arg'], r: run1(() => new Des('abc')) });
  results.methods.push({ args: ['Deserializer buffer prop'], r: run1(() => { const u = Uint8Array.of(1); return new Des(u).buffer === u; }) });
  results.methods.push({ args: ['Serializer call'], r: run1(() => binding.Serializer()) });
  results.methods.push({ args: ['Deserializer call'], r: run1(() => binding.Deserializer(Uint8Array.of())) });
  results.methods.push({ args: ['transferArrayBuffer bad'], r: run1(() => new Ser().transferArrayBuffer(0, new Uint8Array(1))) });
  results.methods.push({ args: ['des transferArrayBuffer bad'], r: run1(() => new Des(Uint8Array.of()).transferArrayBuffer(0, {})) });
  results.methods.push({ args: ['readHostObject non-object'], r: run1(() => { const d = new Des(fromHex('ff0f5c')); d._readHostObject = () => 1; d.readHeader(); return d.readValue(); }) });
  results.methods.push({ args: ['no writeHostObject'], r: run1(() => serializeWith(Ser, new Uint8Array(1), (s) => { s._setTreatArrayBufferViewsAsHostObjects(true); })) });
  results.methods.push({ args: ['custom getDataCloneError'], r: run1(() => serializeWith(Ser, Symbol('q'), (s) => { s._getDataCloneError = (m) => ({ name: 'Custom', message: m }); })) });
  // ArrayBuffer transfer
  results.transfer.push({ args: ['transfer'], r: run1(() => {
    const ab = Uint8Array.of(1, 2).buffer;
    const hex = serializeWith(Ser, [ab, new Uint8Array(ab, 1), ab], (s) => s.transferArrayBuffer(3, ab));
    const back = deserializeWith(Des, hex, (d) => d.transferArrayBuffer(3, Uint8Array.of(5, 6).buffer));
    return { hex, back };
  }) });
  results.transfer.push({ args: ['transfer view host'], r: run1(() => {
    const ab = Uint8Array.of(1, 2).buffer;
    return serializeWith(DefaultSer, { ab, u: new Uint8Array(ab) }, (s) => s.transferArrayBuffer(0, ab));
  }) });
  // SharedArrayBuffer via the delegate hook
  results.sab.push({ args: ['sab id'], r: run1(() => {
    const sab = new SharedArrayBuffer(2);
    return serializeWith(Ser, [sab, sab, new Uint8Array(sab)], (s) => { s._getSharedArrayBufferId = () => 7; });
  }) });
  results.sab.push({ args: ['sab des'], r: run1(() => deserializeWith(Des, 'ff0f750700', (d) => d.transferArrayBuffer(7, new SharedArrayBuffer(3)))) });
  return results;
}
