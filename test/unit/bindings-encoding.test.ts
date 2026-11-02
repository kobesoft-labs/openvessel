import { test } from 'node:test';
import { createEncodingBinding } from '../../src/nodejs/bindings/encoding.ts';
import { run } from '../fixtures-gen/encoding.cases.mjs';
import fixture from './fixtures/encoding_binding.json';
import { compareFixtures } from './binding-fixtures.ts';

const arg = (item: { args: unknown[] }) => item.args[0] as string;

test("internalBinding('encoding_binding') matches Node", () => {
  compareFixtures(run(createEncodingBinding()), fixture.results as any, {
    // A non-ASCII label holding a URL-forbidden ASCII character: ada encodes it anyway, we return
    // "" (error). lib/url.js rejects both results alike (empty or containing forbidden chars).
    'forbidden host code point in a non-ASCII label': (s, item) => s === 'toASCII' && /[^\x00-\x7f]/.test(arg(item)) && /[ %]/.test(arg(item)),
  });
});
