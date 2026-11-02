// internalBinding('performance').Histogram, SlidingWindowHistogram and createELDHistogram (histogram.cc,
// node_perf.cc) over a TypeScript port of HdrHistogram_c (deps/histogram): the same buckets, so the
// statistics, percentiles, bucket iterations and export bytes match Node's for the same recorded values.
//
// Values are JS numbers: exact up to 2^53, which covers createHistogram()'s range (highest is at
// most Number.MAX_SAFE_INTEGER unless given as a bigint). INT64_MAX (the empty histogram's min, the
// default highest) is kept as the sentinel 2^63.
//
// The statistics added in Node 26 (tests, confidence intervals, QRDE) follow histogram.cc step by
// step. They need lgamma and erfc, which JS lacks; those are ports of the fdlibm code glibc uses, so
// results agree with Node's to the last few bits (exp/log may round differently from glibc's).

import { perfNow } from '../../node/native.ts';
import { macrotask, scope, startReq } from '../loop.ts';

// Captured before Node's bootstrap replaces the timer globals with lib/timers.
const nativeSetInterval: typeof setInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval: typeof clearInterval = globalThis.clearInterval.bind(globalThis);

const INT64_MAX = 2 ** 63; // as a double, as static_cast<double>(INT64_MAX) gives
const INT64_MAX_BIG = 9223372036854775807n;

function bitLength(v: number): number {
  if (v <= 0) return 0;
  if (v < 2 ** 32) return 32 - Math.clz32(v);
  return 64 - Math.clz32(Math.floor(v / 2 ** 32));
}

function nodeError(Ctor: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  return e;
}

const outOfRange = (message = 'value is out of range') => nodeError(RangeError, 'ERR_OUT_OF_RANGE', message);
const invalidOptions = () => nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid histogram options');

/** A failed CHECK() in histogram.cc: Node aborts; we throw. */
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`internalBinding('performance'): ${what}`);
}

/** int64 → BigInt, mapping the 2^63 sentinel back to INT64_MAX */
const big = (v: number): bigint => (v >= INT64_MAX ? INT64_MAX_BIG : BigInt(v));

/** std::clamp (NaN passes through, as with the C++ comparisons) */
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : hi < v ? hi : v);

// -----------------------------------------------------------------------------
// HdrHistogram_c

/** hdr_calculate_bucket_config; null for EINVAL */
function bucketConfig(lowest: number, highest: number, figures: number) {
  // division form: lowest*2 near INT64_MAX overflows int64
  if (lowest < 1 || figures < 1 || figures > 5 || lowest > Math.floor(highest / 2)) return null;
  const largestValueWithSingleUnitResolution = 2 * 10 ** figures;
  const subBucketCountMagnitude = Math.ceil(Math.log(largestValueWithSingleUnitResolution) / Math.log(2));
  const subBucketHalfCountMagnitude = (subBucketCountMagnitude > 1 ? subBucketCountMagnitude : 1) - 1;
  const unitMagnitude = Math.trunc(Math.log(lowest) / Math.log(2));
  const subBucketCount = 2 ** (subBucketHalfCountMagnitude + 1);
  if (unitMagnitude + subBucketHalfCountMagnitude > 61) return null;
  // buckets_needed_to_cover_value
  let smallestUntrackable = subBucketCount * 2 ** unitMagnitude;
  let bucketCount = 1;
  while (smallestUntrackable <= highest) {
    // > INT64_MAX / 2, i.e. >= 2^62 (2^62 - 1 is not a double)
    if (smallestUntrackable >= 2 ** 62) {
      bucketCount++;
      break;
    }
    smallestUntrackable *= 2;
    bucketCount++;
  }
  return { unitMagnitude, subBucketHalfCountMagnitude, subBucketCount, bucketCount, countsLen: (bucketCount + 1) * (subBucketCount / 2) };
}

/** struct hdr_iter: the fields the iterations read */
interface HdrIter {
  countsIndex: number;
  totalCount: number;
  count: number;
  cumulativeCount: number;
  value: number;
  highestEquivalentValue: number;
  medianEquivalentValue: number;
}

/** struct hdr_histogram */
export class Hdr {
  readonly lowest: number;
  readonly highest: number;
  readonly figures: number;
  readonly unitMagnitude: number;
  readonly subBucketHalfCountMagnitude: number;
  readonly subBucketCount: number;
  readonly subBucketHalfCount: number;
  readonly subBucketMask: number;
  readonly bucketCount: number;
  readonly countsLen: number;
  readonly counts: Float64Array;
  totalCount = 0;
  minValue = INT64_MAX;
  maxValue = 0;
  // only an imported histogram can have these (hdr_shift is never used by Node)
  normalizingIndexOffset = 0;
  conversionRatio = 1;

  /** hdr_init; Hdr.create() returns null where that fails */
  private constructor(lowest: number, highest: number, figures: number, cfg: NonNullable<ReturnType<typeof bucketConfig>>) {
    this.lowest = lowest;
    this.highest = highest;
    this.figures = figures;
    this.unitMagnitude = cfg.unitMagnitude;
    this.subBucketHalfCountMagnitude = cfg.subBucketHalfCountMagnitude;
    this.subBucketCount = cfg.subBucketCount;
    this.subBucketHalfCount = cfg.subBucketCount / 2;
    this.subBucketMask = (cfg.subBucketCount - 1) * 2 ** cfg.unitMagnitude;
    this.bucketCount = cfg.bucketCount;
    this.countsLen = cfg.countsLen;
    this.counts = new Float64Array(cfg.countsLen);
  }

  static create(lowest: number, highest: number, figures: number): Hdr | null {
    const cfg = bucketConfig(lowest, highest, figures);
    return cfg ? new Hdr(lowest, highest, figures, cfg) : null;
  }

  /** hdr_get_memory_size */
  memorySize(): number {
    return 104 + this.countsLen * 8;
  }

  private normalizeIndex(index: number): number {
    if (this.normalizingIndexOffset === 0) return index;
    const normalized = index - this.normalizingIndexOffset;
    if (normalized < 0) return normalized + this.countsLen;
    if (normalized >= this.countsLen) return normalized - this.countsLen;
    return normalized;
  }
  countAtIndexNormalised(index: number): number {
    return this.counts[this.normalizeIndex(index)];
  }

