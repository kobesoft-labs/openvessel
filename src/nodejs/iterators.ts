// Map and Set iterators as V8 shows them to Node: util.types.isMapIterator/isSetIterator and
// v8::Object::PreviewEntries (console.table, util.inspect). A brand check would have to call
// next(), which moves the iterator, so each iterator is recorded when it is made (with whether it
// yields [key, value] pairs). V8 reads the entries an iterator has left without moving it; here a
// preview drains the iterator into a buffer that its next() then serves.

import { NativeProxy } from './proxies.ts';

interface Kind {
  set: boolean;
  /** entries(): yields [key, value] */
  keyValue: boolean;
}

const mapIterProto = Object.getPrototypeOf(new Map().entries());
const setIterProto = Object.getPrototypeOf(new Set().values());
const nativeMapNext: Function = mapIterProto.next;
const nativeSetNext: Function = setIterProto.next;

const kinds = new WeakMap<object, Kind>();
const replays = new WeakMap<object, { items: unknown[]; i: number }>();

let installed = false;
/** Wraps the methods that make iterators (before Node's primordials take them). */
export function installIteratorTracking() {
  if (installed) return;
  installed = true;
  const wrap = (proto: any, name: string, kind: Kind) => {
    const fn = new NativeProxy(proto[name] as Function, {
      apply(target, self, args) {
        const it = Reflect.apply(target, self, args);
        kinds.set(it, kind);
        return it;
      },
    });
    Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: false, configurable: true });
    return fn;
  };
  // Map.prototype[@@iterator] is entries; Set.prototype.keys and [@@iterator] are values
  const mapEntries = wrap(Map.prototype, 'entries', { set: false, keyValue: true });
  wrap(Map.prototype, 'keys', { set: false, keyValue: false });
  wrap(Map.prototype, 'values', { set: false, keyValue: false });
  Object.defineProperty(Map.prototype, Symbol.iterator, { value: mapEntries, writable: true, enumerable: false, configurable: true });
  wrap(Set.prototype, 'entries', { set: true, keyValue: true });
  const setValues = wrap(Set.prototype, 'values', { set: true, keyValue: false });
  Object.defineProperty(Set.prototype, 'keys', { value: setValues, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(Set.prototype, Symbol.iterator, { value: setValues, writable: true, enumerable: false, configurable: true });
}

export const isMapIterator = (v: unknown) => typeof v === 'object' && v !== null && kinds.get(v)?.set === false;
export const isSetIterator = (v: unknown) => typeof v === 'object' && v !== null && kinds.get(v)?.set === true;

let replaying = false;
/** From the first preview on, next() of a previewed iterator serves what the preview took out. */
function installReplay() {
  if (replaying) return;
  replaying = true;
  const protos: [object, Function][] = [
    [mapIterProto, nativeMapNext],
    [setIterProto, nativeSetNext],
  ];
  for (let p = 0; p < protos.length; p++) {
    const next = new NativeProxy(protos[p][1], {
      apply(target, self, args) {
        const r = replays.get(self);
        if (!r) return Reflect.apply(target, self, args);
        if (r.i < r.items.length) return { value: r.items[r.i++], done: false };
        replays.delete(self);
        return { value: undefined, done: true };
      },
    });
    Object.defineProperty(protos[p][0], 'next', { value: next, writable: true, enumerable: false, configurable: true });
  }
}

/** [entries left, is key/value] for a Map or Set iterator (pairs flattened: key, value, …). */
export function previewIterator(it: object): [unknown[], boolean] {
  const kind = kinds.get(it)!;
  installReplay();
  let r = replays.get(it);
  if (!r) {
    const next = kind.set ? nativeSetNext : nativeMapNext;
    const items: unknown[] = [];
    for (let s = next.call(it); !s.done; s = next.call(it)) items.push(s.value);
    r = { items, i: 0 };
    replays.set(it, r);
  }
  const left = r.items.slice(r.i);
  if (!kind.keyValue) return [left, false];
  const flat: unknown[] = [];
  for (let i = 0; i < left.length; i++) flat.push((left[i] as unknown[])[0], (left[i] as unknown[])[1]);
  return [flat, true];
}
