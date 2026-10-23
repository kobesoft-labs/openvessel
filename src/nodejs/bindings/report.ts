// internalBinding('report') — diagnostic reports. Reports have Node's layout; libraries mostly read
// the header (detect-libc looks at glibcVersionRuntime), so it says what a glibc Linux Node would.

import nodeData from '../../node/data/process.json';
import { sys } from '../../node/sys.ts';
import { S } from '../state.ts';
import { fromShape } from './shape.ts';

function header(trigger: string) {
  const now = new Date();
  return {
    reportVersion: 5,
    event: 'JavaScript API',
    trigger,
    filename: null,
    dumpEventTime: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    dumpEventTimeStamp: String(now.getTime()),
    processId: S.init.pid,
    threadId: S.isMainThread ? 0 : S.init.tid,
    cwd: S.cwd,
    commandLine: [...S.init.argv],
    nodejsVersion: `v${nodeData.versions.node}`,
    glibcVersionRuntime: '2.36',
    glibcVersionCompiler: '2.28',
    wordSize: 64,
    arch: 'x64',
    platform: 'linux',
    componentVersions: { ...nodeData.versions },
    release: { ...nodeData.release },
    osName: 'Linux',
    osRelease: '6.8.0-openvessel',
    osVersion: '#1 SMP OpenVessel',
    osMachine: 'x86_64',
    cpus: [],
    networkInterfaces: [],
    host: S.init.hostname || 'openvessel',
  };
}

export function createReport() {
  const b = fromShape('report');
  const opts = { compact: false, excludeNetwork: false, excludeEnv: false, directory: '', filename: '', signal: 'SIGUSR2', onFatal: false, onSignal: false, onUncaught: false };
  const build = (err?: Error) =>
    JSON.stringify(
      {
        header: header(err ? 'Exception' : 'GetReport'),
        javascriptStack: { message: err ? String(err) : 'No stack.', stack: err?.stack ? String(err.stack).split('\n').slice(1).map((l) => l.trim()) : ['Unavailable.'] },
        javascriptHeap: {},
        nativeStack: [],
        resourceUsage: {},
        uvthreadResourceUsage: {},
        libuv: [],
        workers: [],
        environmentVariables: opts.excludeEnv ? undefined : { ...S.process.env },
        userLimits: {},
        sharedObjects: [],
      },
      null,
      opts.compact ? 0 : 2,
    );
  return Object.assign(b, {
    getReport: (err?: Error) => build(err),
    writeReport(_event: string, _trigger: string, file: string, err?: Error) {
      const name = file || opts.filename || `report.${Date.now()}.${S.init.pid}.0.001.json`;
      const path = name.startsWith('/') ? name : `${opts.directory || S.cwd}/${name}`;
      try {
        sys('writeFile', { p: path, flags: 0o1101, mode: 0o644 }, new TextEncoder().encode(build(err)));
      } catch {}
      return name;
    },
    getCompact: () => opts.compact,
    setCompact: (v: boolean) => void (opts.compact = v),
    getExcludeNetwork: () => opts.excludeNetwork,
    setExcludeNetwork: (v: boolean) => void (opts.excludeNetwork = v),
    getExcludeEnv: () => opts.excludeEnv,
    setExcludeEnv: (v: boolean) => void (opts.excludeEnv = v),
    getDirectory: () => opts.directory,
    setDirectory: (v: string) => void (opts.directory = v),
    getFilename: () => opts.filename,
    setFilename: (v: string) => void (opts.filename = v),
    getSignal: () => opts.signal,
    setSignal: (v: string) => void (opts.signal = v),
    shouldReportOnFatalError: () => opts.onFatal,
    setReportOnFatalError: (v: boolean) => void (opts.onFatal = v),
    shouldReportOnSignal: () => opts.onSignal,
    setReportOnSignal: (v: boolean) => void (opts.onSignal = v),
    shouldReportOnUncaughtException: () => opts.onUncaught,
    setReportOnUncaughtException: (v: boolean) => void (opts.onUncaught = v),
  });
}