  bucketIndex(value: number): number {
    const pow2ceiling = Math.max(bitLength(value), bitLength(this.subBucketMask)); // 64 - clz(value | mask)
    return pow2ceiling - this.unitMagnitude - (this.subBucketHalfCountMagnitude + 1);
  }
  subBucketIndex(value: number, bucketIndex: number): number {
    return Math.floor(value / 2 ** (bucketIndex + this.unitMagnitude));
  }
  countsIndex(bucketIndex: number, subBucketIndex: number): number {
    return (bucketIndex + 1) * 2 ** this.subBucketHalfCountMagnitude + (subBucketIndex - this.subBucketHalfCount);
  }
  countsIndexFor(value: number): number {
    const b = this.bucketIndex(value);
    return this.countsIndex(b, this.subBucketIndex(value, b));
  }
  valueFromIndex(bucketIndex: number, subBucketIndex: number): number {
    return subBucketIndex * 2 ** (bucketIndex + this.unitMagnitude);
  }
  /** hdr_value_at_index */
  valueAtIndex(index: number): number {
    let bucketIndex = Math.floor(index / 2 ** this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex = (index & (this.subBucketHalfCount - 1)) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    return this.valueFromIndex(bucketIndex, subBucketIndex);
  }
  sizeOfEquivalentValueRange(value: number): number {
    const b = this.bucketIndex(value);
    const sb = this.subBucketIndex(value, b);
    return 2 ** (this.unitMagnitude + (sb >= this.subBucketCount ? b + 1 : b));
  }
  lowestEquivalentValue(value: number): number {
    const b = this.bucketIndex(value);
    return this.valueFromIndex(b, this.subBucketIndex(value, b));
  }
  highestEquivalentValue(value: number): number {
    const low = this.lowestEquivalentValue(value);
    const size = this.sizeOfEquivalentValueRange(value);
    // the top bucket saturates at INT64_MAX
    if (low > INT64_MAX - size) return INT64_MAX;
    return low + size - 1;
  }
  medianEquivalentValue(value: number): number {
    return this.lowestEquivalentValue(value) + Math.floor(this.sizeOfEquivalentValueRange(value) / 2);
  }

  /** hdr_record_values */
  recordValues(value: number, count: number): boolean {
    if (count < 0) return false;
    if (value < 0 || this.highest < value) return false;
    const idx = this.countsIndexFor(value);
    if (idx < 0 || idx >= this.countsLen) return false;
    this.counts[this.normalizeIndex(idx)] += count;
    this.totalCount += count;
    if (value > this.maxValue) this.maxValue = value;
    if (value !== 0 && value < this.minValue) this.minValue = value;
    return true;
  }

  /** hdr_record_corrected_values: back-fills the values a stalled recorder missed */
  recordCorrectedValues(value: number, count: number, expectedInterval: number): boolean {
    if (!this.recordValues(value, count)) return false;
    if (expectedInterval <= 0 || value <= expectedInterval) return true;
    for (let missing = value - expectedInterval; missing >= expectedInterval; missing -= expectedInterval) {
      if (!this.recordValues(missing, count)) return false;
    }
    return true;
  }

  /** hdr_count_at_value */
  countAtValue(value: number): number {
    if (value < 0) return 0;
    const idx = this.countsIndexFor(value);
    if (idx < 0 || idx >= this.countsLen) return 0;
    return this.countAtIndexNormalised(idx);
  }

  /** hdr_count_at_index */
  countAtIndex(index: number): number {
    if (index < 0 || index >= this.countsLen) return 0;
    return this.countAtIndexNormalised(index);
  }

  reset() {
    this.counts.fill(0);
    this.totalCount = 0;
    this.minValue = INT64_MAX;
    this.maxValue = 0;
  }

  /** hdr_reset_internal_counters: total, min and max derived from the counts */
  resetInternalCounters() {
    let minNonZeroIndex = -1;
    let maxIndex = -1;
    let observed = 0;
    for (let i = 0; i < this.countsLen; i++) {
      const c = this.countAtIndexNormalised(i);
      if (c > 0) {
        observed += c;
        maxIndex = i;
        if (minNonZeroIndex === -1 && i !== 0) minNonZeroIndex = i;
      }
    }
    this.maxValue = maxIndex === -1 ? 0 : this.highestEquivalentValue(this.valueAtIndex(maxIndex));
    this.minValue = minNonZeroIndex === -1 ? INT64_MAX : this.valueAtIndex(minNonZeroIndex);
    this.totalCount = observed;
  }

  /** CopyRecordedData (same layout) */
  copyFrom(source: Hdr) {
    this.minValue = source.minValue;
    this.maxValue = source.maxValue;
    this.normalizingIndexOffset = source.normalizingIndexOffset;
    this.conversionRatio = source.conversionRatio;
    this.totalCount = source.totalCount;
    this.counts.set(source.counts);
  }

  /** hdr_min; INT64_MAX when empty */
  min(): number {
    if (this.countAtIndex(0) > 0) return 0;
    if (this.minValue === INT64_MAX) return INT64_MAX;
    return this.lowestEquivalentValue(this.minValue);
  }
  max(): number {
    return this.maxValue === 0 ? 0 : this.highestEquivalentValue(this.maxValue);
  }

  // --- iterators (hdr_iter) ---------------------------------------------------

  private iter(): HdrIter {
    return { countsIndex: -1, totalCount: this.totalCount, count: 0, cumulativeCount: 0, value: 0, highestEquivalentValue: 0, medianEquivalentValue: 0 };
  }

  /** move_next */
  private moveNext(it: HdrIter): boolean {
    it.countsIndex++;
    if (it.countsIndex >= this.countsLen) return false;
    it.count = this.countAtIndexNormalised(it.countsIndex);
    it.cumulativeCount += it.count;
    const value = this.valueAtIndex(it.countsIndex);
    it.value = value;
    it.highestEquivalentValue = this.highestEquivalentValue(value);
    it.medianEquivalentValue = this.lowestEquivalentValue(value) + Math.floor(this.sizeOfEquivalentValueRange(value) / 2);
    return true;
  }

  /** basic_iter_next */
  private basicNext(it: HdrIter): boolean {
    if (!(it.cumulativeCount < it.totalCount) || it.countsIndex >= this.countsLen) return false;
    this.moveNext(it);
    return true;
  }

  /** hdr_iter_init: every bucket (all_values_iter_next) */
  *allValues(): Generator<HdrIter> {
    const it = this.iter();
    while (this.moveNext(it)) yield it;
  }

  /** hdr_iter_recorded_init: buckets with a count */
  *recorded(): Generator<HdrIter> {
    const it = this.iter();
    while (this.basicNext(it)) if (it.count !== 0) yield it;
  }

  /** peek_next_value_from_index > reporting level, for the linear and log iterations */
  private nextValueGreaterThan(it: HdrIter, level: number): boolean {
    if (it.countsIndex >= this.countsLen) return false;
    const index = it.countsIndex + 1;
    let bucketIndex = Math.floor(index / 2 ** this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex = (index & (this.subBucketHalfCount - 1)) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    const shift = bucketIndex + this.unitMagnitude;
    const next = shift >= 63 || subBucketIndex > Math.floor(INT64_MAX / 2 ** shift) ? INT64_MAX : this.valueFromIndex(bucketIndex, subBucketIndex);
    return next > level;
  }

  /**
   * hdr_iter_linear_init / hdr_iter_log_init walked to the end, as LinearBuckets / LogBuckets do:
   * (iter.value, count_added_in_this_iteration_step). `step` advances the reporting level.
   */
  private steps(first: number, valid: boolean, step: (level: number) => number | null, fn: (value: number, count: number) => void) {
    const it = this.iter();
    let level = valid ? first : INT64_MAX;
    let levelLowest = valid ? this.lowestEquivalentValue(first) : INT64_MAX;
    for (;;) {
      let added = 0;
      if (!(it.cumulativeCount < it.totalCount || this.nextValueGreaterThan(it, levelLowest))) return;
      for (;;) {
        if (it.value >= levelLowest) {
          // emit the saturated final level once before entering the terminal state
          if (level === INT64_MAX) {
            levelLowest = INT64_MAX;
          } else {
            const next = step(level);
            if (next === null) {
              level = INT64_MAX;
              levelLowest = this.lowestEquivalentValue(INT64_MAX);
            } else {
              level = next;
              levelLowest = this.lowestEquivalentValue(level);
            }
          }
          fn(it.value, added);
          break;
        }
        if (!this.moveNext(it)) {
          fn(it.value, added);
          break;
        }
        added += it.count;
      }
    }
  }

  linearBuckets(stepSize: number, fn: (value: number, count: number) => void) {
    this.steps(stepSize, stepSize > 0, (level) => (stepSize <= 0 || level > INT64_MAX - stepSize ? null : level + stepSize), fn);
  }

  logBuckets(firstBucket: number, logBase: number, fn: (value: number, count: number) => void) {
    const valid = firstBucket > 0 && Number.isFinite(logBase) && logBase > 1 && logBase < INT64_MAX;
    const base = Math.trunc(logBase);
    this.steps(firstBucket, valid, (level) => (base <= 1 || level <= 0 || level > Math.floor(INT64_MAX / base) ? null : level * base), fn);
  }

  // --- statistics ---------------------------------------------------------------

  /** hdr_mean */
  mean(): number {
    let total = 0;
    let count = 0;
    for (const it of this.allValues()) {
      if (!(count < this.totalCount)) break;
      if (it.count !== 0) {
        count += it.count;
        total += it.count * this.medianEquivalentValue(it.value);
      }
    }
    return total / this.totalCount;
  }
  /** hdr_stddev */
  stddev(): number {
    const mean = this.mean();
    let geometricDevTotal = 0;
    for (const it of this.allValues()) {
      if (it.count === 0) continue;
      const dev = this.medianEquivalentValue(it.value) - mean;
      geometricDevTotal += dev * dev * it.count;
    }
    return Math.sqrt(geometricDevTotal / this.totalCount);
  }
  /** hdr_value_at_percentile */
  valueAtPercentile(percentile: number): number {
    const requested = percentile < 100 ? percentile : 100;
    let countAtPercentile = Math.trunc((requested / 100) * this.totalCount + 0.5);
    countAtPercentile = countAtPercentile > 0 ? countAtPercentile : 1;
    let valueFromIdx = 0;
    let countToIdx = 0;
    for (let i = 0; i < this.countsLen; i++) {
      countToIdx += this.countAtIndexNormalised(i);
      if (countToIdx >= countAtPercentile) {
        valueFromIdx = this.valueAtIndex(i);
        break;
      }
    }
    return percentile === 0 ? this.lowestEquivalentValue(valueFromIdx) : this.highestEquivalentValue(valueFromIdx);
  }
  /** hdr_value_at_percentiles: the values for ascending percentiles in one pass */
  valuesAtPercentiles(percentiles: ArrayLike<number>): number[] {
    const values = Array.from(percentiles, (p) => {
      const requested = p < 100 ? p : 100;
      const count = Math.trunc((requested / 100) * this.totalCount + 0.5);
      return count > 1 ? count : 1;
    });
    let total = 0;
    let at = 0;
    for (let i = 0; i < this.countsLen && at < values.length; i++) {
      total += this.countAtIndexNormalised(i);
      while (at < values.length && total >= values[at]) values[at++] = this.highestEquivalentValue(this.valueAtIndex(i));
    }
    return values;
  }
  /** hdr_iter_percentile_init(…, 1) walked to the end, as Histogram::Percentiles does: (percentile, iter.value) */
  percentiles(fn: (percentile: number, value: number) => void) {
    const it = this.iter();
    let seenLastValue = false;
    let percentileToIterateTo = 0;
    let percentile = 0;
    for (;;) {
      if (!(it.cumulativeCount < it.totalCount)) {
        if (seenLastValue) return;
        seenLastValue = true;
        fn(100, it.value);
        continue;
      }
      if (it.countsIndex === -1 && !this.basicNext(it)) return;
      let emitted = false;
      do {
        const currentPercentile = (100 * it.cumulativeCount) / this.totalCount;
        if (it.count !== 0 && percentileToIterateTo <= currentPercentile) {
          percentile = percentileToIterateTo;
          const temp = Math.trunc(Math.log(100 / (100 - percentileToIterateTo)) / Math.log(2)) + 1;
          const halfDistance = Math.trunc(2 ** temp);
          percentileToIterateTo += 100 / halfDistance;
          fn(percentile, it.value);
          emitted = true;
          break;
        }
      } while (this.basicNext(it));
      if (!emitted) {
        // percentile_iter_next returns true after running out of buckets, with the previous percentile
        fn(percentile, it.value);
      }
    }
  }
  /** hdr_add: re-records other's values (by bucket); returns how many were dropped */
  add(other: Hdr): number {
    let dropped = 0;
    for (const it of other.recorded()) if (!this.recordValues(it.value, it.count)) dropped += it.count;
    return dropped;
  }
}

// -----------------------------------------------------------------------------
// fdlibm's lgamma and erfc (glibc's dbl-64 code), for positive / any finite arguments

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const highWord = (x: number) => {
  f64[0] = x;
  return u32[1] | 0;
};
const lowWord = (x: number) => {
  f64[0] = x;
  return u32[0];
};
const withLowWordZero = (x: number) => {
  f64[0] = x;
  u32[0] = 0;
  return f64[0];
};

/** __ieee754_lgamma_r for x > 0 (the beta functions only take positive shapes) */
function lgamma(x: number): number {
  const hx = highWord(x);
  const lx = lowWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x * x;
  if ((ix | lx) === 0) return 1 / Math.abs(x);
  if (ix < 0x3b900000) return -Math.log(x);
  check(hx >= 0, 'lgamma of a negative argument');
  let r: number;
  let y: number;
  let i: number;
  if (((ix - 0x3ff00000) | lx) === 0 || ((ix - 0x40000000) | lx) === 0) {
    r = 0;
  } else if (ix < 0x40000000) {
    if (ix <= 0x3feccccc) {
      // lgamma(x) = lgamma(x+1)-log(x)
      r = -Math.log(x);
      if (ix >= 0x3fe76944) {
        y = 1 - x;
        i = 0;
      } else if (ix >= 0x3fcda661) {
        y = x - (1.46163214496836224576 - 1);
        i = 1;
      } else {
        y = x;
        i = 2;
      }
    } else {
      r = 0;
      if (ix >= 0x3ffbb4c3) {
        y = 2 - x;
        i = 0;
      } else if (ix >= 0x3ff3b4c4) {
        y = x - 1.46163214496836224576;
        i = 1;
      } else {
        y = x - 1;
        i = 2;
      }
    }
    switch (i) {
      case 0: {
        const z = y * y;
        const p1 = 7.72156649015328655494e-2 + z * (6.73523010531292681824e-2 + z * (7.38555086081402883957e-3 + z * (1.19270763183362067845e-3 + z * (2.20862790713908385557e-4 + z * 2.52144565451257326939e-5))));
        const p2 = z * (3.22467033424113591611e-1 + z * (2.05808084325167332806e-2 + z * (2.89051383673415629091e-3 + z * (5.10069792153511336608e-4 + z * (1.08011567247583939954e-4 + z * 4.48640949618915160150e-5)))));
        const p = y * p1 + p2;
        r += p - 0.5 * y;
        break;
      }
      case 1: {
        const z = y * y;
        const w = z * y;
        const p1 = 4.83836122723810047042e-1 + w * (-3.27885410759859649565e-2 + w * (6.10053870246291332635e-3 + w * (-1.40346469989232843813e-3 + w * 3.15632070903625950361e-4)));
        const p2 = -1.47587722994593911752e-1 + w * (1.79706750811820387126e-2 + w * (-3.68452016781138256760e-3 + w * (8.81081882437654011382e-4 + w * -3.12754168375120860518e-4)));
        const p3 = 6.46249402391333854778e-2 + w * (-1.03142241298341437450e-2 + w * (2.25964780900612472250e-3 + w * (-5.38595305356740546715e-4 + w * 3.35529192635519073543e-4)));
        const p = z * p1 - (-3.63867699703950536541e-18 - w * (p2 + y * p3));
        r += -1.21486290535849611461e-1 + p;
        break;
      }
      default: {
        const p1 = y * (-7.72156649015328655494e-2 + y * (6.32827064025093366517e-1 + y * (1.45492250137234768737 + y * (9.77717527963372745603e-1 + y * (2.28963728064692451092e-1 + y * 1.33810918536787660377e-2)))));
        const p2 = 1 + y * (2.45597793713041134822 + y * (2.12848976379893395361 + y * (7.69285150456672783825e-1 + y * (1.04222645593369134254e-1 + y * 3.21709242282423911810e-3))));
        r += -0.5 * y + p1 / p2;
      }
    }
  } else if (ix < 0x40200000) {
    // x < 8.0
    i = Math.trunc(x);
    y = x - i;
    const p = y * (-7.72156649015328655494e-2 + y * (2.14982415960608852501e-1 + y * (3.25778796408930981787e-1 + y * (1.46350472652464452805e-1 + y * (2.66422703033638609560e-2 + y * (1.84028451407337715652e-3 + y * 3.19475326584100867617e-5))))));
    const q = 1 + y * (1.39200533467621045958 + y * (7.21935547567138069525e-1 + y * (1.71933865632803078993e-1 + y * (1.86459191715652901344e-2 + y * (7.77942496381893596434e-4 + y * 7.32668430744625636189e-6)))));
    r = 0.5 * y + p / q;
    // lgamma(1+s) = log(s) + lgamma(s)
    let z = 1;
    if (i >= 3) {
      for (let k = i; k >= 3; k--) z *= y + (k - 1);
      r += Math.log(z);
    }
  } else if (ix < 0x43900000) {
    // 8.0 <= x < 2**58
    const t = Math.log(x);
    const z = 1 / x;
    y = z * z;
    const w = 4.18938533204672725052e-1 + z * (8.33333333333329678849e-2 + y * (-2.77777777728775536470e-3 + y * (7.93650558643019558500e-4 + y * (-5.95187557450339963135e-4 + y * (8.36339918996282139126e-4 + y * -1.63092934096575273989e-3)))));
    r = (x - 0.5) * (t - 1) + w;
  } else {
    r = x * (Math.log(x) - 1);
  }
  return r;
}

const ERX = 8.45062911510467529297e-1;
const PP = [1.28379167095512558561e-1, -3.25042107247001499370e-1, -2.84817495755985104766e-2, -5.77027029648944159157e-3, -2.37630166566501626084e-5];
const QQ = [0, 3.97917223959155352819e-1, 6.50222499887672944485e-2, 5.08130628187576562776e-3, 1.32494738004321644526e-4, -3.96022827877536812320e-6];
const PA = [-2.36211856075265944077e-3, 4.14856118683748331666e-1, -3.72207876035701323847e-1, 3.18346619901161753674e-1, -1.10894694282396677476e-1, 3.54783043256182359371e-2, -2.16637559486879084300e-3];
const QA = [0, 1.06420880400844228286e-1, 5.40397917702171048937e-1, 7.18286544141962662868e-2, 1.26171219808761642112e-1, 1.36370839120290507362e-2, 1.19844998467991074170e-2];
const RA = [-9.86494403484714822705e-3, -6.93858572707181764372e-1, -1.05586262253232909814e1, -6.23753324503260060396e1, -1.62396669462573470355e2, -1.84605092906711035994e2, -8.12874355063065934246e1, -9.81432934416914548592];
const SA = [0, 1.96512716674392571292e1, 1.37657754143519042600e2, 4.34565877475229228821e2, 6.45387271733267880336e2, 4.29008140027567833386e2, 1.08635005541779435134e2, 6.57024977031928170135, -6.04244152148580987438e-2];
const RB = [-9.86494292470009928597e-3, -7.99283237680523006574e-1, -1.77579549177547519889e1, -1.60636384855821916062e2, -6.37566443368389627722e2, -1.02509513161107724954e3, -4.83519191608651397019e2];
const SB = [0, 3.03380607434824582924e1, 3.25792512996573918826e2, 1.53672958608443695994e3, 3.19985821950859553908e3, 2.55305040643316442583e3, 4.74528541206955367215e2, -2.24409524465858183362e1];

/** __erfc */
function erfc(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return (hx >>> 31) * 2 + 1 / x;
  if (ix < 0x3feb0000) {
    // |x| < 0.84375
    if (ix < 0x3c700000) return 1 - x;
    const z = x * x;
    const r1 = PP[0] + z * PP[1];
    const z2 = z * z;
    const r2 = PP[2] + z * PP[3];
    const z4 = z2 * z2;
    const s1 = 1 + z * QQ[1];
    const s2 = QQ[2] + z * QQ[3];
    const s3 = QQ[4] + z * QQ[5];
    const r = r1 + z2 * r2 + z4 * PP[4];
    const s = s1 + z2 * s2 + z4 * s3;
    const y = r / s;
    if (hx < 0x3fd00000) return 1 - (x + x * y);
    return 0.5 - (x * y + (x - 0.5));
  }
  if (ix < 0x3ff40000) {
    // 0.84375 <= |x| < 1.25
    const s = Math.abs(x) - 1;
    const P1 = PA[0] + s * PA[1];
    const s2 = s * s;
    const Q1 = 1 + s * QA[1];
    const s4 = s2 * s2;
    const P2 = PA[2] + s * PA[3];
    const s6 = s4 * s2;
    const Q2 = QA[2] + s * QA[3];
    const P3 = PA[4] + s * PA[5];
    const Q3 = QA[4] + s * QA[5];
    const P = P1 + s2 * P2 + s4 * P3 + s6 * PA[6];
    const Q = Q1 + s2 * Q2 + s4 * Q3 + s6 * QA[6];
    if (hx >= 0) return 1 - ERX - P / Q;
    return 1 + (ERX + P / Q);
  }
  if (ix < 0x403c0000) {
    // |x| < 28
    const ax = Math.abs(x);
    const s = 1 / (ax * ax);
    let R: number;
    let S: number;
    if (ix < 0x4006db6d) {
      // |x| < 1/.35
      const s2 = s * s;
      const s4 = s2 * s2;
      const s6 = s4 * s2;
      const s8 = s4 * s4;
      R = RA[0] + s * RA[1] + s2 * (RA[2] + s * RA[3]) + s4 * (RA[4] + s * RA[5]) + s6 * (RA[6] + s * RA[7]);
      S = 1 + s * SA[1] + s2 * (SA[2] + s * SA[3]) + s4 * (SA[4] + s * SA[5]) + s6 * (SA[6] + s * SA[7]) + s8 * SA[8];
    } else {
      if (hx < 0 && ix >= 0x40180000) return 2 - 1e-300; // x < -6
      const s2 = s * s;
      const s4 = s2 * s2;
      const s6 = s4 * s2;
      R = RB[0] + s * RB[1] + s2 * (RB[2] + s * RB[3]) + s4 * (RB[4] + s * RB[5]) + s6 * RB[6];
      S = 1 + s * SB[1] + s2 * (SB[2] + s * SB[3]) + s4 * (SB[4] + s * SB[5]) + s6 * (SB[6] + s * SB[7]);
    }
    const z = withLowWordZero(ax);
    const r = Math.exp(-z * z - 0.5625) * Math.exp((z - ax) * (z + ax) + R / S);
    return hx > 0 ? r / ax : 2 - r / ax;
  }
  return hx > 0 ? 1e-300 * 1e-300 : 2 - 1e-300;
}

// -----------------------------------------------------------------------------
// exp, rounded correctly (in all but the hardest cases)
//
// The EWMA weight is 1 - exp(-ln 2 / halfLife); the subtraction magnifies exp's last bit, and V8's
// fdlibm exp is off by one ulp where glibc's is not, which shows in histogram.export(). exp in
// double-double arithmetic, rounded once at the end, gives glibc's result.

/** a + b as an unevaluated sum [hi, lo] */
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}
/** a * b exactly, as [hi, lo] (Dekker's split) */
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;
  const split = (x: number) => {
    const c = 134217729 * x;
    const hi = c - (c - x);
    return [hi, x - hi];
  };
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}
function ddAdd(a: [number, number], b: [number, number]): [number, number] {
  const [s, e] = twoSum(a[0], b[0]);
  return twoSum(s, e + a[1] + b[1]);
}
function ddMul(a: [number, number], b: [number, number]): [number, number] {
  const [p, e] = twoProd(a[0], b[0]);
  return twoSum(p, e + a[0] * b[1] + a[1] * b[0]);
}

