// CommonJS twin of index.mjs (see there): cn-font-split's wasm32-wasip1 library with node:wasi.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WASI } = require('node:wasi');
const fse = require('fs-extra');
const { api_interface: proto } = require('../gen/index.js');
const { decodeReporter } = require('../decodeReporter.js');
const { createAPI } = require('../createAPI.js');

let mod;

async function fontSplit(config) {
  const input = typeof config.input === 'string' ? await fse.readFile(config.input) : config.input;
  const extra = { input };
  if (Array.isArray(config.subsets)) extra.subsets = config.subsets.map((s) => new Uint8Array(new Uint32Array(s).buffer));
  const template = proto.InputTemplate.fromObject({ ...config, ...extra });
  if (!template.outDir) throw Error('cn-font-split need outDir');
  const key = Math.random().toString().slice(2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-font-split-'));
  try {
    fs.mkdirSync(path.join(tmp, 'fonts'));
    fs.mkdirSync(path.join(tmp, key));
    fs.writeFileSync(path.join(tmp, 'fonts', key), template.serialize());
    mod ??= new WebAssembly.Module(fs.readFileSync(process.env.CN_FONT_SPLIT_BIN || path.resolve(__dirname, '../libffi-wasm32-wasip1.wasm')));
    const wasi = new WASI({ version: 'preview1', args: [key], env: {}, preopens: { '/tmp': tmp }, returnOnExit: true });
    const ok = () => 0;
    const instance = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: wasi.wasiImport,
      env: { pthread_mutex_init: ok, pthread_mutex_lock: ok, pthread_mutex_unlock: ok, pthread_mutex_destroy: ok },
    });
    const label = 'cn-font-split ' + key.slice(0, 3);
    console.time(label);
    const code = wasi.start(instance);
    if (code) throw new Error(`cn-font-split exited with ${code}`);
    const out = path.join(tmp, key);
    for (const name of fs.readdirSync(out)) {
      if (!config.silent) console.log(name);
      await (config.outputFile || fse.outputFile)(path.join(template.outDir, name), fs.readFileSync(path.join(out, name)));
    }
    console.timeEnd(label);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { createAPI, decodeReporter, fontSplit, proto };
