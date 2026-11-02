import { test } from 'node:test';
import { createUrl } from '../../src/nodejs/bindings/url.ts';
import { run } from '../fixtures-gen/url.cases.mjs';
import fixture from './fixtures/url.json';
import { compareFixtures } from './binding-fixtures.ts';

// The binding parses with whatwg-url.ts, the URL Standard's parser written the way ada does it. ada 4
// (Node 26) follows the current standard, so no differences are accepted. Non-ASCII domains are
// mapped (UTS #46) through the platform URL (here: the test runner's Node; in the browser: the
// browser's parser), which may differ from ada on cases not in the fixture.
test("internalBinding('url') matches Node", () => {
  compareFixtures(run(createUrl()), fixture.results as any);
});
