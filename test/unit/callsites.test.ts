import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStack } from '../../src/nodejs/callsites.ts';

test('a SpiderMonkey stack becomes V8 CallSites', () => {
  const stack = [
    'loadAndTranslate@node:internal/modules/esm/loader:615:27',
    '#createModuleJob@node:internal/modules/esm/loader:640:36',
    'async*import/<@node:internal/modules/esm/loader:680:36',
    '@/home/user/app/index.js:1:13',
    'boot/<@http://localhost:5171/node-process.js:46703:20',
    'EventHandlerNonNull*@http://localhost:5171/node-process.js:46316:1',
    '@http://localhost:5171/node-process.js line 30032 > eval:2:5',
    '',
  ].join('\n');
  const f = parseStack(stack);
  assert.equal(f.length, 7);
  assert.equal(String(f[0]), 'loadAndTranslate (node:internal/modules/esm/loader:615:27)');
  assert.equal(f[0].getFunctionName(), 'loadAndTranslate');
  assert.equal(f[0].getFileName(), 'node:internal/modules/esm/loader');
  assert.equal(f[0].getLineNumber(), 615);
  assert.equal(f[0].getColumnNumber(), 27);
  assert.equal(f[0].isEval(), true);
  assert.equal(f[1].getFunctionName(), '#createModuleJob');
  assert.equal(f[2].isAsync(), true);
  assert.equal(f[2].getFunctionName(), null);
  assert.equal(String(f[2]), 'async node:internal/modules/esm/loader:680:36');
  assert.equal(String(f[3]), '/home/user/app/index.js:1:13');
  assert.equal(f[4].getFunctionName(), null);
  assert.equal(f[4].isEval(), false);
  assert.equal(f[4].getFileName(), 'http://localhost:5171/node-process.js');
  assert.equal(f[5].isAsync(), false);
  assert.equal(f[5].getLineNumber(), 46316);
  assert.equal(f[6].getFileName(), undefined);
  assert.equal(f[6].isEval(), true);
  assert.equal(f[6].getEvalOrigin(), 'http://localhost:5171/node-process.js:30032');
});
