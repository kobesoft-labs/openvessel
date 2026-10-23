// internalBinding('v8') — node_v8.cc. The browser exposes no heap internals; the statistics are
// plausible numbers derived from performance.memory (Chromium) where it exists, laid out the way
// lib/v8.js reads them. Flags are accepted and remembered but change nothing.

import { fromShape } from './shape.ts';

// Captured before Node's bootstrap replaces globalThis.performance with perf_hooks' object.
const nativePerformance: any = (globalThis as any).performance;

// What Node 22.20.0 returns for v8.cachedDataVersionTag() with default flags (linux x64).
const CACHED_DATA_VERSION_TAG = 725907450;

const DEFAULT_LIMIT = 4345298944;

function memory() {
  const m = nativePerformance?.memory;
  const used: number = m?.usedJSHeapSize || 4e6;
  const total: number = Math.max(m?.totalJSHeapSize || used * 1.35, used);
  const limit: number = m?.jsHeapSizeLimit || DEFAULT_LIMIT;
  return { used, total, limit };
}

// Share of the heap per space, in kHeapSpaces order: [size, used].
const SPACE_SHARE: Record<string, [number, number]> = {
  read_only_space: [0, 0],
  new_space: [0.19, 0.095],
  old_space: [0.54, 0.675],
  code_space: [0.05, 0.004],
  shared_space: [0, 0],
  trusted_space: [0.17, 0.166],
  new_large_object_space: [0, 0],
  large_object_space: [0.05, 0.066],
  code_large_object_space: [0, 0],
  shared_large_object_space: [0, 0],
  trusted_large_object_space: [0, 0],
};

/** The flags passed to v8.setFlagsFromString(), by name (without the leading dashes). */
export const v8Flags = new Map<string, string | boolean>();

function parseFlags(flags: string) {
  for (const f of flags.split(/\s+/)) {
    const m = /^--?(no-?)?([\w-]+)(?:=(.*))?$/.exec(f);
    if (!m) continue;
    const name = m[2].replace(/_/g, '-');
    v8Flags.set(name, m[3] ?? !m[1]);
  }
}

export function createV8() {
  const b = fromShape('v8');
  const heap = b.heapStatisticsBuffer as Float64Array;
  const code = b.heapCodeStatisticsBuffer as Float64Array;
  const space = b.heapSpaceStatisticsBuffer as Float64Array;
  const spaces = b.kHeapSpaces as string[];
  class GCProfiler {
    private startTime = 0;
    start() {
      this.startTime = Date.now();
    }
    stop() {
      // V8 does not report collections to the page; the profile has no entries.
      return JSON.stringify({ version: 1, startTime: this.startTime, statistics: [], endTime: Date.now() });
    }
  }
  return Object.assign(b, {
    cachedDataVersionTag: () => CACHED_DATA_VERSION_TAG,
    setFlagsFromString(flags: unknown) {
      parseFlags(String(flags));
    },
    setHeapSnapshotNearHeapLimit: () => {},
    updateHeapStatisticsBuffer() {
      const { used, total, limit } = memory();
      heap[b.kTotalHeapSizeIndex] = total;
      heap[b.kTotalHeapSizeExecutableIndex] = 262144;
      heap[b.kTotalPhysicalSizeIndex] = Math.round(total * 0.97);
      heap[b.kTotalAvailableSize] = Math.max(0, limit - used);
      heap[b.kUsedHeapSizeIndex] = used;
      heap[b.kHeapSizeLimitIndex] = limit;
      heap[b.kMallocedMemoryIndex] = 163968;
      heap[b.kPeakMallocedMemoryIndex] = 1048576;
      heap[b.kDoesZapGarbageIndex] = 0;
      heap[b.kNumberOfNativeContextsIndex] = 1;
      heap[b.kNumberOfDetachedContextsIndex] = 0;
      heap[b.kTotalGlobalHandlesSizeIndex] = 8192;
      heap[b.kUsedGlobalHandlesSizeIndex] = 2304;
      heap[b.kExternalMemoryIndex] = 1505528;
    },
    updateHeapCodeStatisticsBuffer() {
      const { used } = memory();
      code[b.kCodeAndMetadataSizeIndex] = Math.round(used * 0.004);
      code[b.kBytecodeAndMetadataSizeIndex] = Math.round(used * 0.14);
      code[b.kExternalScriptSourceSizeIndex] = Math.round(used * 0.37);
      code[b.kCPUProfilerMetaDataSizeIndex] = 0;
    },
    updateHeapSpaceStatisticsBuffer(i: number) {
      const { used, total } = memory();
      const [sizeShare, usedShare] = SPACE_SHARE[spaces[i]] ?? [0, 0];
      const size = Math.round(total * sizeShare);
      const u = Math.min(size, Math.round(used * usedShare));
      space[b.kSpaceSizeIndex] = size;
      space[b.kSpaceUsedSizeIndex] = u;
      space[b.kSpaceAvailableSizeIndex] = size - u;
      space[b.kPhysicalSpaceSizeIndex] = size;
    },
    getCppHeapStatistics: (_level: number) => ({
      committed_size_bytes: 0,
      resident_size_bytes: 0,
      used_size_bytes: 0,
      space_statistics: [],
      type_names: [],
    }),
    isStringOneByteRepresentation(s: string) {
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
      return true;
    },
    GCProfiler,
  });
}
