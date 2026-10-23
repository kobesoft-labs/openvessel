// getInternalBinding(): which implementation serves each internalBinding name.
// Bindings without an implementation still exist with their recorded constants, and their
// functions throw ERR_NOT_IMPLEMENTED (see shape.ts).

import nodeData from '../../node/data/process.json';
import { S } from '../state.ts';
import { createBuffer } from './buffer.ts';
import { createFs } from './fs.ts';
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
import { createTypes, createUtil } from './util.ts';

export type BindingFactory = () => any;

/** Name → factory. Other modules (and the parallel binding work) register here. */
export const factories: Record<string, BindingFactory> = {
  async_wrap: createAsyncWrap,
  buffer: createBuffer,
  builtins: () => S.builtinsBinding,
  config: createConfig,
  credentials: createCredentials,
  errors: createErrors,
  fs: createFs,
  messaging: createMessaging,
  mksnapshot: createMksnapshot,
  options: createOptions,
  os: createOs,
  performance: createPerformance,
  process_methods: createProcessMethods,
  symbols: createSymbols,
  task_queue: createTaskQueue,
  timers: createTimers,
  trace_events: createTraceEvents,
  types: createTypes,
  util: createUtil,
  uv: createUv,
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
