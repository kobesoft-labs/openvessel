import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VFS } from '../../src/kernel/vfs.ts';
import { resolveBeneath } from '../../src/node/wasi-path.ts';

// /sandbox is preopened as /sandbox; /secret is outside it
function fs() {
  const vfs = new VFS();
  vfs.mkdir('/sandbox/sub/deep', 0o777, true);
  vfs.mkdir('/secret', 0o777, true);
  vfs.writeFile('/sandbox/file', 'in');
  vfs.writeFile('/secret/key', 'out');
  vfs.symlink('../file', '/sandbox/sub/up');
  vfs.symlink('/sandbox/sub', '/sandbox/abs-in');
  vfs.symlink('/secret', '/sandbox/abs-out');
  vfs.symlink('../secret', '/sandbox/rel-out');
  vfs.symlink('sub/../../secret/key', '/sandbox/rel-out2');
  vfs.symlink('loop', '/sandbox/loop');
  return {
    lstatMode: (p: string) => vfs.lstat(p).mode,
    readlink: (p: string) => vfs.readlink(p),
  };
}
const ops = fs();
const r = (p: string, follow = true, dir = '/sandbox', guest = '/sandbox') => resolveBeneath(ops, dir, guest, p, follow).host;
const code = (p: string, follow = true, dir = '/sandbox', guest = '/sandbox') => {
  try {
    r(p, follow, dir, guest);
    return 'ok';
  } catch (e) {
    return (e as { code: string }).code;
  }
};

test('paths inside the directory resolve to it', () => {
  assert.equal(r('file'), '/sandbox/file');
  assert.equal(r('./sub/deep/../../file'), '/sandbox/file');
  assert.equal(r('.'), '/sandbox');
  assert.equal(r('sub/'), '/sandbox/sub');
  assert.equal(r('new-file'), '/sandbox/new-file');
});

test('.. above the directory is not capable', () => {
  assert.equal(code('..'), 'ENOTCAPABLE');
  assert.equal(code('../secret/key'), 'ENOTCAPABLE');
  assert.equal(code('sub/../../secret'), 'ENOTCAPABLE');
  // relative to a subdirectory fd, its parent is outside too
  assert.equal(code('../file', true, '/sandbox/sub', '/sandbox/sub'), 'ENOTCAPABLE');
});

test('absolute paths are not capable, absolute symlink targets are read in the module\'s view', () => {
  assert.equal(code('/sandbox/file'), 'ENOTCAPABLE');
  assert.equal(code('/secret/key'), 'ENOTCAPABLE');
  // a preopen mapped under another name: /sandbox/sub means nothing to the module
  assert.equal(code('abs-in', true, '/sandbox', '/data'), 'ENOTCAPABLE');
  assert.equal(r('abs-in', false, '/sandbox', '/data'), '/sandbox/abs-in');
  // a relative preopen name has no absolute targets
  assert.equal(code('abs-in', true, '/sandbox', '.'), 'ENOTCAPABLE');
});

test('symlinks are followed inside the directory only', () => {
  assert.equal(r('sub/up'), '/sandbox/file');
  assert.equal(r('abs-in/deep'), '/sandbox/sub/deep');
  assert.equal(code('abs-out/key'), 'ENOTCAPABLE');
  assert.equal(code('rel-out/key'), 'ENOTCAPABLE');
  assert.equal(code('rel-out2'), 'ENOTCAPABLE');
  assert.equal(code('loop'), 'ELOOP');
});

test('the last symlink is kept without SYMLINK_FOLLOW, but the ones before it are followed', () => {
  assert.equal(r('abs-out', false), '/sandbox/abs-out');
  assert.equal(r('rel-out', false), '/sandbox/rel-out');
  assert.equal(code('abs-out/', false), 'ENOTCAPABLE');
  assert.equal(code('abs-out/key', false), 'ENOTCAPABLE');
});

test('a missing directory on the way fails, a missing last component does not', () => {
  assert.equal(code('nope/file'), 'ENOENT');
  assert.equal(code(''), 'ENOENT');
  assert.equal(r('nope'), '/sandbox/nope');
});
