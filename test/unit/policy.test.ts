import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, normalizePolicy } from '../../src/shared/policy.ts';

const none = new Set<string>();

test('presets allow, unknown hosts ask', () => {
  const p = normalizePolicy(undefined);
  assert.equal(decide(p, 'https://registry.npmjs.org/astro', none, none), 'allow');
  assert.equal(decide(p, 'https://fonts.gstatic.com/x.woff2', none, none), 'allow');
  assert.equal(decide(p, 'https://evil.example/', none, none), 'ask');
  // github is not in the default presets
  assert.equal(decide(p, 'https://codeload.github.com/a/b', none, none), 'ask');
});

test('allowlist mode denies instead of asking', () => {
  const p = normalizePolicy({ mode: 'allowlist', allow: ['*.example.org', 'api.example.com:8443'] });
  assert.equal(decide(p, 'https://a.b.example.org/', none, none), 'allow');
  assert.equal(decide(p, 'https://example.org/', none, none), 'allow');
  assert.equal(decide(p, 'https://api.example.com:8443/', none, none), 'allow');
  assert.equal(decide(p, 'https://api.example.com/', none, none), 'deny');
  assert.equal(decide(p, 'https://other.test/', none, none), 'deny');
});

test('deny wins, even over allow-all', () => {
  const p = normalizePolicy({ mode: 'allow-all', deny: ['*.tracker.test'] });
  assert.equal(decide(p, 'https://anything.test/', none, none), 'allow');
  assert.equal(decide(p, 'https://x.tracker.test/', none, none), 'deny');
  assert.equal(decide(p, 'https://anything.test/', none, new Set(['anything.test'])), 'deny');
});

test('only http(s) leaves the box', () => {
  const p = normalizePolicy({ mode: 'allow-all' });
  assert.equal(decide(p, 'file:///etc/passwd', none, none), 'deny');
  assert.equal(decide(p, 'javascript:alert(1)', none, none), 'deny');
  assert.equal(decide(p, 'not a url', none, none), 'deny');
});

test('session answers', () => {
  const p = normalizePolicy({ presets: [] });
  assert.equal(decide(p, 'https://registry.npmjs.org/', none, none), 'ask');
  assert.equal(decide(p, 'https://api.site.test/', new Set(['api.site.test']), none), 'allow');
});
