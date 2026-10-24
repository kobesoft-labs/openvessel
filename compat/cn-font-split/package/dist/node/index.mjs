// cn-font-split's Node backend calls a native library through Koffi (FFI). Here the same library's
// wasm32-wasip1 release runs with node:wasi instead: the config goes in as /tmp/fonts/<key>, the
// pieces come out of /tmp/<key>/ (the protocol of its own wasm backend) and are written to outDir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import { api_interface as proto } from '../gen/index.mjs';
import { decodeReporter } from '../decodeReporter.mjs';
import { createAPI } from '../createAPI.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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
    mod ??= new WebAssembly.Module(fs.readFileSync(process.env.CN_FONT_SPLIT_BIN || path.resolve(here, '../libffi-wasm32-wasip1.wasm')));
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

export { createAPI, decodeReporter, fontSplit, proto };