const LN2_DD: [number, number] = [0.6931471805599453, 2.3190468138462996e-17];

function exactExp(x: number): number {
  if (!(x > -745.2)) return x !== x ? x : 0;
  if (x > 709.7) return Infinity;
  // x = k ln2 + r, |r| <= ln2 / 2, with r in double-double
  const k = Math.round(x / LN2_DD[0]);
  const kl = ddMul([k, 0], LN2_DD);
  const r = ddAdd([x, 0], [-kl[0], -kl[1]]);
  // Taylor series: the terms fall below 2^-110 well before n = 30
  let term: [number, number] = [1, 0];
  let sum: [number, number] = [1, 0];
  for (let n = 1; n < 30; n++) {
    term = ddMul(term, r);
    const q = term[0] / n;
    // term / n in double-double: q plus the remainder's correction
    const [ph, pl] = twoProd(q, n);
    term = twoSum(q, (term[0] - ph - pl + term[1]) / n);
    sum = ddAdd(sum, term);
    if (Math.abs(term[0]) < 2 ** -110) break;
  }
  return (sum[0] + sum[1]) * 2 ** k;
}

// -----------------------------------------------------------------------------
// distributions (histogram.cc's anonymous namespace)

/** Continued fraction for the regularized incomplete beta function (Lentz; Numerical Recipes 6.4). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const FPMIN = 1e-30;
  const MAXIT = 200;
  const EPS = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    // even step
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    // odd step
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h;
}

interface BetaParameters {
  a: number;
  b: number;
  logNormalization: number;
  mean: number;
  standardDeviation: number;
  skewness: number;
  excessKurtosis: number;
  logScale: number;
  symmetryPoint: number;
  useAsymptoticFront: boolean;
  useAsymptoticCdf: boolean;
}

function stirlingCorrection(x: number): number {
  const inverse = 1 / x;
  const inverseSquared = inverse * inverse;
  return inverse * (1 / 12 + inverseSquared * (-1 / 360 + inverseSquared * (1 / 1260 + inverseSquared * (-1 / 1680 + inverseSquared / 1188))));
}

function makeBetaParameters(a: number, b: number, approximateLargeShapes: boolean): BetaParameters {
  const sum = a + b;
  const mean = a / sum;
  const useAsymptoticFront = approximateLargeShapes && a >= 8 && b >= 8;
  // The continued fraction needs more iterations as both shapes grow; at this concentration the
  // Edgeworth error is smaller than its truncation error.
  const useAsymptoticCdf = approximateLargeShapes && (a * b) / sum >= 25000;
  const variance = (mean * (1 - mean)) / (sum + 1);
  const skewness = (2 * (b - a) * Math.sqrt(sum + 1)) / ((sum + 2) * Math.sqrt(a * b));
  const excessKurtosis = (6 * ((a - b) * (a - b) * (sum + 1) - a * b * (sum + 2))) / (a * b * (sum + 2) * (sum + 3));
  return {
    a,
    b,
    logNormalization: useAsymptoticFront ? 0 : lgamma(sum) - lgamma(a) - lgamma(b),
    mean,
    standardDeviation: Math.sqrt(variance),
    skewness,
    excessKurtosis,
    logScale: useAsymptoticFront ? 0.5 * Math.log((sum * mean * (1 - mean)) / (2 * Math.PI)) + stirlingCorrection(sum) - stirlingCorrection(a) - stirlingCorrection(b) : 0,
    symmetryPoint: (a + 1) / (sum + 2),
    useAsymptoticFront,
    useAsymptoticCdf,
  };
}

function reflectBetaParameters(p: BetaParameters): BetaParameters {
  return {
    a: p.b,
    b: p.a,
    logNormalization: p.logNormalization,
    mean: 1 - p.mean,
    standardDeviation: p.standardDeviation,
    skewness: -p.skewness,
    excessKurtosis: p.excessKurtosis,
    logScale: p.logScale,
    symmetryPoint: 1 - p.symmetryPoint,
    useAsymptoticFront: p.useAsymptoticFront,
    useAsymptoticCdf: p.useAsymptoticCdf,
  };
}

function betaFront(p: BetaParameters, x: number): number {
  if (x <= 0 || x >= 1) return 0;
  const logFront = p.useAsymptoticFront
    ? p.a * Math.log1p((x - p.mean) / p.mean) + p.b * Math.log1p((p.mean - x) / (1 - p.mean)) + p.logScale
    : p.logNormalization + p.a * Math.log(x) + p.b * Math.log(1 - x);
  return Math.exp(logFront);
}

/** `front` receives the beta density front factor when asked for. */
type FrontOut = { front: number } | null;

