import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satisfies, maxSatisfying, compare, valid, minVersion, validRange } from '../../src/kernel/npm/semver.ts';

test('parse and compare', () => {
  assert.equal(valid('v1.2.3'), '1.2.3');
  assert.equal(valid('1.2'), null);
  assert.equal(compare('1.2.3', '1.10.0'), -1);
  assert.equal(compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compare('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compare('2.0.0+build', '2.0.0'), 0);
});

test('caret, tilde, x-ranges', () => {
  assert.ok(satisfies('1.9.9', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(satisfies('0.2.9', '^0.2.3'));
  assert.ok(!satisfies('0.3.0', '^0.2.3'));
  assert.ok(!satisfies('0.0.4', '^0.0.3'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('1.4.0', '1.x'));
  assert.ok(satisfies('3.0.0', '*'));
  assert.ok(satisfies('1.2.0', '1.2'));
});

test('hyphen, OR, comparators', () => {
  assert.ok(satisfies('1.5.0', '1.2.3 - 2.3'));
  assert.ok(!satisfies('2.4.0', '1.2.3 - 2.3'));
  assert.ok(satisfies('3.1.0', '^1.0.0 || ^3.0.0'));
  assert.ok(satisfies('1.5.0', '>=1.2.0 <2.0.0-0'));
  assert.ok(!satisfies('2.0.0-beta.1', '>=1.2.0 <2.0.0-0'));
});

test('prereleases only match on the same tuple', () => {
  assert.ok(satisfies('7.0.0-beta.2', '^7.0.0-beta.1'));
  assert.ok(!satisfies('7.1.0-beta.1', '^7.0.0-beta.1'));
  assert.ok(!satisfies('1.0.0-rc.1', '*'));
  assert.ok(satisfies('1.0.0-rc.1', '*', { includePrerelease: true }));
});

test('maxSatisfying and minVersion', () => {
  const vs = ['5.18.2', '6.0.0', '6.4.8', '7.0.0-alpha.2', '7.4.2'];
  assert.equal(maxSatisfying(vs, '^6.0.0'), '6.4.8');
  assert.equal(maxSatisfying(vs, '>=5'), '7.4.2');
  assert.equal(maxSatisfying(vs, '^8'), null);
  assert.equal(minVersion('^6.2.0'), '6.2.0');
  assert.ok(validRange('>=1 <2 || 3.x'));
  assert.ok(!validRange('not a range'));
});

test('dist-tags are not ranges', () => {
  assert.equal(validRange('latest'), false);
  assert.equal(validRange('next'), false);
  assert.ok(!satisfies('1.0.0', 'latest'));
  assert.equal(validRange(''), true);
});
