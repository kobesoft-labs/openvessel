// The hidden runtime frame: registers the service worker, starts the kernel and
// hands the host a private channel to it.

const allowedMeta = document.querySelector<HTMLMetaElement>('meta[name="openvessel-allowed-hosts"]')?.content ?? '*';
const allowed = allowedMeta.split(/[\s,]+/).filter(Boolean);

function fail(msg: string) {
  window.parent.postMessage({ t: 'openvessel-error', message: msg }, '*');
}

function originAllowed(origin: string) {
  return allowed.includes('*') || allowed.includes(origin);
}

async function waitForController(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register(new URL('./sw.js', location.href), { scope: './', updateViaCache: 'none' });
  // a page loaded under an older worker must not start the kernel against it
  await reg.update().catch(() => {});
  if (reg.installing || reg.waiting) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  }
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(navigator.serviceWorker.controller!), { once: true });
    // claim() in the worker's activate handler makes this fire
    reg.active?.postMessage({ t: 'ping' });
  });
}

let kernel: Worker | null = null;

function connectSw() {
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl || !kernel) return;
  const ch = new MessageChannel();
  kernel.postMessage({ t: 'sw-port', port: ch.port1 }, [ch.port1]);
  ctrl.postMessage({ t: 'kernel-port', port: ch.port2 }, [ch.port2]);
}

async function start(hostPort: MessagePort, init: { policy?: unknown }) {
  if (!crossOriginIsolated) {
    fail('OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).');
    return;
  }
  try {
    await waitForController();
  } catch (e) {
    fail(`service worker registration failed: ${(e as Error).message}`);
    return;
  }
  kernel = new Worker(new URL('./kernel.js', location.href), { type: 'module', name: 'openvessel-kernel' });
  kernel.onerror = (e) => fail(`kernel failed: ${e.message}`);
  // a later update of the worker takes over the page: hand it the kernel connection too
  navigator.serviceWorker.addEventListener('controllerchange', connectSw);
  if (init.policy) kernel.postMessage({ t: 'policy', policy: init.policy });
  connectSw();
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.t === 'need-kernel-port') connectSw();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => connectSw());
  kernel.postMessage({ t: 'host-port', port: hostPort }, [hostPort]);
}

let started = false;
window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || started) return;
  const d = ev.data;
  if (d?.t !== 'openvessel-connect' || !(d.port instanceof MessagePort)) return;
  if (!originAllowed(ev.origin)) {
    fail(`origin ${ev.origin} is not allowed to use this runtime`);
    return;
  }
  // refuse being nested inside something other than the top-level host
  const ancestors = (location as any).ancestorOrigins as DOMStringList | undefined;
  if (ancestors && ancestors.length > 1) {
    fail('the runtime must be embedded directly by the host page');
    return;
  }
  started = true;
  start(d.port, d.init ?? {});
});

window.parent.postMessage({ t: 'openvessel-runtime-loaded' }, '*');

export {};
