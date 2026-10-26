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

// This frame's kernel runs under /__ov/k/<id>/: the service worker routes everything under that prefix
// (module loads, network checks) to this kernel, so several runtime frames can share the worker.
const KID = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

let kernel: Worker | null = null;

function connectSw() {
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl || !kernel) return;
  const ch = new MessageChannel();
  kernel.postMessage({ t: 'sw-port', port: ch.port1 }, [ch.port1]);
  ctrl.postMessage({ t: 'kernel-port', port: ch.port2, kid: KID }, [ch.port2]);
}

const NOT_ISOLATED =
  'OpenVessel needs a cross-origin isolated page (COOP: same-origin and COEP: require-corp/credentialless on the host page, and allow="cross-origin-isolated" on the iframe).';

async function start(hostPort: MessagePort, init: { policy?: unknown }) {
  // the worker first: it is also what makes this frame isolated on hosts that can't set headers
  try {
    await waitForController();
  } catch (e) {
    fail(`service worker registration failed: ${(e as Error).message}`);
    return;
  }
  if (!crossOriginIsolated) {
    fail(NOT_ISOLATED);
    return;
  }
  kernel = new Worker(new URL(`./__ov/k/${KID}/kernel.js`, location.href), { type: 'module', name: 'openvessel-kernel' });
  kernel.onerror = (e) => fail(`kernel failed: ${e.message}`);
  if (init.policy) kernel.postMessage({ t: 'policy', policy: init.policy });
  connectSw();
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.t === 'need-kernel-port' && (ev.data.kid == null || ev.data.kid === KID)) connectSw();
  });
  // a later update of the worker takes over the page: hand it the kernel connection too
  navigator.serviceWorker.addEventListener('controllerchange', connectSw);
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
  // (Firefox has no ancestorOrigins: there the parent must be the top-level window)
  if (ancestors ? ancestors.length > 1 : window.parent !== window.top) {
    fail('the runtime must be embedded directly by the host page');
    return;
  }
  started = true;
  start(d.port, d.init ?? {});
});

/**
 * Static hosts that can't set headers: the service worker adds the isolation headers to this frame's
 * document, but only to loads it controls. Register it first and reload once (like coi-sw), so a frame
 * that could load without the headers gets them; start() reports it if the page is still not isolated.
 */
const RELOAD_FLAG = 'openvessel-coi-reload';
async function boot() {
  let reloaded = false;
  try {
    reloaded = sessionStorage.getItem(RELOAD_FLAG) === '1';
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {}
  if (!crossOriginIsolated && !reloaded && 'serviceWorker' in navigator) {
    try {
      await waitForController();
      if (!crossOriginIsolated) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        location.reload();
        return;
      }
    } catch {
      // registration failures are reported by start()
    }
  }
  window.parent.postMessage({ t: 'openvessel-runtime-loaded' }, '*');
}
void boot();

export {};
