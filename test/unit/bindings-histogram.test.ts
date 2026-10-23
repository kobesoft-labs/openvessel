import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Histogram, createELDHistogram } from '../../src/nodejs/bindings/performance.ts';
import { run } from '../fixtures-gen/histogram.cases.mjs';
import fixture from './fixtures/performance.json';
import { compareFixtures } from './binding-fixtures.ts';

test("internalBinding('performance').Histogram matches Node 22", () => {
  const total = compareFixtures(run({ Histogram }) as any, fixture.results as any);
  console.log(`${total} cases`);
});

test('createELDHistogram records event loop delays', async () => {
  const h = createELDHistogram(5);
  h.start();
  h.start(); // already running: no second timer
  await new Promise((r) => setTimeout(r, 60));
  h.stop();
  const n = h.count();
  assert.ok(n >= 2, `recorded ${n} delays`);
  assert.ok(h.min() >= 1e6, `min ${h.min()}ns is at least the 1ms timer granularity`);
  assert.ok(h.max() >= h.min());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.count(), n, 'stopped');
  h.start(true);
  h.stop();
  assert.equal(h.count(), 0, 'start(true) resets');
});
