import { test } from 'node:test';
import { createUrl } from '../../src/nodejs/bindings/url.ts';
import { run } from '../fixtures-gen/url.cases.mjs';
import fixture from './fixtures/url.json';
import { compareFixtures } from './binding-fixtures.ts';

// The binding parses with whatwg-url.ts, the URL Standard's parser written the way ada does it. It
// follows the current standard where ada 2.9.2 (Node 22) does not, and maps non-ASCII domains (UTS #46)
// through the platform URL (here: the test runner's Node, a newer ada; in the browser: the browser's
// parser). Those cases differ from Node.
const standardVsAda = (_s: string, item: { args: unknown[] }) => {
  const [a, b, c] = item.args as string[];
  return (
    (a === '../..' && b === 'foo://host/a/b') || // a non-special URL whose path became empty: ada drops the '/'
    (b === 'kHost' && (a.startsWith('foo:') || a.startsWith('web+demo:')) && (c.includes(':') || c === '')) || // host setter on non-special URLs: ada ignores the port and rejects ''
    (b === 'kHostname' && a === 'foo:/p' && c === '')
  );
};
const platformDomainMapping = (_s: string, item: { args: unknown[] }) => {
  const [a] = item.args as string[];
  return (
    a === 'http://xn--/' || // empty punycode label: rejected by ada 2.9.2
    a === 'xn--' ||
    a === 'xn--a' ||
    a === 'aא.com' // bidi rule: not enforced by ada 2.9.2
  );
};

test("internalBinding('url') matches Node 22", () => {
  compareFixtures(run(createUrl()), fixture.results as any, {
    'the URL Standard differs from ada 2.9.2': standardVsAda,
    'the platform domain mapping differs from ada 2.9.2': platformDomainMapping,
  });
});
