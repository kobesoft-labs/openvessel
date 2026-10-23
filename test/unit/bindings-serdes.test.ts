import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerdes } from '../../src/nodejs/bindings/serdes.ts';
import { run, makeClasses, deserializeWith } from '../fixtures-gen/serdes.cases.mjs';
import fixture from './fixtures/serdes.json';
import { compareFixtures } from './binding-fixtures.ts';

test("internalBinding('serdes') matches Node 22 byte for byte", () => {
  const total = compareFixtures(run(createSerdes()) as any, fixture.results as any, {
    // new Array(n).fill() has HOLEY elements in V8 although nothing is missing; JS cannot see the
    // elements kind, so we write the dense format where V8 writes the sparse one (both read back equal).
    'holey elements kind': (section, item) => section === 'serialize' && item.args[0] === 'arrFilled',
  });
  console.log(`${total} cases`);
});

test("internalBinding('serdes') reads the bytes Node wrote", () => {
  const { DefaultDes, Des } = makeClasses(createSerdes());
  let n = 0;
  for (const [section, C] of [['serialize', DefaultDes], ['plain', Des]] as const) {
    for (const { args, r } of (fixture.results as any)[section]) {
      if (!r.hex) continue;
      let ours;
      try {
        ours = deserializeWith(C, r.hex);
      } catch (e) {
        ours = { error: `${e.name}: ${e.message}` };
      }
      assert.deepEqual(JSON.parse(JSON.stringify(ours)), r.back, `${section} ${args[0]}`);
      n++;
    }
  }
  console.log(`${n} Node-written buffers read back`);
});