function asymptoticBetaCdf(p: BetaParameters, x: number, out: FrontOut): number {
  const z = (x - p.mean) / p.standardDeviation;
  const normalCdf = 0.5 * erfc(-z / Math.SQRT2);
  if (Math.abs(z) >= 8) {
    if (out) out.front = 0;
    return normalCdf;
  }
  const z2 = z * z;
  const z3 = z2 * z;
  const normalPdf = Math.exp(-0.5 * z2) / Math.sqrt(2 * Math.PI);
  if (out) {
    const z4 = z2 * z2;
    const z6 = z3 * z3;
    const densityCorrection =
      1 + (p.skewness / 6) * (z3 - 3 * z) + (p.excessKurtosis / 24) * (z4 - 6 * z2 + 3) + ((p.skewness * p.skewness) / 72) * (z6 - 15 * z4 + 45 * z2 - 15);
    out.front = (((x * (1 - x) * normalPdf) / p.standardDeviation) * Math.max(0, densityCorrection));
  }
  const correction = (p.skewness / 6) * (1 - z2) - (p.excessKurtosis / 24) * (z3 - 3 * z) - ((p.skewness * p.skewness) / 72) * (z3 * z2 - 10 * z3 + 15 * z);
  return clamp(normalCdf + normalPdf * correction, 0, 1);
}

/** Regularized incomplete beta function I_x(a, b): P(Beta(a,b) <= x). */
function regularizedIncompleteBeta(p: BetaParameters, x: number, out: FrontOut = null): number {
  if (out) out.front = 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (p.useAsymptoticCdf) return asymptoticBetaCdf(p, x, out);
  const front = betaFront(p, x);
  if (out) out.front = front;
  // the symmetry relation keeps the continued fraction where it converges best
  if (x < p.symmetryPoint) return (front * betaContinuedFraction(p.a, p.b, x)) / p.a;
  return 1 - (front * betaContinuedFraction(p.b, p.a, 1 - x)) / p.b;
}

const incompleteBeta = (a: number, b: number, x: number) => regularizedIncompleteBeta(makeBetaParameters(a, b, false), x);

/** Standard normal CDF */
const normalCdf = (x: number) => 0.5 * erfc((-x * Math.SQRT2) / 2);

/** Student's t CDF: P(T <= t) for df degrees of freedom */
function studentTCdf(t: number, df: number): number {
  const squared = t * t;
  const denominator = df + squared;
  if (squared < df) {
    const ibeta = incompleteBeta(0.5, df / 2, squared / denominator);
    return t >= 0 ? 0.5 + 0.5 * ibeta : 0.5 - 0.5 * ibeta;
  }
  const ibeta = incompleteBeta(df / 2, 0.5, df / denominator);
  return t >= 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

/** Positive Student's t quantile for an upper-tail probability (bisection on the lower tail). */
function studentTUpperQuantile(p: number, df: number): number {
  let lo = 0;
  let hi = 1;
  while (studentTCdf(-hi, df) > p) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(-mid, df) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Binomial CDF P(X <= k), X ~ Binomial(n, p) = I_{1-p}(n-k, k+1) */
function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return incompleteBeta(n - k, k + 1, 1 - p);
}

// --- QRDE (Harrell-Davis quantiles over the recorded buckets) ---------------------

interface RecordedBucket {
  value: number;
  resolution: number;
  count: number;
  cumulativeCount: number;
}
interface RecordedSnapshot {
  buckets: RecordedBucket[];
  totalCount: number;
}

const enum Dequantization {
  None = 0,
  Hdr = 1,
  All = 2,
}
const DEQUANTIZATION_NAMES = ['none', 'hdr', 'all'];

function buildRecordedSnapshot(h: Hdr): RecordedSnapshot {
  const snapshot: RecordedSnapshot = { buckets: [], totalCount: h.totalCount };
  if (h.totalCount === 0) return snapshot;
  for (const it of h.recorded()) {
    snapshot.buckets.push({ value: it.medianEquivalentValue, resolution: h.sizeOfEquivalentValueRange(it.value), count: it.count, cumulativeCount: it.cumulativeCount });
  }
  return snapshot;
}

const qrdeShouldDequantize = (bucket: RecordedBucket, d: Dequantization) => bucket.count > 1 && (d === Dequantization.All || (d === Dequantization.Hdr && bucket.resolution > 1));

function qrdeBucketRange(snapshot: RecordedSnapshot, index: number, d: Dequantization): [number, number] {
  const bucket = snapshot.buckets[index];
  if (!qrdeShouldDequantize(bucket, d)) return [bucket.value, bucket.value];
  const half = bucket.resolution / 2;
  if (snapshot.buckets.length === 1) return [bucket.value - half, bucket.value + half];
  if (index === 0) return [bucket.value, bucket.value + half];
  if (index + 1 === snapshot.buckets.length) return [bucket.value - half, bucket.value];
  return [bucket.value - half, bucket.value + half];
}

/** The bucket range outside of which both beta tails are negligible; null where that cannot be told. */
function qrdeExactSupport(snapshot: RecordedSnapshot, params: BetaParameters, reflected: BetaParameters, count: number): [number, number] | null {
  // Collapsing both tails changes a quantile by at most 2^-79 of the histogram's range.
  const tailMass = 2 ** -80;
  const n = snapshot.buckets.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const cdf = regularizedIncompleteBeta(params, snapshot.buckets[mid].cumulativeCount / count);
    if (!Number.isFinite(cdf)) return null;
    if (cdf < tailMass) lo = mid + 1;
    else hi = mid;
  }
  if (lo === n) return null;
  const first = lo;
  lo = first;
  hi = n;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const survival = regularizedIncompleteBeta(reflected, (snapshot.totalCount - snapshot.buckets[mid].cumulativeCount) / count);
    if (!Number.isFinite(survival)) return null;
    if (survival > tailMass) lo = mid + 1;
    else hi = mid;
  }
  if (lo === n || lo < first) return null;
  return [first, lo + 1];
}

/** std::lower_bound over the buckets' cumulative counts */
function lowerBound(buckets: RecordedBucket[], from: number, cumulative: number): number {
  let lo = from;
  let hi = buckets.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (buckets[mid].cumulativeCount < cumulative) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function qrdeQuantile(snapshot: RecordedSnapshot, p: number, d: Dequantization): number {
  const count = snapshot.totalCount;
  const a = (count + 1) * p;
  const b = (count + 1) * (1 - p);
  const massParams = makeBetaParameters(a, b, true);
  const reflectedParams = reflectBetaParameters(massParams);
  const buckets = snapshot.buckets;

  let beginIndex = 0;
  let endIndex = buckets.length;
  if (massParams.useAsymptoticCdf) {
    // outside this interval the normal-tail mass is below 2e-33
    const supportDeviations = 12;
    const lowerRank = Math.max(0, massParams.mean - supportDeviations * massParams.standardDeviation);
    const upperRank = Math.min(1, massParams.mean + supportDeviations * massParams.standardDeviation);
    const first = lowerBound(buckets, 0, lowerRank * count);
    const last = lowerBound(buckets, first, upperRank * count);
    beginIndex = first;
    if (last !== buckets.length) endIndex = last + 1;
  } else if (buckets.length >= 512) {
    const support = qrdeExactSupport(snapshot, massParams, reflectedParams, count);
    if (support) [beginIndex, endIndex] = support;
  }

  const dequantize = d !== Dequantization.None;
  const lowerEndpoint = qrdeBucketRange(snapshot, 0, d)[0];
  const upperEndpoint = qrdeBucketRange(snapshot, buckets.length - 1, d)[1];

  let previousCdf = 0;
  let previousSurvival = 0;
  let previousFront = 0;
  let previousCount = beginIndex === 0 ? 0 : buckets[beginIndex - 1].cumulativeCount;
  if (previousCount !== 0) {
    const out = dequantize ? { front: 0 } : null;
    previousCdf = regularizedIncompleteBeta(massParams, previousCount / count, out);
    previousFront = out ? out.front : 0;
    if (!Number.isFinite(previousCdf) || (dequantize && !Number.isFinite(previousFront))) {
      beginIndex = 0;
      endIndex = buckets.length;
      previousCount = 0;
      previousCdf = 0;
      previousFront = 0;
    } else {
      previousCdf = clamp(previousCdf, 0, 1);
    }
  }

  let quantile = lowerEndpoint * previousCdf;
  let usingSurvival = false;
  for (let i = beginIndex; i < endIndex; i++) {
    const bucket = buckets[i];
    const u0 = previousCount / count;
    const u1 = bucket.cumulativeCount / count;
    const out = dequantize ? { front: 0 } : null;
    let mass: number;
    // Above the symmetry point the reflected CDF keeps small upper-tail weights from being lost
    // to a subtraction from one.
    if (u1 <= massParams.symmetryPoint) {
      const cdf = clamp(regularizedIncompleteBeta(massParams, u1, out), previousCdf, 1);
      mass = cdf - previousCdf;
      previousCdf = cdf;
    } else {
      let survival = regularizedIncompleteBeta(reflectedParams, (snapshot.totalCount - bucket.cumulativeCount) / count, out);
      if (usingSurvival) {
        survival = clamp(survival, 0, previousSurvival);
        mass = previousSurvival - survival;
      } else {
        survival = clamp(survival, 0, 1 - previousCdf);
        mass = 1 - previousCdf - survival;
        usingSurvival = true;
      }
      previousSurvival = survival;
    }
    const front = out ? out.front : 0;

    if (!qrdeShouldDequantize(bucket, d)) {
      quantile += bucket.value * mass;
    } else {
      // I_x(a + 1, b) = I_x(a, b) - front / a: the first moment within this rank interval needs no
      // second beta CDF.
      const sum = a + b;
      const rankWidth = bucket.count / count;
      const localMoment = clamp((a / sum - u0) * mass - (front - previousFront) / sum, 0, rankWidth * mass);
      const [lower, upper] = qrdeBucketRange(snapshot, i, d);
      quantile += lower * mass + ((upper - lower) * localMoment) / rankWidth;
    }
    previousFront = front;
    previousCount = bucket.cumulativeCount;
  }

  const remainingMass = usingSurvival ? previousSurvival : 1 - previousCdf;
  quantile += upperEndpoint * clamp(remainingMass, 0, 1);
  return quantile;
}

function calculateQrde(snapshot: RecordedSnapshot, probabilities: number[], d: Dequantization) {
  const result = { quantiles: [] as number[], densities: [] as number[], corrections: 0 };
  if (snapshot.buckets.length === 0) return result;
  const n = probabilities.length;
  const quantiles = new Array<number>(n).fill(0);
  quantiles[0] = qrdeBucketRange(snapshot, 0, d)[0];
  quantiles[n - 1] = qrdeBucketRange(snapshot, snapshot.buckets.length - 1, d)[1];
  for (let i = 1; i + 1 < n; i++) {
    let value = clamp(qrdeQuantile(snapshot, probabilities[i], d), quantiles[0], quantiles[n - 1]);
    if (value < quantiles[i - 1]) {
      value = quantiles[i - 1];
      result.corrections++;
    }
    quantiles[i] = value;
  }
  for (let i = 0; i + 1 < n; i++) {
    const width = quantiles[i + 1] - quantiles[i];
    result.densities.push(width === 0 ? Infinity : (probabilities[i + 1] - probabilities[i]) / width);
  }
  result.quantiles = quantiles;
  return result;
}

// --- export format (a CBOR map; see Histogram::Export in histogram.cc) ---------------------

const CBOR_UINT = 0 << 5;
const CBOR_ARRAY = 4 << 5;
const CBOR_MAP = 5 << 5;
const CBOR_FLOAT64 = 0xfb;

class CborWriter {
  bytes: number[] = [];
  uint(major: number, v: number | bigint) {
    const val = typeof v === 'bigint' ? v : big(v);
    const out = this.bytes;
    if (val <= 23n) out.push(major | Number(val));
    else if (val <= 0xffn) out.push(major | 24, Number(val));
    else if (val <= 0xffffn) out.push(major | 25, Number(val >> 8n), Number(val & 0xffn));
    else if (val <= 0xffffffffn) {
      out.push(major | 26);
      for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((val >> s) & 0xffn));
    } else {
      out.push(major | 27);
      for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((val >> s) & 0xffn));
    }
  }
  float64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v); // network byte order
    this.bytes.push(CBOR_FLOAT64, ...b);
  }
}

