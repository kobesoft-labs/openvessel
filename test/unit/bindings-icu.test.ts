import { test } from 'node:test';
import { createIcu } from '../../src/nodejs/bindings/icu.ts';
import { run } from '../fixtures-gen/icu.cases.mjs';
import fixture from './fixtures/icu.json';
import { compareFixtures } from './binding-fixtures.ts';

test("internalBinding('icu') matches Node 22", () => {
  compareFixtures(run(createIcu()), fixture.results as any, {
    // ICU's IBM866 table maps 0x7F to U+001A; the WHATWG ibm866 decoder keeps U+007F.
    'ICU ibm866 control mapping': (s, item) => s === 'decode' && item.args[0] === 'ibm866' && (item.args[2] as number[]).includes(0x7f),
  });
});
