// getInternalBinding(): which implementation serves each internalBinding name.
// Bindings without an implementation still exist with their recorded constants, and their
// functions throw ERR_NOT_IMPLEMENTED (see shape.ts).

import nodeData from '../../node/data/process.json';
import { S } from '../state.ts';
import { createBuffer } from './buffer.ts';
import { createContextify } from './contextify.ts';
import { createFs } from './fs.ts';
import { createModuleWrap } from './module_wrap.ts';
import { createMessaging } from './messaging.ts';
import {
  createAsyncWrap,
  createConfig,
  createCredentials,
  createErrors,
  createMksnapshot,
  createOs,
  createPerformance,
  createProcessMethods,
  createSymbols,
  createTaskQueue,
  createTimers,
  createTraceEvents,
  createUv,
} from './process.ts';
import { fromShape } from './shape.ts';
import { createZlib } from './zlib.ts';
import { createHttpParser } from './http_parser.ts';
import { createProcessWrap, createSignalWrap, createSpawnSync } from './process_wrap.ts';
import { createPipeWrap, createStreamWrap, createTtyWrap } from './stream.ts';
import { createTypes, createUtil } from './util.ts';
import { createUrl } from './url.ts';
import { createEncodingBinding } from './encoding.ts';
import { createIcu } from './icu.ts';
import { createModules } from './modules.ts';
import { createStringDecoder } from './string_decoder.ts';

export type BindingFactory = () => any;

/** Name → factory. Other modules (and the parallel binding work) register here. */
export const factories: Record<string, BindingFactory> = {
  async_wrap: createAsyncWrap,
  buffer: createBuffer,
  builtins: () => S.builtinsBinding,
  config: createConfig,
  contextify: createContextify,
  credentials: createCredentials,
  encoding_binding: createEncodingBinding,
  errors: createErrors,
  fs: createFs,
  http_parser: createHttpParser,
  icu: createIcu,
  messaging: createMessaging,
  mksnapshot: createMksnapshot,
  module_wrap: createModuleWrap,
  modules: createModules,
  options: createOptions,
  os: createOs,
  performance: createPerformance,
  pipe_wrap: createPipeWrap,
  process_methods: createProcessMethods,
  process_wrap: createProcessWrap,
  signal_wrap: createSignalWrap,
  spawn_sync: createSpawnSync,
  stream_wrap: createStreamWrap,
  string_decoder: createStringDecoder,
  symbols: createSymbols,
  task_queue: createTaskQueue,
  timers: createTimers,
  trace_events: createTraceEvents,
  tty_wrap: createTtyWrap,
  types: createTypes,
  url: createUrl,
  util: createUtil,
  uv: createUv,
  zlib: createZlib,
  // only for v8.queryObjects(), which needs heap access
  internal_only_v8: () => ({ queryObjects: () => [] }),
  // WebAssembly.compileStreaming/instantiateStreaming are the browser's own
  wasm_web_api: () => Object.assign(fromShape('wasm_web_api'), { setImplementation: () => {} }),
};

export function registerBinding(name: string, factory: BindingFactory) {
  factories[name] = factory;
}

const cache = new Map<string, any>();
export function getInternalBinding(name: string): any {
  let b = cache.get(name);
  if (b === undefined) {
    const f = factories[name];
    b = f ? f() : fromShape(name);
    if (!f && Object.keys(b).length === 0) {
      const e = new Error(`No such binding: ${name}`) as Error & { code: string };
      e.code = 'ERR_INVALID_MODULE';
      throw e;
    }
    cache.set(name, b);
  }
  return b;
}

export function getLinkedBinding(name: string): never {
  const e = new Error(`No such binding: ${name}`) as Error & { code: string };
  e.code = 'ERR_INVALID_MODULE';
  throw e;
}

function createOptions() {
  const b = fromShape('options');
  return Object.assign(b, {
    getCLIOptionsValues: () => S.optionValues,
    getCLIOptionsInfo: () => ({
      options: new Map(nodeData.optionInfo.options as any),
      aliases: new Map(nodeData.optionInfo.aliases as any),
    }),
    getEmbedderOptions: () => ({ ...nodeData.embedderOptions }),
    getEnvOptionsInputType: () => new Map((nodeData.optionInfo.options as [string, { envVarSettings: number; type: number }][]).filter(([, v]) => v.envVarSettings === 0).map(([k, v]) => [k, v.type])),
    envSettings: nodeData.envSettings,
    types: nodeData.types,
    noGlobalSearchPaths: false,
    shouldNotRegisterESMLoader: false,
  });
}
