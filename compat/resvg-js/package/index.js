// @resvg/resvg-js (a napi-rs binary with no wasm32-wasi build) on top of @resvg/resvg-wasm.
// resvg-js is synchronous and reads font files itself; resvg-wasm initializes asynchronously and
// takes font buffers. So the wasm glue is loaded with a synchronous init added, and font files and
// directories are read here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const file = require.resolve('@resvg/resvg-wasm'); // its CommonJS build (index.js)
const dir = path.dirname(file);
const glue = new Module(file, module);
glue.filename = file;
glue.paths = Module._nodeModulePaths(dir);
glue._compile(
  fs.readFileSync(file, 'utf8') +
    `
module.exports.__initSync = function (bytes) {
  if (initialized) return;
  const imports = __wbg_get_imports();
  __wbg_init_memory(imports);
  const mod = new WebAssembly.Module(bytes);
  __wbg_finalize_init(new WebAssembly.Instance(mod, imports), mod);
  initialized = true;
};
`,
  file,
);
const wasm = glue.exports;
wasm.__initSync(fs.readFileSync(path.join(dir, 'index_bg.wasm')));

const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?)$/i;

function fontBuffersFrom(font) {
  const buffers = [...(font.fontBuffers ?? [])];
  for (const f of font.fontFiles ?? []) buffers.push(fs.readFileSync(f));
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (FONT_EXT.test(e.name)) buffers.push(fs.readFileSync(p));
    }
  };
  for (const d of font.fontDirs ?? []) walk(d);
  return buffers.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
}

function wasmOptions(options) {
  if (!options?.font) return options;
  const { fontFiles, fontDirs, loadSystemFonts, ...font } = options.font;
  void loadSystemFonts; // there are no system fonts here
  return { ...options, font: { ...font, fontBuffers: fontBuffersFrom(options.font) } };
}

class Resvg extends wasm.Resvg {
  constructor(svg, options) {
    super(typeof svg === 'string' ? svg : new Uint8Array(svg), wasmOptions(options));
  }
}

function renderAsync(svg, options, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    try {
      resolve(new Resvg(svg, options).render());
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { Resvg, renderAsync };
