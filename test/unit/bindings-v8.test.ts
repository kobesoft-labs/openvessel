import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createV8, v8Flags } from '../../src/nodejs/bindings/v8.ts';
import { createHeapUtils } from '../../src/nodejs/bindings/heap_utils.ts';

test("internalBinding('v8') fills the buffers lib/v8.js reads", () => {
  const b = createV8();
  b.updateHeapStatisticsBuffer();
  const h = b.heapStatisticsBuffer as Float64Array;
  assert.ok(h[b.kUsedHeapSizeIndex] > 0);
  assert.ok(h[b.kTotalHeapSizeIndex] >= h[b.kUsedHeapSizeIndex]);
  assert.ok(h[b.kHeapSizeLimitIndex] > h[b.kTotalHeapSizeIndex]);
  assert.equal(h[b.kNumberOfNativeContextsIndex], 1);
  b.updateHeapCodeStatisticsBuffer();
  assert.ok((b.heapCodeStatisticsBuffer as Float64Array)[b.kBytecodeAndMetadataSizeIndex] > 0);
  let sum = 0;
  for (let i = 0; i < b.kHeapSpaces.length; i++) {
    b.updateHeapSpaceStatisticsBuffer(i);
    const s = b.heapSpaceStatisticsBuffer as Float64Array;
    assert.ok(s[b.kSpaceUsedSizeIndex] <= s[b.kSpaceSizeIndex], b.kHeapSpaces[i]);
    assert.equal(s[b.kSpaceAvailableSizeIndex], s[b.kSpaceSizeIndex] - s[b.kSpaceUsedSizeIndex]);
    sum += s[b.kSpaceSizeIndex];
  }
  assert.ok(sum > 0);
  assert.equal(typeof b.cachedDataVersionTag(), 'number');
  assert.deepEqual(b.getCppHeapStatistics(b.detailLevel.BRIEF), { committed_size_bytes: 0, resident_size_bytes: 0, used_size_bytes: 0, space_statistics: [], type_names: [] });
  assert.equal(b.isStringOneByteRepresentation('abcé'), true);
  assert.equal(b.isStringOneByteRepresentation('日'), false);
  b.setFlagsFromString('--expose-gc --no-lazy --max_old_space_size=100');
  assert.equal(v8Flags.get('expose-gc'), true);
  assert.equal(v8Flags.get('lazy'), false);
  assert.equal(v8Flags.get('max-old-space-size'), '100');
  b.setHeapSnapshotNearHeapLimit(1);
  const p = new b.GCProfiler();
  p.start();
  const data = JSON.parse(p.stop());
  assert.equal(data.version, 1);
  assert.deepEqual(data.statistics, []);
});

test("internalBinding('heap_utils') reports heap snapshots as unavailable", () => {
  const b = createHeapUtils();
  for (const f of ['triggerHeapSnapshot', 'createHeapSnapshotStream', 'buildEmbedderGraph']) {
    assert.throws(() => b[f](), { name: 'TypeError', code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  }
});
