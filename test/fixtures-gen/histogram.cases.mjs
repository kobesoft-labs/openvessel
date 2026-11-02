// Inputs for internalBinding('performance').Histogram (HdrHistogram): fixed values recorded into
// histograms of several configurations, and every statistic read back.

const str = (v) => (typeof v === 'bigint' ? `${v}n` : Object.is(v, -0) ? '-0' : String(v));
// Results of the distribution functions (t, beta, normal) go through lgamma/erfc/exp/log, whose last
// bits may differ between glibc and V8's fdlibm: compare them to 9 significant digits.
const approx = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? Number(v.toPrecision(9)).toString() : str(v));
const map = (m) => [...m].map(([k, v]) => [str(k), str(v)]);
// FNV-1a over the export bytes, with the length (keeps the fixture small)
function digest(u8) {
  let h = 0x811c9dc5;
  for (const b of u8) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `${u8.length}:${h.toString(16)}`;
}

function stats(h) {
  const p = new Map();
  h.percentiles(p);
  const pb = new Map();
  h.percentilesBigInt(pb);
  return {
    count: str(h.count()),
    countBigInt: str(h.countBigInt()),
    min: str(h.min()),
    minBigInt: str(h.minBigInt()),
    max: str(h.max()),
    maxBigInt: str(h.maxBigInt()),
    mean: str(h.mean()),
    stddev: str(h.stddev()),
    exceeds: str(h.exceeds()),
    exceedsBigInt: str(h.exceedsBigInt()),
    p: [0.001, 1, 25, 50, 75, 90, 99, 99.9, 100].map((x) => str(h.percentile(x))),
    pBig: [1, 50, 100].map((x) => str(h.percentileBigInt(x))),
    percentiles: [...p].map(([k, v]) => [str(k), str(v)]),
    percentilesBigInt: [...pb].map(([k, v]) => [str(k), str(v)]),
    ...more(h),
  };
}

// what Node 26 added: shape statistics, CDF, bucket iterations, confidence intervals, export
function more(h) {
  const max = h.max();
  const at = new Map();
  h.percentilesAt(at, new Float64Array([0.5, 1, 33.3, 50, 50, 90, 99.99, 100]));
  const linear = new Map();
  h.linearBuckets(Math.max(1, Math.ceil(max / 12)), linear);
  const log = new Map();
  h.logBuckets(1, 2, log);
  const log3 = new Map();
  h.logBuckets(7, 3.5, log3);
  return {
    skewness: str(h.skewness()),
    kurtosis: str(h.kurtosis()),
    cdf: [0, 1, 2, 42, 50, 1000, 1e6, 2 ** 40, 2 ** 53].map((v) => str(h.cdf(v))),
    countAt: [0, 1, 42, 1000, 2 ** 40].map((v) => str(h.countAt(v))),
    percentilesAt: map(at),
    linearBuckets: map(linear),
    logBuckets: map(log),
    logBuckets3: map(log3),
    meanCI: h.meanCI(0.95).map(approx),
    meanCI99: h.meanCI(0.99).map(approx),
    percentileCI: [
      [50, 0.95],
      [99, 0.9],
      [1, 0.99],
    ].map(([p, c]) => h.percentileCI(p, c).map(str)),
    ewma: [str(h.ewmaMean()), str(h.ewmaStddev()), str(h.ewmaErrorRate())],
    resetCount: str(h.resetCount()),
    export: digest(h.export()),
  };
}

function pairStats(a, b) {
  return {
    ksTest: str(a.ksTest(b)),
    welchTest: a.welchTest(b, 0.95).map(approx),
    welchTest80: a.welchTest(b, 0.8).map(approx),
    mannWhitneyTest: a.mannWhitneyTest(b).map(approx),
    cohensD: str(a.cohensD(b)),
    cliffsD: str(a.cliffsD(b)),
  };
}

async function qrde(h, probabilities, mode, cache) {
  const r = await h.qrde(probabilities, mode, cache);
  return {
    proto: Object.getPrototypeOf(r) === null,
    probabilities: [...r.probabilities].map(str),
    quantiles: [...r.quantiles].map(approx),
    densities: [...r.densities].map(approx),
    count: str(r.count),
    bucketCount: r.bucketCount,
    corrections: r.corrections,
    dequantize: r.dequantize,
  };
}

const bins = (n) => new Float64Array(Array.from({ length: n + 1 }, (_, i) => i / n));

async function tryAsync(fn) {
  try {
    return await fn();
  } catch (e) {
    return { error: `${e.name}: ${e.message}`, code: e.code };
  }
}

const filled = (cfg, values, extra = []) => (Histogram) => {
  const h = new Histogram(...cfg, ...extra);
  for (const v of values) h.record(v);
  return h;
};

