// V8 lets Node see through a Proxy (util.types.isProxy, inspect's target/handler); a browser
// doesn't. The global Proxy is swapped for one that records what each proxy was made of, before
// Node's bootstrap captures it. Proxies the runtime makes for itself (vm globals, process.env, …)
// use NativeProxy, so they stay as invisible as V8's interceptor objects are under Node.

export const NativeProxy = Proxy;

/** proxy → [target, handler]; both null once revoked */
const records = new WeakMap<object, [object | null, object | null]>();

export function installProxyTracking() {
  const g = globalThis as any;
  if (g.Proxy !== NativeProxy) return;
  const tracked = new NativeProxy(NativeProxy, {
    construct(target, args, newTarget) {
      const p = Reflect.construct(target, args, newTarget);
      records.set(p, [args[0], args[1]]);
      return p;
    },
  });
  const nativeRevocable = NativeProxy.revocable;
  const revocable = new NativeProxy(nativeRevocable, {
    apply(target, thisArg, args) {
      const r = Reflect.apply(target, thisArg, args) as { proxy: object; revoke: () => void };
      const record: [object | null, object | null] = [args[0], args[1]];
      records.set(r.proxy, record);
      r.revoke = new NativeProxy(r.revoke, {
        apply(revoke, self, a) {
          record[0] = record[1] = null;
          return Reflect.apply(revoke, self, a);
        },
      });
      return r;
    },
  });
  Object.defineProperty(NativeProxy, 'revocable', { value: revocable, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(g, 'Proxy', { value: tracked, writable: true, enumerable: false, configurable: true });
}

export function isProxy(v: unknown): boolean {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && records.has(v);
}

/** internalBinding('util').getProxyDetails: [target, handler], or the target alone. */
export function getProxyDetails(v: unknown, full = true): unknown {
  if (!isProxy(v)) return undefined;
  const [target, handler] = records.get(v as object)!;
  return full ? [target, handler] : target;
}