class CborReader {
  p = 0;
  constructor(private readonly d: Uint8Array) {}
  get end() {
    return this.d.length;
  }
  /** CborReadUint: the argument of any major type */
  readArg(): bigint | null {
    const d = this.d;
    if (this.p >= d.length) return null;
    const info = d[this.p++] & 0x1f;
    if (info <= 23) return BigInt(info);
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (n === 0 || this.p + n > d.length) return null; // indefinite length / reserved
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(d[this.p++]);
    return v;
  }
  /** CborReadArgument: a data item of the given major type */
  arg(major: number): bigint | null {
    if (this.p >= this.d.length || (this.d[this.p] & 0xe0) !== major) return null;
    return this.readArg();
  }
  int(max: bigint): number | null {
    const v = this.arg(CBOR_UINT);
    return v === null || v > max ? null : Number(v);
  }
  float64(): number | null {
    if (this.p >= this.d.length || this.d[this.p] !== CBOR_FLOAT64) return null;
    this.p++;
    if (this.p + 8 > this.d.length) return null;
    const v = new DataView(this.d.buffer, this.d.byteOffset + this.p, 8).getFloat64(0);
    this.p += 8;
    return v;
  }
  /** CborReadNumber: a uint or a float64 */
  number(): number | null {
    if (this.p >= this.d.length) return null;
    if (this.d[this.p] === CBOR_FLOAT64) return this.float64();
    const v = this.arg(CBOR_UINT);
    return v === null ? null : Number(v);
  }
  /** CborSkipItem: one well-formed item and what it nests (definite lengths only) */
  skip(depth = 0): boolean {
    const d = this.d;
    if (this.p >= d.length || depth > 16) return false;
    const major = d[this.p] >> 5;
    const info = d[this.p] & 0x1f;
    if (major === 7) {
      let extra: number;
      if (info <= 23) extra = 0;
      else if (info <= 27) extra = 1 << (info - 24);
      else return false;
      this.p++;
      if (d.length - this.p < extra) return false;
      this.p += extra;
      return true;
    }
    const arg = this.readArg();
    if (arg === null) return false;
    switch (major) {
      case 0:
      case 1:
        return true;
      case 2:
      case 3:
        if (arg > BigInt(d.length - this.p)) return false;
        this.p += Number(arg);
        return true;
      case 4:
      case 5: {
        // each item takes at least one byte, which also bounds the loop
        if (arg > BigInt(d.length - this.p)) return false;
        const items = major === 4 ? Number(arg) : Number(arg) * 2;
        for (let i = 0; i < items; i++) if (!this.skip(depth + 1)) return false;
        return true;
      }
      case 6:
        return this.skip(depth + 1);
    }
    return false;
  }
}

const EXPORT_VERSION = 2;
const STRICT_EXPORT_VERSION = 1;
const KEY_VERSION = 0;
const KEY_LOWEST = 1;
const KEY_HIGHEST = 2;
const KEY_FIGURES = 3;
const KEY_TOTAL_COUNT = 4;
const KEY_MIN = 5;
const KEY_MAX = 6;
const KEY_NORM_OFFSET = 7;
const KEY_CONV_RATIO = 8;
const KEY_COUNTS_LEN = 9;
const KEY_COUNTS = 10;
const KEY_EWMA = 11;
const EWMA_THRESHOLD = 4;
const I32_MAX = 0x7fffffffn;

// -----------------------------------------------------------------------------
// node::Histogram

interface Options {
  lowest: number;
  highest: number;
  figures: number;
  halfLife?: number;
  threshold?: number;
}

/** node::Histogram: an HDR histogram plus exceeds/reset counts and EWMA state */
class NodeHistogram {
  prev = 0;
  exceeds = 0;
  resetCount = 0;
  ewmaAlpha = 0;
  ewmaMean = 0;
  ewmaVariance = 0;
  ewmaInitialized = false;
  threshold = 0;
  ewmaErrorRate = 0;
  private generation = 0;
  private snapshotCache: RecordedSnapshot | null = null;

  constructor(
    readonly hdr: Hdr,
    options: Options,
  ) {
    // alpha = 1 - 2^(-1/halfLife); halfLife <= 0 disables EWMA
    if ((options.halfLife ?? 0) > 0) this.ewmaAlpha = 1 - exactExp(-Math.log(2) / options.halfLife!);
    this.threshold = options.threshold ?? 0;
  }

  static create(options: Options): NodeHistogram | null {
    const hdr = Hdr.create(options.lowest, options.highest, options.figures);
    return hdr ? new NodeHistogram(hdr, options) : null;
  }

  private createWithSameLayout(): NodeHistogram {
    return NodeHistogram.create({ lowest: this.hdr.lowest, highest: this.hdr.highest, figures: this.hdr.figures })!;
  }

  clone(): NodeHistogram {
    const c = this.createWithSameLayout();
    c.hdr.copyFrom(this.hdr);
    c.prev = this.prev;
    c.exceeds = this.exceeds;
    c.resetCount = this.resetCount;
    c.ewmaAlpha = this.ewmaAlpha;
    c.ewmaMean = this.ewmaMean;
    c.ewmaVariance = this.ewmaVariance;
    c.ewmaInitialized = this.ewmaInitialized;
    c.threshold = this.threshold;
    c.ewmaErrorRate = this.ewmaErrorRate;
    return c;
  }

  isCompatible(other: NodeHistogram): boolean {
    const a = this.hdr;
    const b = other.hdr;
    return a.countsLen === b.countsLen && a.lowest === b.lowest && a.highest === b.highest && a.figures === b.figures;
  }

  /** Histogram::Diff: the values recorded after `other`, an earlier snapshot of this histogram */
  diff(other: NodeHistogram): NodeHistogram | 'incompatible' | 'reset' | 'notEarlier' {
    if (!this.isCompatible(other) || this.hdr.normalizingIndexOffset !== other.hdr.normalizingIndexOffset) return 'incompatible';
    const d = this.createWithSameLayout();
    // only the recorded values and the exceeds count carry over: EWMA and timing state cannot be subtracted
    d.hdr.copyFrom(this.hdr);
    d.exceeds = this.exceeds;
    if (this.resetCount !== other.resetCount) return 'reset';
    if (d.exceeds < other.exceeds) return 'notEarlier';
    const target = d.hdr.counts;
    const source = other.hdr.counts;
    for (let i = 0; i < target.length; i++) {
      if (target[i] < source[i]) return 'notEarlier';
      target[i] -= source[i];
    }
    d.exceeds -= other.exceeds;
    d.hdr.resetInternalCounters();
    return d;
  }

  private invalidateSnapshot() {
    this.generation++;
    this.snapshotCache = null;
  }

  private updateEwma(value: number) {
    if (this.ewmaAlpha <= 0) return;
    if (!this.ewmaInitialized) {
      this.ewmaMean = value;
      this.ewmaVariance = 0;
      this.ewmaInitialized = true;
      if (this.threshold > 0) this.ewmaErrorRate = value > this.threshold ? 1 : 0;
      return;
    }
    const diff = value - this.ewmaMean;
    this.ewmaMean += this.ewmaAlpha * diff;
    this.ewmaVariance = (1 - this.ewmaAlpha) * (this.ewmaVariance + this.ewmaAlpha * diff * diff);
    // binary EWMA for the SLO error rate: 1 when over the threshold
    if (this.threshold > 0) {
      const exceeded = value > this.threshold ? 1 : 0;
      this.ewmaErrorRate += this.ewmaAlpha * (exceeded - this.ewmaErrorRate);
    }
  }

  record(value: number): boolean {
    const ok = this.hdr.recordValues(value, 1);
    if (!ok) this.exceeds++;
    else {
      this.invalidateSnapshot();
      this.updateEwma(value);
    }
    return ok;
  }

  recordCorrected(value: number, expectedInterval: number): boolean {
    const ok = this.hdr.recordCorrectedValues(value, 1, expectedInterval);
    if (!ok) this.exceeds++;
    else {
      this.invalidateSnapshot();
      this.updateEwma(value);
    }
    return ok;
  }

  /** Records the nanoseconds since the previous call (nothing on the first call); returns them. */
  recordDelta(): number {
    const time = Math.round(perfNow() * 1e6);
    let delta = 0;
    if (this.prev > 0) {
      delta = Math.max(0, time - this.prev);
      if (!this.hdr.recordValues(delta, 1)) this.exceeds++;
      else {
        this.invalidateSnapshot();
        this.updateEwma(delta);
      }
    }
    this.prev = time;
    return delta;
  }

  reset() {
    this.hdr.reset();
    this.invalidateSnapshot();
    this.resetCount++;
    this.exceeds = 0;
    this.prev = 0;
    this.ewmaMean = 0;
    this.ewmaVariance = 0;
    this.ewmaErrorRate = 0;
    this.ewmaInitialized = false;
  }

  add(other: NodeHistogram): number {
    this.exceeds += other.exceeds;
    if (other.prev > this.prev) this.prev = other.prev;
    // hdr_add merges the bucket counts and total_count
    const dropped = this.hdr.add(other.hdr);
    this.invalidateSnapshot();
    return dropped;
  }

