import { test } from 'node:test';
import { createUrl } from '../../src/nodejs/bindings/url.ts';
import { run } from '../fixtures-gen/url.cases.mjs';
import fixture from './fixtures/url.json';
import { compareFixtures } from './binding-fixtures.ts';

// The binding parses with the platform URL (here: the test runner's Node, a newer ada; in the
// browser: the browser's parser). Where that parser and ada 2.9.2 (Node 22) disagree, so do we.
const parserVersion = (_s: string, item: { args: unknown[] }) => {
  const [a, b, c] = item.args as string[];
  return (
    a === 'http://xn--/' || // empty punycode label: rejected by ada 2.9.2
    a === 'xn--' ||
    a === 'xn--a' ||
    a === 'aא.com' || // bidi rule: not enforced by ada 2.9.2
    (a === '../..' && b === 'foo://host/a/b') || // empty path of a non-special URL
    (b === 'kHost' && (a.startsWith('foo:') || a.startsWith('web+demo:')) && (c.includes(':') || c === '')) || // host setter on non-special URLs
    (b === 'kHostname' && a === 'foo:/p' && c === '')
  );
};

test("internalBinding('url') matches Node 22", () => {
  compareFixtures(run(createUrl()), fixture.results as any, { 'platform URL parser differs from ada 2.9.2': parserVersion });
});
