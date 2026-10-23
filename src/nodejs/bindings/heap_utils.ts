// internalBinding('heap_utils') — heap_utils.cc. A page cannot walk its own V8 heap, so heap
// snapshots (v8.writeHeapSnapshot, v8.getHeapSnapshot, --heapsnapshot-signal) are unavailable.

import { fromShape } from './shape.ts';

function unavailable(feature: string): never {
  const e = new TypeError(`The feature ${feature} is unavailable on the current platform, which is being used to run Node.js`) as TypeError & { code: string };
  e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  throw e;
}

export function createHeapUtils() {
  return Object.assign(fromShape('heap_utils'), {
    buildEmbedderGraph: () => unavailable('heap snapshots'),
    triggerHeapSnapshot: () => unavailable('heap snapshots'),
    createHeapSnapshotStream: () => unavailable('heap snapshots'),
  });
}