function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s;
  };
}

const series = {
  empty: [],
  one: [1],
  seq100: Array.from({ length: 100 }, (_, i) => i + 1),
  spread: [1, 2, 3, 1000, 1e6, 1e9],
  same: Array(50).fill(42),
  large: [2 ** 40, 2 ** 40 + 12345, 2 ** 52, 7],
  random: (() => {
    const r = lcg(7);
    return Array.from({ length: 500 }, () => (r() % 1e7) + 1);
  })(),
  bigints: [5n, 10n, 1000000n, 123456789012n],
};

const configs = [
  [1, Number.MAX_SAFE_INTEGER, 3],
  [1, Number.MAX_SAFE_INTEGER, 1],
  [1, Number.MAX_SAFE_INTEGER, 5],
  [1000, 1e9, 2],
  [1, 100, 3],
  [7, 2 ** 40, 4],
];

function tryIt(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: `${e.name}: ${e.message}`, code: e.code };
  }
}

export async function run({ Histogram, SlidingWindowHistogram }) {
  const results = { stats: [], ops: [] };
  for (const cfg of configs) {
    for (const [name, values] of Object.entries(series)) {
      results.stats.push({
        args: [cfg, name],
        r: tryIt(() => {
          const h = new Histogram(...cfg);
          for (const v of values) h.record(v);
          return stats(h);
        }),
      });
    }
  }
  results.ops.push({ args: ['record 0'], r: tryIt(() => new Histogram(1, 100, 3).record(0)) });
  results.ops.push({ args: ['record -1n'], r: tryIt(() => new Histogram(1, 100, 3).record(-1n)) });
  results.ops.push({ args: ['record 2**64n'], r: tryIt(() => new Histogram(1, 100, 3).record(2n ** 64n)) });
  results.ops.push({ args: ['record 1.7'], r: tryIt(() => { const h = new Histogram(1, 100, 3); h.record(1.7); return stats(h); }) });
  results.ops.push({
    args: ['add'],
    r: tryIt(() => {
      const a = new Histogram(1, Number.MAX_SAFE_INTEGER, 3);
      const b = new Histogram(1, Number.MAX_SAFE_INTEGER, 3);
      for (const v of series.spread) a.record(v);
      for (const v of series.seq100) b.record(v * 37);
      b.record(2 ** 60);
      a.add(b);
      return stats(a);
    }),
  });
  results.ops.push({
    args: ['add exceeding'],
    r: tryIt(() => {
      const a = new Histogram(1, 100, 3);
      const b = new Histogram(1, Number.MAX_SAFE_INTEGER, 3);
      for (const v of [5, 50, 5000, 5e6]) b.record(v);
      a.record(1e9);
      a.add(b);
      return stats(a);
    }),
  });
  results.ops.push({
    args: ['reset'],
    r: tryIt(() => {
      const h = new Histogram(1, 100, 3);
      for (const v of [1, 2, 1000]) h.record(v);
      h.reset();
      h.record(3);
      return stats(h);
    }),
  });
  more2(results, Histogram, SlidingWindowHistogram);
  results.qrde = [];
  for (const [name, values] of Object.entries(series)) {
    for (const [mode, probabilities] of [
      [0, bins(4)],
      [1, bins(10)],
      [2, bins(7)],
      [1, new Float64Array([0, 0.001, 0.5, 0.999, 1])],
    ]) {
      const h = new Histogram(1, Number.MAX_SAFE_INTEGER, 3);
      for (const v of values) h.record(v);
      results.qrde.push({ args: [name, mode, probabilities.length], r: await tryAsync(() => qrde(h, probabilities, mode, false)) });
    }
  }
  {
    // many buckets (the exact-support path), large counts (the asymptotic path), a cached snapshot
    const h = new Histogram(1, Number.MAX_SAFE_INTEGER, 3);
    const r = lcg(11);
    for (let i = 0; i < 20000; i++) h.record((r() % 100000) + 1);
    results.qrde.push({ args: ['wide', 1, 101], r: await tryAsync(() => qrde(h, bins(100), 1, true)) });
    results.qrde.push({ args: ['wide cached', 1, 101], r: await tryAsync(() => qrde(h, bins(100), 1, true)) });
    const g = new Histogram(1, 1000, 2);
    for (let i = 0; i < 300000; i++) g.record((i % 97) + 1);
    results.qrde.push({ args: ['dense', 2, 21], r: await tryAsync(() => qrde(g, bins(20), 2, false)) });
    results.qrde.push({ args: ['empty'], r: await tryAsync(() => qrde(new Histogram(1, 100, 3), bins(3), 1, false)) });
  }
  return results;
}

