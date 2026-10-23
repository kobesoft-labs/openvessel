// Inputs for internalBinding('performance').Histogram (HdrHistogram): fixed values recorded into
// histograms of several configurations, and every statistic read back.

const str = (v) => (typeof v === 'bigint' ? `${v}n` : Object.is(v, -0) ? '-0' : String(v));

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
  };
}

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

export function run({ Histogram }) {
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
  return results;
}
