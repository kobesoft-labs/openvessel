// Preview relay frame (hidden, on the preview origin). Registers the preview service
// worker and gives it the kernel's preview channel (HTTP/WebSocket only).

let kernelPort: MessagePort | null = null;
let defaultPort = 0;

async function ensureSw(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(new URL('../__ov-sw.js', location.href), { scope: new URL('../', location.href).pathname });
  await navigator.serviceWorker.ready;
  return reg;
}

async function handOver() {
  const reg = await ensureSw();
  const sw = reg.active;
  if (!sw || !kernelPort) return;
  // the SW keeps the channel; if it restarts it asks us (via the parent) for a new one
  sw.postMessage({ t: 'kernel-port', port: kernelPort, defaultPort }, [kernelPort]);
  kernelPort = null;
}

navigator.serviceWorker.addEventListener('message', (ev) => {
  if (ev.data?.t === 'need-kernel-port') window.parent.postMessage({ t: 'openvessel-preview-need-port' }, '*');
});

// only the host page hands over channels, not a preview page that opened the relay in a frame of its
// own. A preview page is under the service worker's scope; a host on the same origin (one-origin
// deployments such as GitHub Pages, where previews can reach the host anyway) is outside it.
const scope = new URL('../', location.href).pathname;
let fromHost = window.parent !== window;
try {
  const parent = window.parent.location;
  if (parent.origin === location.origin && parent.pathname.startsWith(scope)) fromHost = false;
} catch {
  // another origin: the host
}

window.addEventListener('message', async (ev) => {
  if (ev.source !== window.parent || !fromHost) return;
  const d = ev.data;
  if (d?.t === 'openvessel-preview-connect' && d.port instanceof MessagePort) {
    kernelPort = d.port;
    if (typeof d.defaultPort === 'number') defaultPort = d.defaultPort;
    await handOver();
    window.parent.postMessage({ t: 'openvessel-preview-ready' }, '*');
  } else if (d?.t === 'openvessel-preview-default-port') {
    defaultPort = d.port;
    const reg = await ensureSw();
    reg.active?.postMessage({ t: 'default-port', port: defaultPort });
  }
});

ensureSw().then(() => window.parent.postMessage({ t: 'openvessel-preview-loaded' }, '*'));

export {};