  /** Removes other's counts index by index (clamped at zero); returns how many could not be removed. */
  subtract(other: NodeHistogram): number {
    let dropped = 0;
    const len = Math.min(this.hdr.countsLen, other.hdr.countsLen);
    const counts = this.hdr.counts;
    for (let i = 0; i < len; i++) {
      let count = counts[i] - other.hdr.counts[i];
      if (count < 0) {
        dropped += -count;
        count = 0;
      }
      counts[i] = count;
    }
    this.hdr.resetInternalCounters();
    this.invalidateSnapshot();
    this.resetCount++;
    this.exceeds = this.exceeds > other.exceeds ? this.exceeds - other.exceeds : 0;
    return dropped;
  }

  ewmaMeanValue = () => (this.ewmaInitialized ? this.ewmaMean : 0);
  ewmaStddevValue = () => (this.ewmaInitialized ? Math.sqrt(this.ewmaVariance) : 0);
  ewmaErrorRateValue = () => (this.ewmaInitialized ? this.ewmaErrorRate : 0);

  cdf(value: number): number {
    const total = this.hdr.totalCount;
    if (total === 0) return 0;
    for (const it of this.hdr.allValues()) {
      if (it.highestEquivalentValue >= value) return it.cumulativeCount / total;
      // all recorded data accounted for; the remaining buckets are empty
      if (it.cumulativeCount >= total) break;
    }
    return 1;
  }

  /** the central moments m2 and m(k) over the recorded buckets */
  private moments(k: 3 | 4): [number, number] {
    const h = this.hdr;
    const mean = h.mean();
    let m2 = 0;
    let mk = 0;
    for (const it of h.recorded()) {
      const dev = h.medianEquivalentValue(it.value) - mean;
      const d2 = dev * dev;
      m2 += it.count * d2;
      // the C++ evaluation order: (count * d2) * dev
      mk += k === 3 ? it.count * d2 * dev : it.count * d2 * d2;
    }
    return [m2, mk];
  }

  skewness(): number {
    const total = this.hdr.totalCount;
    if (total < 3) return 0;
    const [m2, m3] = this.moments(3);
    const variance = m2 / total;
    if (variance === 0) return 0;
    return m3 / total / (variance * Math.sqrt(variance));
  }

  kurtosis(): number {
    const total = this.hdr.totalCount;
    if (total < 4) return 0;
    const [m2, m4] = this.moments(4);
    const variance = m2 / total;
    if (variance === 0) return 0;
    return m4 / total / (variance * variance) - 3;
  }

  ksTest(other: NodeHistogram): number {
    if (this === other) return 0;
    const n1 = this.hdr.totalCount;
    const n2 = other.hdr.totalCount;
    if (n1 === 0 || n2 === 0) return 0;
    let maxD = 0;
    let cum1 = 0;
    let cum2 = 0;
    const len = Math.max(this.hdr.countsLen, other.hdr.countsLen);
    for (let i = 0; i < len; i++) {
      if (i < this.hdr.countsLen) cum1 += this.hdr.counts[i];
      if (i < other.hdr.countsLen) cum2 += other.hdr.counts[i];
      const cdf1 = cum1 / n1;
      const cdf2 = cum2 / n2;
      const d = cdf1 > cdf2 ? cdf1 - cdf2 : cdf2 - cdf1;
      if (d > maxD) maxD = d;
    }
    return maxD;
  }

  meanCI(confidence: number): [number, number, number] {
    const count = this.hdr.totalCount;
    const mean = this.hdr.mean();
    if (count < 2) return [mean, NaN, NaN];
    const stddev = this.hdr.stddev();
    if (stddev === 0) return [mean, mean, mean];
    // HdrHistogram's stddev is the population one; the interval needs the sample variance
    const variance = (stddev * stddev * count) / (count - 1);
    const standardError = Math.sqrt(variance / count);
    const tCrit = studentTUpperQuantile((1 - confidence) / 2, count - 1);
    const margin = tCrit * standardError;
    return [mean, mean - margin, mean + margin];
  }

  /** means, sample variances (Bessel's correction) and counts of both, for the two-sample statistics */
  private twoSamples(other: NodeHistogram) {
    const n1 = this.hdr.totalCount;
    const n2 = other.hdr.totalCount;
    const mean1 = this.hdr.mean();
    const mean2 = other.hdr.mean();
    const sd1 = this.hdr.stddev();
    const sd2 = other.hdr.stddev();
    return { n1, n2, mean1, mean2, var1: (sd1 * sd1 * n1) / (n1 - 1), var2: (sd2 * sd2 * n2) / (n2 - 1) };
  }

  welchTest(other: NodeHistogram, confidence: number): number[] {
    if (this === other) return [0, 0, 1, 0, 0];
    if (this.hdr.totalCount < 2 || other.hdr.totalCount < 2) return [0, 0, 1, 0, 0];
    const { n1, n2, mean1, mean2, var1, var2 } = this.twoSamples(other);
    const se1 = var1 / n1;
    const se2 = var2 / n2;
    const seSum = se1 + se2;
    if (seSum === 0) return [0, 0, 1, 0, 0];
    const t = (mean1 - mean2) / Math.sqrt(seSum);
    // Welch-Satterthwaite degrees of freedom
    const df = (seSum * seSum) / ((se1 * se1) / (n1 - 1) + (se2 * se2) / (n2 - 1));
    const p = 2 * studentTCdf(-Math.abs(t), df);
    const tCrit = studentTUpperQuantile((1 - confidence) / 2, df);
    const margin = tCrit * Math.sqrt(seSum);
    const diff = mean1 - mean2;
    return [t, df, p, diff - margin, diff + margin];
  }

  /** pairs of (this value > other value) and ties, walking both count arrays */
  private concordance(other: NodeHistogram): { concordant: number; tied: number; len: number } {
    const a = this.hdr;
    const b = other.hdr;
    const len = Math.max(a.countsLen, b.countsLen);
    let cum2 = 0;
    let concordant = 0;
    let tied = 0;
    for (let i = 0; i < len; i++) {
      const c1 = i < a.countsLen ? a.counts[i] : 0;
      const c2 = i < b.countsLen ? b.counts[i] : 0;
      concordant += c1 * cum2;
      tied += c1 * c2;
      cum2 += c2;
    }
    return { concordant, tied, len };
  }

  mannWhitneyTest(other: NodeHistogram): number[] {
    if (this === other) return [0, 0, 1];
    const n1 = this.hdr.totalCount;
    const n2 = other.hdr.totalCount;
    if (n1 === 0 || n2 === 0) return [0, 0, 1];
    const { concordant, tied, len } = this.concordance(other);
    // U for sample 1: concordant pairs plus half of the ties
    const u = concordant + 0.5 * tied;
    const mu = (n1 * n2) / 2;
    // tie correction: sigma^2 = n1*n2/12 * (N+1 - sum(t^3 - t) / (N*(N-1)))
    const nTotal = n1 + n2;
    let tieCorrection = 0;
    for (let i = 0; i < len; i++) {
      const c1 = i < this.hdr.countsLen ? this.hdr.counts[i] : 0;
      const c2 = i < other.hdr.countsLen ? other.hdr.counts[i] : 0;
      const tk = c1 + c2;
      if (tk > 1) tieCorrection += tk * tk * tk - tk;
    }
    const sigmaSq = ((n1 * n2) / 12) * (nTotal + 1 - tieCorrection / (nTotal * (nTotal - 1)));
    if (sigmaSq <= 0) return [u, 0, 1];
    const z = (u - mu) / Math.sqrt(sigmaSq);
    return [u, z, 2 * normalCdf(-Math.abs(z))];
  }

