import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryUrl } from '../../src/host/url.ts';

const page = 'https://host.example.com/editor/index.html';
const dir = (u: string) => directoryUrl(u, page).href;

test('a URL ending in / is the directory', () => {
  assert.equal(dir('https://pv.example.com/'), 'https://pv.example.com/');
  assert.equal(dir('https://pv.example.com/app/'), 'https://pv.example.com/app/');
});

test('a last segment without an extension is a directory', () => {
  assert.equal(dir('https://pv.example.com/app'), 'https://pv.example.com/app/');
  assert.equal(dir('https://pv.example.com/a/b'), 'https://pv.example.com/a/b/');
  assert.equal(dir('https://pv.example.com'), 'https://pv.example.com/');
});

test('a last segment with an extension is a file in the directory', () => {
  assert.equal(dir('https://rt.example.com/runtime.html'), 'https://rt.example.com/');
  assert.equal(dir('https://rt.example.com/ov/runtime.html'), 'https://rt.example.com/ov/');
});

test('query and fragment are dropped; relative URLs resolve against the page', () => {
  assert.equal(dir('https://pv.example.com/app?x=1#y'), 'https://pv.example.com/app/');
  assert.equal(dir('/rt'), 'https://host.example.com/rt/');
  assert.equal(dir('rt/'), 'https://host.example.com/editor/rt/');
});
