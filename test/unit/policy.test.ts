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

test('inherited names are not presets', () => {
  const p = normalizePolicy({ presets: ['toString', 'constructor', '__proto__', 'npm'] as any });
  assert.deepEqual(p.presets, ['npm']);
  assert.equal(decide(p, 'https://example.test/', none, none), 'ask');
});

test('IPv6 hosts and patterns', () => {
  const p = normalizePolicy({ mode: 'allowlist', presets: [], allow: ['[2001:db8::1]:8080', '2001:db8::2', '[2001:DB8:0:0:0:0:0:3]'] });
  assert.equal(decide(p, 'http://[2001:db8::1]:8080/', none, none), 'allow');
  assert.equal(decide(p, 'http://[2001:db8::1]/', none, none), 'deny');
  assert.equal(decide(p, 'https://[2001:db8::2]/', none, none), 'allow');
  assert.equal(decide(p, 'https://[2001:db8::3]:9000/', none, none), 'allow');
  assert.equal(decide(p, 'https://[2001:db8::4]/', none, none), 'deny');
  // session decisions are keyed by the host name without brackets
  assert.equal(decide(normalizePolicy({ presets: [] }), 'https://[2001:db8::5]/', new Set(['2001:db8::5']), none), 'allow');
});

test('IP addresses match in any spelling', () => {
  const p = normalizePolicy({ mode: 'allowlist', presets: [], allow: ['10.1:8443'] });
  assert.equal(decide(p, 'https://10.0.0.1:8443/', none, none), 'allow');
  assert.equal(decide(p, 'https://10.0.0.1/', none, none), 'deny');
});

test('loopback never goes out, whatever the policy', () => {
  const p = normalizePolicy({ mode: 'allow-all', allow: ['localhost', '127.0.0.1', '[::1]'] });
  const session = new Set(['localhost', '127.0.0.1', '::1']);
  for (const u of ['http://localhost:4321/', 'http://LOCALHOST/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://127.8.9.1:80/', 'http://[::1]:3000/', 'http://0.0.0.0/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://localhost./']) {
    assert.equal(decide(p, u, session, none), 'deny', u);
  }
  assert.equal(decide(p, 'http://10.0.0.1/', none, none), 'allow');
});