  cohensD(other: NodeHistogram): number {
    if (this === other) return 0;
    if (this.hdr.totalCount < 2 || other.hdr.totalCount < 2) return 0;
    const { n1, n2, mean1, mean2, var1, var2 } = this.twoSamples(other);
    const pooledSd = Math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2));
    if (pooledSd === 0) return 0;
    return (mean1 - mean2) / pooledSd;
  }

  cliffsD(other: NodeHistogram): number {
    if (this === other) return 0;
    const n1 = this.hdr.totalCount;
    const n2 = other.hdr.totalCount;
    if (n1 === 0 || n2 === 0) return 0;
    const { concordant, tied } = this.concordance(other);
    const discordant = n1 * n2 - concordant - tied;
    return (concordant - discordant) / (n1 * n2);
  }

  /** exact binomial confidence interval for a percentile */
  percentileCI(percentile: number, confidence: number): [number, number, number] {
    const h = this.hdr;
    const value = h.valueAtPercentile(percentile);
    const n = h.totalCount;
    if (n < 2) return [value, value, value];
    const p = percentile / 100;
    const alpha = 1 - confidence;
    // lower rank: the largest j with BinomialCdf(j-1, n, p) <= alpha/2
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo + 1) / 2);
      if (binomialCdf(mid - 1, n, p) <= alpha / 2) lo = mid;
      else hi = mid - 1;
    }
    const lowerPct = (lo / n) * 100;
    // upper rank: the smallest k with BinomialCdf(k-1, n, p) >= 1 - alpha/2
    lo = 0;
    hi = n;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (binomialCdf(mid - 1, n, p) >= 1 - alpha / 2) hi = mid;
      else lo = mid + 1;
    }
    const upperPct = (lo / n) * 100;
    return [value, h.valueAtPercentile(lowerPct), h.valueAtPercentile(upperPct)];
  }

  /** the recorded buckets QRDE works on, from the cache when allowed */
  recordedSnapshot(useCache: boolean): RecordedSnapshot {
    if (useCache && this.snapshotCache) return this.snapshotCache;
    const snapshot = buildRecordedSnapshot(this.hdr);
    if (useCache) this.snapshotCache = snapshot;
    return snapshot;
  }

  export(): Uint8Array {
    const h = this.hdr;
    const w = new CborWriter();
    const hasEwma = this.ewmaAlpha > 0;
    w.uint(CBOR_MAP, hasEwma ? 12 : 11);
    const entry = (key: number, v: number) => {
      w.uint(CBOR_UINT, key);
      w.uint(CBOR_UINT, v);
    };
    entry(KEY_VERSION, EXPORT_VERSION);
    entry(KEY_LOWEST, h.lowest);
    entry(KEY_HIGHEST, h.highest);
    entry(KEY_FIGURES, h.figures);
    entry(KEY_TOTAL_COUNT, h.totalCount);
    entry(KEY_MIN, h.minValue);
    entry(KEY_MAX, h.maxValue);
    entry(KEY_NORM_OFFSET, h.normalizingIndexOffset);
    w.uint(CBOR_UINT, KEY_CONV_RATIO);
    w.float64(h.conversionRatio);
    entry(KEY_COUNTS_LEN, h.countsLen);
    // sparse counts: [index delta, count, ...], the first delta being the absolute index
    w.uint(CBOR_UINT, KEY_COUNTS);
    let nonZero = 0;
    for (let i = 0; i < h.countsLen; i++) if (h.counts[i] !== 0) nonZero++;
    w.uint(CBOR_ARRAY, nonZero * 2);
    let prev = 0;
    for (let i = 0; i < h.countsLen; i++) {
      if (h.counts[i] === 0) continue;
      w.uint(CBOR_UINT, i - prev);
      w.uint(CBOR_UINT, h.counts[i]);
      prev = i;
    }
    if (hasEwma) {
      w.uint(CBOR_UINT, KEY_EWMA);
      w.uint(CBOR_MAP, 5);
      w.uint(CBOR_UINT, 0);
      w.float64(this.ewmaAlpha);
      w.uint(CBOR_UINT, 1);
      w.float64(this.ewmaMean);
      w.uint(CBOR_UINT, 2);
      w.float64(this.ewmaVariance);
      w.uint(CBOR_UINT, 3);
      w.float64(this.ewmaErrorRate);
      w.uint(CBOR_UINT, EWMA_THRESHOLD);
      w.uint(CBOR_UINT, this.threshold);
    }
    return new Uint8Array(w.bytes);
  }

  /** Histogram::Import; null for data it rejects */
  static import(data: Uint8Array): NodeHistogram | null {
    const r = new CborReader(data);
    const mapSize = r.arg(CBOR_MAP);
    if (mapSize === null) return null;
    let lowest = 1;
    let highest = INT64_MAX;
    let figures = 3;
    let totalCount = 0;
    let minValue = INT64_MAX;
    let maxValue = 0;
    let normOffset = 0;
    let convRatio = 1;
    let countsLen = 0;
    // data without a version key is imported as version 1
    let version = BigInt(STRICT_EXPORT_VERSION);
    const seen = new Set<number>();
    const seenEwma = new Set<number>();
    // unknown keys are skipped while parsing: the version that decides whether they are allowed can come anywhere
    let hasUnknownKeys = false;
    const sparse: [number, number][] = [];
    let ewmaAlpha = 0;
    let ewmaMean = 0;
    let ewmaVariance = 0;
    let ewmaErrorRate = 0;
    let threshold = 0;
    const I64_MAX = INT64_MAX_BIG;
    const toNumber = (v: number) => (v === Number(I64_MAX) ? INT64_MAX : v);

    for (let i = 0n; i < mapSize; i++) {
      const keyBig = r.arg(CBOR_UINT);
      if (keyBig === null) return null;
      if (keyBig > BigInt(KEY_EWMA)) {
        if (!r.skip()) return null;
        hasUnknownKeys = true;
        continue;
      }
      const key = Number(keyBig);
      if (seen.has(key)) return null; // duplicate key
      seen.add(key);
      let v: number | null;
      switch (key) {
        case KEY_VERSION: {
          const ver = r.arg(CBOR_UINT);
          if (ver === null || ver < BigInt(STRICT_EXPORT_VERSION) || ver > BigInt(EXPORT_VERSION)) return null;
          version = ver;
          break;
        }
        case KEY_LOWEST:
          if ((v = r.int(I64_MAX)) === null) return null;
          lowest = toNumber(v);
          break;
        case KEY_HIGHEST:
          if ((v = r.int(I64_MAX)) === null) return null;
          highest = toNumber(v);
          break;
        case KEY_FIGURES:
          if ((v = r.int(I32_MAX)) === null) return null;
          figures = v;
          break;
        case KEY_TOTAL_COUNT:
          if ((v = r.int(I64_MAX)) === null) return null;
          totalCount = v;
          break;
        case KEY_MIN:
          if ((v = r.int(I64_MAX)) === null) return null;
          minValue = toNumber(v);
          break;
        case KEY_MAX:
          if ((v = r.int(I64_MAX)) === null) return null;
          maxValue = toNumber(v);
          break;
        case KEY_NORM_OFFSET:
          // values that do not fit an int32_t would wrap to an arbitrary offset
          if ((v = r.int(I32_MAX)) === null) return null;
          normOffset = v;
          break;
        case KEY_CONV_RATIO:
          if ((v = r.number()) === null) return null;
          convRatio = v;
          break;
        case KEY_COUNTS_LEN:
          if ((v = r.int(I32_MAX)) === null) return null;
          countsLen = v;
          break;
        case KEY_COUNTS: {
          const arrLen = r.arg(CBOR_ARRAY);
          if (arrLen === null || arrLen % 2n !== 0n) return null;
          // each element takes at least a byte, which bounds a crafted length
          if (arrLen > BigInt(r.end - r.p)) return null;
          let acc = 0;
          for (let j = 0; j < Number(arrLen); j += 2) {
            const delta = r.int(I32_MAX);
            if (delta === null) return null;
            const cnt = r.int(I64_MAX);
            if (cnt === null) return null;
            // indices are strictly increasing: only the first delta may be zero
            if (j > 0 && delta === 0) return null;
            acc += delta;
            if (acc > Number(I32_MAX)) return null;
            sparse.push([acc, cnt]);
          }
          break;
        }
        case KEY_EWMA: {
          const subSize = r.arg(CBOR_MAP);
          if (subSize === null) return null;
          for (let j = 0n; j < subSize; j++) {
            const sub = r.arg(CBOR_UINT);
            if (sub === null) return null;
            if (sub > BigInt(EWMA_THRESHOLD)) {
              if (!r.skip()) return null;
              hasUnknownKeys = true;
              continue;
            }
            const subKey = Number(sub);
            if (seenEwma.has(subKey)) return null;
            seenEwma.add(subKey);
            if (subKey === EWMA_THRESHOLD) {
              if ((v = r.int(I64_MAX)) === null) return null;
              threshold = v;
            } else {
              if ((v = r.number()) === null) return null;
              if (subKey === 0) ewmaAlpha = v;
              else if (subKey === 1) ewmaMean = v;
              else if (subKey === 2) ewmaVariance = v;
              else ewmaErrorRate = v;
            }
          }
          break;
        }
      }
    }

    // version 1 data keeps its original semantics: unknown keys are rejected
    if (version === BigInt(STRICT_EXPORT_VERSION) && hasUnknownKeys) return null;

    // halfLife from alpha: alpha = 1 - 2^(-1/halfLife)
    const halfLife = ewmaAlpha > 0 && ewmaAlpha < 1 ? -1 / Math.log2(1 - ewmaAlpha) : 0;
    const histogram = NodeHistogram.create({ lowest, highest, figures, halfLife, threshold });
    if (!histogram) return null;
    const h = histogram.hdr;
    if (h.countsLen !== countsLen) return null;
    // normalize_index() wraps at most once: an offset outside [0, counts_len) could index out of bounds
    if (normOffset < 0 || normOffset >= countsLen) return null;
    let observed = 0;
    for (const [idx, cnt] of sparse) {
      if (idx < 0 || idx >= countsLen) return null;
      if (cnt > Number.MAX_SAFE_INTEGER - observed) return null;
      observed += cnt;
      h.counts[idx] = cnt;
    }
    h.normalizingIndexOffset = normOffset;
    h.conversionRatio = convRatio;
    // total, min and max follow from the counts; a total that is present must match them, and a
    // min/max that is present is restored as recorded
    h.resetInternalCounters();
    if (seen.has(KEY_TOTAL_COUNT) && totalCount !== h.totalCount) return null;
    if (seen.has(KEY_MIN)) h.minValue = minValue;
    if (seen.has(KEY_MAX)) h.maxValue = maxValue;
    if (ewmaAlpha > 0) {
      histogram.ewmaMean = ewmaMean;
      histogram.ewmaVariance = ewmaVariance;
      histogram.ewmaErrorRate = ewmaErrorRate;
      histogram.ewmaInitialized = true;
    }
    return histogram;
  }
}

// -----------------------------------------------------------------------------
// the binding's classes

/** int64_t from a Number (static_cast, truncating) or a BigInt (Int64Value: lossless or not) */
function int64Arg(v: unknown): { value: number; lossless: boolean } {
  if (typeof v === 'bigint') {
    const lossless = BigInt.asIntN(64, v) === v;
    const w = BigInt.asIntN(64, v);
    return { value: w === INT64_MAX_BIG ? INT64_MAX : Number(w), lossless };
  }
  check(typeof v === 'number', 'value must be a number or a bigint');
  // static_cast<int64_t> of a double outside the int64 range (or NaN) gives INT64_MIN on x86-64
  if (!(v > -INT64_MAX && v < INT64_MAX)) return { value: -INT64_MAX, lossless: true };
  return { value: Math.trunc(v), lossless: true };
}

const histograms = new WeakMap<object, NodeHistogram>();

function implOf(self: unknown): NodeHistogram {
  const h = typeof self === 'object' && self !== null ? histograms.get(self) : undefined;
  check(h, 'not a histogram');
  return h;
}

/** HistogramImpl's methods (shared by Histogram and the event loop delay histograms) */
class HistogramImpl {
  constructor(h: NodeHistogram) {
    histograms.set(this, h);
  }

  count() {
    return implOf(this).hdr.totalCount;
  }
  countBigInt() {
    return BigInt(implOf(this).hdr.totalCount);
  }
  exceeds() {
    return implOf(this).exceeds;
  }
  exceedsBigInt() {
    return BigInt(implOf(this).exceeds);
  }
  min() {
    return implOf(this).hdr.min();
  }
  minBigInt() {
    return big(implOf(this).hdr.min());
  }
  max() {
    return implOf(this).hdr.max();
  }
  maxBigInt() {
    return big(implOf(this).hdr.max());
  }
  mean() {
    return implOf(this).hdr.mean();
  }
  stddev() {
    return implOf(this).hdr.stddev();
  }
  percentile(p: unknown) {
    check(typeof p === 'number', 'percentile must be a number');
    return implOf(this).hdr.valueAtPercentile(p);
  }
  percentileBigInt(p: unknown) {
    check(typeof p === 'number', 'percentile must be a number');
    return big(implOf(this).hdr.valueAtPercentile(p));
  }
  percentiles(map: Map<number, number>) {
    check(map instanceof Map, 'percentiles takes a Map');
    implOf(this).hdr.percentiles((k, v) => map.set(k, v));
  }
  percentilesBigInt(map: Map<number, bigint>) {
    check(map instanceof Map, 'percentilesBigInt takes a Map');
    implOf(this).hdr.percentiles((k, v) => map.set(k, big(v)));
  }
  skewness() {
    return implOf(this).skewness();
  }
  kurtosis() {
    return implOf(this).kurtosis();
  }
  cdf(value: unknown) {
    check(typeof value === 'number', 'value must be a number');
    return implOf(this).cdf(Math.trunc(value));
  }
  countAt(value: unknown) {
    check(typeof value === 'number', 'value must be a number');
    return implOf(this).hdr.countAtValue(Math.trunc(value));
  }
  ksTest(other: unknown) {
    return implOf(this).ksTest(implOf(other));
  }
  percentilesAt(map: Map<number, number>, input: unknown) {
    check(map instanceof Map, 'percentilesAt takes a Map');
    check(input instanceof Float64Array, 'percentiles must be a Float64Array');
    const values = implOf(this).hdr.valuesAtPercentiles(input);
    for (let i = 0; i < input.length; i++) map.set(input[i], values[i]);
  }
  linearBuckets(stepSize: unknown, map: Map<number, number>) {
    check(typeof stepSize === 'number' && map instanceof Map, 'linearBuckets(stepSize, map)');
    implOf(this).hdr.linearBuckets(Math.trunc(stepSize), (v, c) => map.set(v, c));
  }
  logBuckets(firstBucket: unknown, base: unknown, map: Map<number, number>) {
    check(typeof firstBucket === 'number' && typeof base === 'number' && map instanceof Map, 'logBuckets(firstBucket, base, map)');
    implOf(this).hdr.logBuckets(Math.trunc(firstBucket), base, (v, c) => map.set(v, c));
  }
  meanCI(confidence: unknown) {
    check(typeof confidence === 'number', 'confidence must be a number');
    return implOf(this).meanCI(confidence);
  }
  welchTest(other: unknown, confidence: unknown) {
    check(typeof confidence === 'number', 'confidence must be a number');
    return implOf(this).welchTest(implOf(other), confidence);
  }
  mannWhitneyTest(other: unknown) {
    return implOf(this).mannWhitneyTest(implOf(other));
  }
  cohensD(other: unknown) {
    return implOf(this).cohensD(implOf(other));
  }
  cliffsD(other: unknown) {
    return implOf(this).cliffsD(implOf(other));
  }
  percentileCI(percentile: unknown, confidence: unknown) {
    check(typeof percentile === 'number' && typeof confidence === 'number', 'percentileCI(percentile, confidence)');
    return implOf(this).percentileCI(percentile, confidence);
  }
  /** Resolves on a later task (the threadpool round trip in Node). */
  qrde(input: unknown, dequantization: unknown, cache: unknown) {
    check(input instanceof Float64Array && input.length >= 2 && input.length <= 1001, 'probabilities must be a Float64Array of 2 to 1001');
    check(dequantization === 0 || dequantization === 1 || dequantization === 2, 'dequantization must be 0, 1 or 2');
    check(typeof cache === 'boolean', 'cache must be a boolean');
    const probabilities = Array.from(input);
    const snapshot = implOf(this).recordedSnapshot(cache);
    const d = dequantization as Dequantization;
    return new Promise((resolve) => {
      const done = startReq('QrdeJob');
      macrotask(() => {
        done();
        const result = calculateQrde(snapshot, probabilities, d);
        scope(() =>
          resolve(
            Object.assign(Object.create(null), {
              probabilities: new Float64Array(probabilities),
              quantiles: new Float64Array(result.quantiles),
              densities: new Float64Array(result.densities),
              count: BigInt(snapshot.totalCount),
              bucketCount: snapshot.buckets.length,
              corrections: result.corrections,
              dequantize: DEQUANTIZATION_NAMES[d],
            }),
          ),
        );
      });
    });
  }
  ewmaMean() {
    return implOf(this).ewmaMeanValue();
  }
  ewmaStddev() {
    return implOf(this).ewmaStddevValue();
  }
  ewmaErrorRate() {
    return implOf(this).ewmaErrorRateValue();
  }
  export() {
    return implOf(this).export();
  }
  snapshot() {
    return Histogram.wrap(implOf(this).clone());
  }
  diff(other: unknown) {
    const d = implOf(this).diff(implOf(other));
    if (d === 'incompatible') throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'other must have the same configuration as the histogram');
    if (d === 'reset') throw nodeError(Error, 'ERR_INVALID_STATE', 'Values were removed from the histogram after other was taken');
    if (d === 'notEarlier') throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'other contains values that are not in the histogram');
    return Histogram.wrap(d);
  }
  resetCount() {
    return implOf(this).resetCount;
  }
  reset() {
    implOf(this).reset();
  }
}

