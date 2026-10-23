import { test } from 'node:test';
import { createStringDecoder } from '../../src/nodejs/bindings/string_decoder.ts';
import { run } from '../fixtures-gen/string_decoder.cases.mjs';
import fixture from './fixtures/string_decoder.json';
import { compareFixtures } from './binding-fixtures.ts';

test("internalBinding('string_decoder') matches Node 22", () => {
  compareFixtures(run(createStringDecoder()), fixture.results as any);
});
