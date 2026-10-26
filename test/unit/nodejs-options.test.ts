import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../../src/nodejs/options.ts';

// The expectations are what Node.js v22.23.4 does with these command lines.

test('option names take _ for -', () => {
  const cl = parseCommandLine(['node', '--stack_trace_limit=3', '--expose_gc', 'a.js']);
  assert.equal(cl.error, undefined);
  assert.equal(cl.values['--stack-trace-limit'], 3);
  assert.deepEqual(cl.execArgv, ['--stack_trace_limit=3', '--expose_gc']);
  assert.deepEqual(cl.argv, ['node', 'a.js']);
});

test('V8 flags are checked against V8 list', () => {
  assert.equal(parseCommandLine(['node', '--use-strict', '--no-use-strict', '--max_old_space_size=100', 'a.js']).error, undefined);
  assert.equal(parseCommandLine(['node', '--foo_bar']).error, 'bad option: --foo_bar');
  assert.equal(parseCommandLine(['node', '--no-foo']).error, 'bad option: --no-foo');
  const bool = parseCommandLine(['node', '--expose-gc=1']);
  assert.equal(bool.error, 'bad option: --expose-gc=1');
  assert.equal(bool.v8Error, 'Error: illegal value for flag --expose-gc=1 of type bool\nTo set or unset a boolean flag, use --flag or --no-flag.\nTry --help for options\n');
  // a value has to come after '=' (Node passes the flag to V8 on its own)
  const int = parseCommandLine(['node', '--stack-trace-limit', '5']);
  assert.equal(int.error, 'bad option: --stack-trace-limit');
  assert.equal(int.v8Error, 'Error: illegal value for flag --stack-trace-limit of type int\nTry --help for options\n');
  assert.equal(parseCommandLine(['node', '--stack-size=abc']).error, 'bad option: --stack-size=abc');
});

test('NODE_OPTIONS takes only the options in Node table', () => {
  assert.equal(parseCommandLine(['node'], '--use-strict').error, '--use-strict is not allowed in NODE_OPTIONS');
  assert.equal(parseCommandLine(['node'], '--foo').error, '--foo is not allowed in NODE_OPTIONS');
  const cl = parseCommandLine(['node'], '--expose_gc --stack-trace-limit=4');
  assert.equal(cl.error, undefined);
  assert.equal(cl.values['--stack-trace-limit'], 4);
});

test('--prof-process ends the options', () => {
  const cl = parseCommandLine(['node', '--prof-process', '--preprocess', 'isolate.log']);
  assert.equal(cl.error, undefined);
  assert.equal(cl.values['--prof-process'], true);
  assert.deepEqual(cl.argv, ['node', '--preprocess', 'isolate.log']);
});

test('implications', () => {
  assert.equal(parseCommandLine(['node', '--env-file=.env', 'a.js']).values['[has_env_file_string]'], true);
  assert.equal(parseCommandLine(['node', '--env-file-if-exists', '.env', 'a.js']).values['[has_env_file_string]'], true);
  assert.equal(parseCommandLine(['node', 'a.js']).values['[has_env_file_string]'], false);
  assert.equal(parseCommandLine(['node', '-e', '1']).values['[has_eval_string]'], true);
  assert.equal(parseCommandLine(['node', '--watch-path=src', 'a.js']).values['--watch'], true);
});

test('--watch checks', () => {
  assert.equal(parseCommandLine(['node', '--watch']).error, '--watch requires specifying a file');
  assert.equal(parseCommandLine(['node', '--watch', '-e', '1']).error, 'either --watch or --eval can be used, not both');
  assert.equal(parseCommandLine(['node', '--watch', '--check', 'a.js']).error, 'either --watch or --check can be used, not both');
  assert.equal(parseCommandLine(['node', '--watch', 'a.js']).error, undefined);
});