/** HistogramBase: the recordable histogram createHistogram() makes */
export class Histogram extends HistogramImpl {
  // new Histogram(lowest, highest, figures[, halfLife[, threshold]])
  constructor(lowest: unknown = 1, highest: unknown = INT64_MAX, figures: unknown = 3, halfLife?: unknown, threshold?: unknown) {
    const lo = int64Arg(lowest);
    if (!lo.lossless) throw outOfRange('options.lowest is out of range');
    const hi = int64Arg(highest);
    if (!hi.lossless) throw outOfRange('options.highest is out of range');
    check(typeof figures === 'number' && figures >>> 0 === figures, 'figures must be a uint32');
    const h = NodeHistogram.create({
      lowest: lo.value,
      highest: hi.value,
      figures,
      halfLife: typeof halfLife === 'number' ? halfLife : 0,
      threshold: typeof threshold === 'number' ? Math.trunc(threshold) : 0,
    });
    if (!h) throw invalidOptions();
    super(h);
  }

  /** a HistogramBase around an existing native histogram (snapshot, diff, import) */
  static wrap(h: NodeHistogram): Histogram {
    const o = Object.create(Histogram.prototype) as Histogram;
    histograms.set(o, h);
    return o;
  }

  static import(data: unknown) {
    if (!(data instanceof Uint8Array)) throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'data must be a Uint8Array');
    const h = NodeHistogram.import(data);
    if (!h) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid histogram export data');
    return Histogram.wrap(h);
  }

  record(v: unknown) {
    const { value, lossless } = int64Arg(v);
    if (!lossless || value < 0) throw outOfRange();
    implOf(this).record(value);
  }
  recordDelta() {
    implOf(this).recordDelta();
  }
  recordCorrected(v: unknown, interval: unknown) {
    const a = int64Arg(v);
    if (!a.lossless || a.value < 0) throw outOfRange();
    const b = int64Arg(interval);
    if (!b.lossless || b.value < 1) throw outOfRange('expected_interval is out of range');
    implOf(this).recordCorrected(a.value, b.value);
  }
  add(other: unknown) {
    check(other instanceof Histogram, 'other must be a Histogram');
    return implOf(this).add(implOf(other));
  }
  subtract(other: unknown) {
    check(other instanceof Histogram, 'other must be a Histogram');
    return implOf(this).subtract(implOf(other));
  }
}

/** A window over the last `chunks` chunks of records, each chunk its own histogram. */
export class SlidingWindowHistogram {
  readonly #options: Options;
  readonly #chunks: (NodeHistogram | null)[];
  // the generation each chunk holds, -1 for none (kNoGeneration)
  readonly #generations: number[];
  #spare: NodeHistogram | null;
  readonly #timeBased: boolean;
  // nanoseconds per chunk, or records per chunk
  readonly #rotateAt: number;
  #origin: number;
  #currentGeneration = 0;
  #recordsInCurrentChunk = 0;
  #hasCountRecords = false;

  // new SlidingWindowHistogram(lowest, highest, figures, chunks, timeBased, rotateAt)
  constructor(lowest: unknown, highest: unknown, figures: unknown, chunks: unknown, timeBased: unknown, rotateAt: unknown) {
    check(typeof figures === 'number' && figures >>> 0 === figures, 'figures must be a uint32');
    check(typeof chunks === 'number' && chunks >>> 0 === chunks, 'chunks must be a uint32');
    check(typeof timeBased === 'boolean', 'timeBased must be a boolean');
    check(typeof rotateAt === 'bigint', 'rotateAt must be a bigint');
    const lo = int64Arg(lowest);
    if (!lo.lossless) throw outOfRange('options.lowest is out of range');
    const hi = int64Arg(highest);
    if (!hi.lossless) throw outOfRange('options.highest is out of range');
    if (chunks === 0) throw outOfRange('options.chunks is out of range');
    if (rotateAt <= 0n || BigInt.asUintN(64, rotateAt) !== rotateAt) throw outOfRange('rotation interval is out of range');
    this.#options = { lowest: lo.value, highest: hi.value, figures };
    this.#spare = NodeHistogram.create(this.#options);
    if (!this.#spare) throw invalidOptions();
    this.#chunks = new Array(chunks).fill(null);
    this.#generations = new Array(chunks).fill(-1);
    this.#timeBased = timeBased;
    this.#rotateAt = Number(rotateAt);
    this.#origin = this.#now();
  }

  #now(): number {
    return Math.round(perfNow() * 1e6);
  }

  #currentTimeGeneration(): number {
    return Math.floor((this.#now() - this.#origin) / this.#rotateAt);
  }

  #getChunk(generation: number): NodeHistogram {
    const index = generation % this.#chunks.length;
    if (this.#generations[index] === generation) return this.#chunks[index]!;
    if (this.#chunks[index]) this.#chunks[index]!.reset();
    else if (this.#spare) {
      this.#chunks[index] = this.#spare;
      this.#spare = null;
    } else this.#chunks[index] = NodeHistogram.create(this.#options);
    this.#generations[index] = generation;
    return this.#chunks[index]!;
  }

  record(v: unknown) {
    const { value, lossless } = int64Arg(v);
    if (!lossless || value < 0) throw outOfRange();
    let generation: number;
    if (this.#timeBased) generation = this.#currentTimeGeneration();
    else if (this.#recordsInCurrentChunk === this.#rotateAt) generation = this.#currentGeneration + 1;
    else generation = this.#currentGeneration;
    this.#getChunk(generation).record(value);
    if (!this.#timeBased) {
      if (generation !== this.#currentGeneration) {
        this.#currentGeneration = generation;
        this.#recordsInCurrentChunk = 0;
      }
      this.#recordsInCurrentChunk++;
      this.#hasCountRecords = true;
    }
  }

  /** a histogram of the chunks still inside the window */
  snapshot() {
    const snapshot = NodeHistogram.create(this.#options)!;
    let current: number;
    if (this.#timeBased) current = this.#currentTimeGeneration();
    else {
      if (!this.#hasCountRecords) return Histogram.wrap(snapshot);
      current = this.#currentGeneration;
    }
    for (let i = 0; i < this.#chunks.length; i++) {
      const generation = this.#generations[i];
      if (generation === -1 || generation > current || current - generation >= this.#chunks.length) continue;
      snapshot.add(this.#chunks[i]!);
    }
    return Histogram.wrap(snapshot);
  }

  reset() {
    this.#generations.fill(-1);
    this.#origin = this.#now();
    this.#currentGeneration = 0;
    this.#recordsInCurrentChunk = 0;
    this.#hasCountRecords = false;
  }
}

/**
 * IntervalHistogram / IterationHistogram: a histogram fed while started (monitorEventLoopDelay).
 * The interval kind records the delay of an unref'd interval timer (RecordDelta). Node's iteration
 * kind records each loop iteration's latency from libuv's prepare/check hooks, which a Web Worker
 * does not have; here it samples on the same timer and records how late each tick came (the time
 * the loop was busy beyond the expected wait), at least 1ns.
 */
export class IntervalHistogram extends HistogramImpl {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  constructor(
    private readonly interval: number,
    private readonly perIteration: boolean,
    h: NodeHistogram,
  ) {
    super(h);
  }
  start(reset?: unknown) {
    if (this.timer !== null) return;
    const h = implOf(this);
    if (reset === true) h.reset();
    this.last = Math.round(perfNow() * 1e6);
    this.timer = nativeSetInterval(() => {
      if (!this.perIteration) {
        h.recordDelta();
        return;
      }
      const now = Math.round(perfNow() * 1e6);
      const latency = now - this.last - this.interval * 1e6;
      this.last = now;
      h.record(latency > 0 ? latency : 1);
    }, this.interval);
  }
  stop() {
    if (this.timer === null) return;
    nativeClearInterval(this.timer);
    this.timer = null;
  }
  close(cb?: unknown) {
    this.stop();
    if (typeof cb === 'function') macrotask(() => scope(cb as () => void, this));
  }
}

// createELDHistogram(resolution, samplePerIteration, lowest, highest, figures)
export function createELDHistogram(interval: unknown, samplePerIteration: unknown = false, lowest: unknown = 1000n, highest: unknown = INT64_MAX_BIG, figures: unknown = 3) {
  const ms = Math.trunc(Number(interval));
  check(ms > 0, 'interval must be greater than 0');
  check(typeof lowest === 'bigint' && typeof highest === 'bigint', 'lowest and highest must be bigints');
  check(typeof figures === 'number' && figures >>> 0 === figures, 'figures must be a uint32');
  const lo = int64Arg(lowest);
  const hi = int64Arg(highest);
  check(lo.lossless && hi.lossless, 'lowest and highest must fit an int64');
  const h = NodeHistogram.create({ lowest: lo.value, highest: hi.value, figures });
  // the options are validated in JS, but hdr_init() still rejects some combinations
  if (!h) throw invalidOptions();
  return new IntervalHistogram(ms, samplePerIteration === true, h);
}
