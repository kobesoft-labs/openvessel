import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWasmRuntime } from '../../src/kernel/npm/install.ts';

const peer = (r: string) => ({ peerDependencies: { '@emnapi/core': r, '@emnapi/runtime': r } });
const versions = {
  '1.2.4': peer('^1.7.1 || ^2.0.0-alpha.4'),
  '1.2.5': peer('^1.7.1 || ^2.0.0-alpha.4'),
  '1.2.6': peer('^1.7.1 || 2.0.0-beta.2'),
};

test('skips a wasm-runtime whose peer rejects the emnapi the binding pins', () => {
  assert.equal(pickWasmRuntime(versions, '~1.2.5', '2.0.0-alpha.5'), '1.2.5');
});

test('takes the newest when its peer accepts the pinned emnapi', () => {
  assert.equal(pickWasmRuntime(versions, '~1.2.5', '2.0.0-beta.2'), '1.2.6');
  assert.equal(pickWasmRuntime(versions, '~1.2.5', '1.11.3'), '1.2.6');
});

test('leaves the range alone when the binding pins no emnapi, or nothing fits', () => {
  assert.equal(pickWasmRuntime(versions, '~1.2.5', undefined), null);
  assert.equal(pickWasmRuntime(versions, '~1.2.5', '^1.4.0'), null);
  assert.equal(pickWasmRuntime(versions, '~1.2.5', '0.9.0'), null);
});