function more2(results, Histogram, SlidingWindowHistogram) {
  const op = (name, fn) => results.ops.push({ args: [name], r: tryIt(fn) });
  const full = [1, Number.MAX_SAFE_INTEGER, 3];
  op('record 0 stats', () => {
    const h = new Histogram(1, 100, 3);
    for (const v of [0, 0, 5]) h.record(v);
    return stats(h);
  });
  op('invalid options', () => new Histogram(10, 15, 3));
  op('record 1e20', () => new Histogram(1, 100, 3).record(1e20));
  op('record NaN', () => new Histogram(1, 100, 3).record(NaN));
  op('invalid figures', () => new Histogram(1, 100, 6));
  op('lowest 2**62', () => new Histogram(2n ** 62n, 2n ** 63n - 1n, 3));
  op('lowest bigint lossy', () => new Histogram(2n ** 64n, 2n ** 63n - 1n, 3));
  op('bigint range', () => {
    const h = new Histogram(1n, 2n ** 63n - 1n, 2);
    for (const v of [1n, 2n ** 40n, 2n ** 50n]) h.record(v);
    return stats(h);
  });
  op('recordCorrected', () => {
    const h = new Histogram(...full);
    h.recordCorrected(1000, 100);
    h.recordCorrected(50, 100);
    h.recordCorrected(305n, 100n);
    return stats(h);
  });
  op('recordCorrected bad interval', () => new Histogram(...full).recordCorrected(5, 0));
  op('recordCorrected exceeding', () => {
    const h = new Histogram(1, 100, 3);
    h.recordCorrected(1000, 10);
    h.recordCorrected(90, 10);
    return stats(h);
  });
  op('subtract', () => {
    const a = filled(full, series.random)(Histogram);
    const b = filled(full, series.random.slice(0, 200).concat([5e9, 5e9]))(Histogram);
    a.record(2 ** 60);
    const dropped = a.subtract(b);
    return { dropped: str(dropped), ...stats(a) };
  });
  op('subtract other config', () => {
    const a = filled(full, series.spread)(Histogram);
    const b = filled([1, 1000, 2], [1, 2, 3, 500])(Histogram);
    return { dropped: str(a.subtract(b)), ...stats(a) };
  });
  op('add self', () => {
    const a = filled(full, series.seq100)(Histogram);
    return { dropped: str(a.add(a)), ...stats(a) };
  });
  op('snapshot and diff', () => {
    const a = filled(full, series.seq100)(Histogram);
    a.record(2 ** 60);
    const s = a.snapshot();
    for (const v of series.spread) a.record(v);
    a.record(2 ** 61);
    const d = a.diff(s);
    return { snapshot: stats(s), diff: stats(d) };
  });
  op('diff later', () => {
    const a = filled(full, series.seq100)(Histogram);
    const s = a.snapshot();
    a.record(5);
    return a.diff(s.snapshot().diff(a));
  });
  op('diff not earlier', () => {
    const a = filled(full, series.seq100)(Histogram);
    const b = filled(full, [5, 5])(Histogram);
    return stats(b.diff(a));
  });
  op('diff incompatible', () => filled(full, [1])(Histogram).diff(filled([1, 100, 3], [1])(Histogram)));
  op('diff after reset', () => {
    const a = filled(full, series.seq100)(Histogram);
    const s = a.snapshot();
    a.reset();
    return a.diff(s);
  });
  op('diff after subtract', () => {
    const a = filled(full, series.seq100)(Histogram);
    const s = a.snapshot();
    a.subtract(filled(full, [1])(Histogram));
    return { resetCount: str(a.resetCount()), d: tryIt(() => a.diff(s)) };
  });
  const pairs = [
    ['seq100', 'random'],
    ['random', 'spread'],
    ['same', 'same'],
    ['one', 'seq100'],
    ['empty', 'seq100'],
    ['large', 'spread'],
  ];
  for (const [x, y] of pairs) {
    op(`pair ${x} ${y}`, () => pairStats(filled(full, series[x])(Histogram), filled(full, series[y])(Histogram)));
  }
  op('pair self', () => {
    const a = filled(full, series.random)(Histogram);
    return pairStats(a, a);
  });
  op('pair different layouts', () => pairStats(filled(full, series.random)(Histogram), filled([1, 1e9, 2], series.seq100)(Histogram)));
  for (const [halfLife, threshold] of [
    [0, 0],
    [1, 0],
    [4, 50],
    [0.5, 1000],
    [100, 3],
  ]) {
    op(`ewma ${halfLife} ${threshold}`, () => {
      const h = filled(full, series.seq100.concat(series.spread), [halfLife, threshold])(Histogram);
      const after = [approx(h.ewmaMean()), approx(h.ewmaStddev()), approx(h.ewmaErrorRate())];
      const imported = Histogram.import(h.export());
      const s = h.snapshot();
      h.reset();
      const ewma = (x) => [approx(x.ewmaMean()), approx(x.ewmaStddev()), approx(x.ewmaErrorRate())];
      return { after, imported: ewma(imported), importedCount: str(imported.count()), snapshot: ewma(s), reset: stats(h) };
    });
  }
  op('import roundtrip', () => {
    const h = filled([7, 2 ** 40, 4], series.random)(Histogram);
    h.record(1e15);
    const i = Histogram.import(h.export());
    i.record(3);
    return { stats: stats(i), exceeds: str(i.exceeds()) };
  });
  op('import empty', () => stats(Histogram.import(new Histogram(1, 100, 3).export())));
  const hex = (s) => new Uint8Array(Buffer.from(s.replace(/ /g, ''), 'hex'));
  const head = '00 02 01 01 02 18 64 03 03 09 19 0800';
  const imports = {
    'not a Uint8Array': () => Histogram.import([1, 2]),
    garbage: () => Histogram.import(hex('00')),
    truncated: () => Histogram.import(filled([1, 100, 3], [5])(Histogram).export().subarray(0, 20)),
    'empty map': () => Histogram.import(hex('a0')),
    'minimal v2': () => stats(Histogram.import(hex(`a5 ${head}`))),
    'counts len mismatch': () => Histogram.import(hex('a5 00 02 01 01 02 18 64 03 03 09 05')),
    'unknown key v2': () => stats(Histogram.import(hex(`a6 ${head} 18 63 63 616263`))),
    'unknown key v1': () => Histogram.import(hex('a6 00 01 01 01 02 18 64 03 03 09 19 0800 18 63 63 616263')),
    'version 3': () => Histogram.import(hex('a1 00 03')),
    'duplicate key': () => Histogram.import(hex('a2 01 01 01 01')),
    counts: () => stats(Histogram.import(hex(`a6 ${head} 0a 84 05 02 03 07`))),
    'counts zero delta': () => Histogram.import(hex(`a6 ${head} 0a 84 05 02 00 07`)),
    'counts total mismatch': () => Histogram.import(hex(`a7 ${head} 0a 82 05 02 04 03`)),
    'counts with min max': () => stats(Histogram.import(hex(`a8 ${head} 0a 82 05 02 05 01 06 18 50`))),
    'norm offset': () => {
      const h = Histogram.import(hex(`a7 ${head} 0a 82 05 02 07 03`));
      h.record(10);
      return stats(h);
    },
    'norm offset out of range': () => Histogram.import(hex(`a6 ${head} 07 19 0800`)),
    'float ratio': () => stats(Histogram.import(hex(`a6 ${head} 08 fb 3ff8000000000000`))),
    ewma: () => {
      const h = Histogram.import(hex(`a6 ${head} 0b a3 00 fb 3fe0000000000000 01 fb 4024000000000000 04 05`));
      h.record(9);
      return [stats(h), str(h.ewmaMean()), str(h.ewmaErrorRate())];
    },
    'nested skip': () => stats(Histogram.import(hex(`a6 ${head} 18 20 82 a1 01 c1 f5 f9 3c00`))),
  };
  for (const [name, fn] of Object.entries(imports)) op(`import ${name}`, fn);
  const sliding = (args, values) => () => {
    const w = new SlidingWindowHistogram(...args);
    const out = [];
    for (const v of values) {
      if (v === 'snapshot') out.push(stats(w.snapshot()));
      else if (v === 'reset') w.reset();
      else w.record(v);
    }
    out.push(stats(w.snapshot()));
    return out;
  };
  op('sliding records', sliding([1, Number.MAX_SAFE_INTEGER, 3, 3, false, 2n], [1, 2, 'snapshot', 3, 4, 5, 'snapshot', 6, 7, 8, 9, 'snapshot', 'reset', 'snapshot', 10]));
  op('sliding one chunk', sliding([1, 100, 2, 1, false, 3n], [5, 6, 7, 8, 200, 'snapshot', 9]));
  op('sliding time', sliding([1, 100, 3, 4, true, 3600000000000n], [5, 6, 500]));
  op('sliding no records', sliding([1, 100, 3, 2, false, 5n], []));
  op('sliding bad chunks', () => new SlidingWindowHistogram(1, 100, 3, 0, false, 1n));
  op('sliding bad rotation', () => new SlidingWindowHistogram(1, 100, 3, 2, false, 0n));
  op('sliding bad options', () => new SlidingWindowHistogram(50, 60, 3, 2, false, 1n));
  op('sliding record -1', () => new SlidingWindowHistogram(1, 100, 3, 2, false, 1n).record(-1));
  op('sliding record bigint', sliding([1n, 2n ** 50n, 3, 2, false, 1n], [5n, 6n, 2n ** 49n]));
}
