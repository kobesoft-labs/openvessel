// internalBinding('performance').Histogram and createELDHistogram (histogram.cc, node_perf.cc) over
// a TypeScript port of HdrHistogram_c (deps/histogram): the same buckets, so min/max/mean/stddev
// and percentiles match Node's for the same recorded values.
//
// Values are JS numbers: exact up to 2^53, which covers createHistogram()'s range (highest is at
// most Number.MAX_SAFE_INTEGER). INT64_MAX (the empty histogram's min) is kept as a sentinel.

import { perfNow } from '../../node/native.ts';

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

function outOfRange(): never {
  const e = new RangeError('value is out of range') as RangeError & { code: string };
  e.code = 'ERR_OUT_OF_RANGE';
  throw e;
}

/** struct hdr_histogram */
export class Hdr {
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

  constructor(
    lowest: number,
    readonly highest: number,
    figures: number,
  ) {
    // hdr_calculate_bucket_config
    if (lowest < 1 || figures < 1 || figures > 5 || lowest * 2 > highest) throw new RangeError('Invalid histogram configuration');
    const largestValueWithSingleUnitResolution = 2 * 10 ** figures;
    const subBucketCountMagnitude = Math.ceil(Math.log(largestValueWithSingleUnitResolution) / Math.log(2));
    this.subBucketHalfCountMagnitude = (subBucketCountMagnitude > 1 ? subBucketCountMagnitude : 1) - 1;
    this.unitMagnitude = Math.trunc(Math.log(lowest) / Math.log(2));
    this.subBucketCount = 2 ** (this.subBucketHalfCountMagnitude + 1);
    this.subBucketHalfCount = this.subBucketCount / 2;
    this.subBucketMask = (this.subBucketCount - 1) * 2 ** this.unitMagnitude;
    if (this.unitMagnitude + this.subBucketHalfCountMagnitude > 61) throw new RangeError('Invalid histogram configuration');
    // buckets_needed_to_cover_value
    let smallestUntrackable = this.subBucketCount * 2 ** this.unitMagnitude;
    let buckets = 1;
    while (smallestUntrackable <= highest) {
      if (smallestUntrackable > 2 ** 62) {
        buckets++;
        break;
      }
      smallestUntrackable *= 2;
      buckets++;
    }
    this.bucketCount = buckets;
    this.countsLen = (this.bucketCount + 1) * (this.subBucketCount / 2);
    this.counts = new Float64Array(this.countsLen);
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
  valueFromIndex(bucketIndex: number, subBucketIndex: number): number {
    return subBucketIndex * 2 ** (bucketIndex + this.unitMagnitude);
  }
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
    return this.lowestEquivalentValue(value) + this.sizeOfEquivalentValueRange(value) - 1;
  }
  medianEquivalentValue(value: number): number {
    return this.lowestEquivalentValue(value) + Math.floor(this.sizeOfEquivalentValueRange(value) / 2);
  }

  recordValues(value: number, count: number): boolean {
    if (value < 0 || value > this.highest) return false;
    const b = this.bucketIndex(value);
    const idx = this.countsIndex(b, this.subBucketIndex(value, b));
    if (idx < 0 || idx >= this.countsLen) return false;
    this.counts[idx] += count;
    this.totalCount += count;
    if (value < this.minValue && value !== 0) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;
    return true;
  }

  reset() {
    this.counts.fill(0);
    this.totalCount = 0;
    this.minValue = INT64_MAX;
    this.maxValue = 0;
  }

  /** hdr_min; INT64_MAX when empty */
  min(): number {
    if (this.counts[0] > 0) return 0;
    if (this.minValue === INT64_MAX) return INT64_MAX;
    return this.lowestEquivalentValue(this.minValue);
  }
  max(): number {
    return this.maxValue === 0 ? 0 : this.highestEquivalentValue(this.maxValue);
  }
  mean(): number {
    let total = 0;
    for (let i = 0; i < this.countsLen; i++) if (this.counts[i]) total += this.counts[i] * this.medianEquivalentValue(this.valueAtIndex(i));
    return total / this.totalCount;
  }
  stddev(): number {
    const mean = this.mean();
    let geometricDevTotal = 0;
    for (let i = 0; i < this.countsLen; i++) {
      if (!this.counts[i]) continue;
      const dev = this.medianEquivalentValue(this.valueAtIndex(i)) - mean;
      geometricDevTotal += dev * dev * this.counts[i];
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
      countToIdx += this.counts[i];
      if (countToIdx >= countAtPercentile) {
        valueFromIdx = this.valueAtIndex(i);
        break;
      }
    }
    return percentile === 0 ? this.lowestEquivalentValue(valueFromIdx) : this.highestEquivalentValue(valueFromIdx);
  }
  /** hdr_iter_percentile_init(…, 1) walked to the end, as Histogram::Percentiles does: (percentile, iter.value) */
  percentiles(fn: (percentile: number, value: number) => void) {
    const total = this.totalCount;
    let countsIndex = -1;
    let cumulative = 0;
    let count = 0;
    let value = 0;
    let seenLastValue = false;
    let percentileToIterateTo = 0;
    let percentile = 0;
    const moveNext = () => {
      if (cumulative >= total) return false; // has_next
      countsIndex++;
      if (countsIndex >= this.countsLen) return false;
      count = this.counts[countsIndex];
      cumulative += count;
      value = this.valueAtIndex(countsIndex);
      return true;
    };
    for (;;) {
      if (!(cumulative < total)) {
        if (seenLastValue) return;
        seenLastValue = true;
        fn(100, value);
        continue;
      }
      if (countsIndex === -1 && !moveNext()) return;
      let emitted = false;
      do {
        const currentPercentile = (100 * cumulative) / total;
        if (count !== 0 && percentileToIterateTo <= currentPercentile) {
          percentile = percentileToIterateTo;
          const temp = Math.trunc(Math.log(100 / (100 - percentileToIterateTo)) / Math.log(2)) + 1;
          const halfDistance = Math.trunc(2 ** temp);
          percentileToIterateTo += 100 / halfDistance;
          fn(percentile, value);
          emitted = true;
          break;
        }
      } while (moveNext());
      if (!emitted) {
        // percentile_iter_next returns true after running out of buckets, with the previous percentile
        fn(percentile, value);
      }
    }
  }
  /** hdr_add: re-records other's values (by bucket); returns how many were dropped */
  add(other: Hdr): number {
    let dropped = 0;
    for (let i = 0; i < other.countsLen; i++) {
      const c = other.counts[i];
      if (c && !this.recordValues(other.valueAtIndex(i), c)) dropped += c;
    }
    return dropped;
  }
}

const toInt64 = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Math.trunc(Number(v)));

/** node::Histogram plus HistogramImpl's JS methods */
export class Histogram {
  hdr: Hdr;
  private count_ = 0;
  private exceeds_ = 0;
  private prev_ = 0;

  constructor(lowest: unknown = 1, highest: unknown = INT64_MAX, figures: unknown = 3) {
    this.hdr = new Hdr(toInt64(lowest), toInt64(highest), Number(figures) >>> 0);
  }

  private recordOne(value: number): boolean {
    const ok = this.hdr.recordValues(value, 1);
    if (ok) this.count_++;
    else this.exceeds_++;
    return ok;
  }

  count() {
    return this.count_;
  }
  countBigInt() {
    return BigInt(this.count_);
  }
  exceeds() {
    return this.exceeds_;
  }
  exceedsBigInt() {
    return BigInt(this.exceeds_);
  }
  min() {
    return this.hdr.min();
  }
  minBigInt() {
    const m = this.hdr.min();
    return m === INT64_MAX ? INT64_MAX_BIG : BigInt(m);
  }
  max() {
    return this.hdr.max();
  }
  maxBigInt() {
    return BigInt(this.hdr.max());
  }
  mean() {
    return this.hdr.mean();
  }
  stddev() {
    return this.hdr.stddev();
  }
  percentile(p: number) {
    return this.hdr.valueAtPercentile(Number(p));
  }
  percentileBigInt(p: number) {
    return BigInt(this.hdr.valueAtPercentile(Number(p)));
  }
  percentiles(map: Map<number, number>) {
    this.hdr.percentiles((k, v) => map.set(k, v));
  }
  percentilesBigInt(map: Map<number, bigint>) {
    this.hdr.percentiles((k, v) => map.set(k, BigInt(v)));
  }
  reset() {
    this.hdr.reset();
    this.prev_ = 0;
    this.count_ = 0;
    this.exceeds_ = 0;
  }
  record(v: unknown) {
    let value: number;
    if (typeof v === 'bigint') {
      if (BigInt.asIntN(64, v) !== v || v < 1n) outOfRange();
      value = Number(v);
    } else {
      value = Math.trunc(Number(v));
      if (!(value >= 1)) outOfRange();
    }
    this.recordOne(value);
  }
  /** Records the nanoseconds since the previous call (nothing on the first call); returns them. */
  recordDelta() {
    const time = Math.round(perfNow() * 1e6);
    let delta = 0;
    if (this.prev_ > 0) {
      delta = Math.max(0, time - this.prev_);
      this.recordOne(delta);
    }
    this.prev_ = time;
    return delta;
  }
  add(other: Histogram) {
    if (!(other instanceof Histogram)) throw new TypeError('other must be a Histogram');
    this.count_ += other.count_;
    this.exceeds_ += other.exceeds_;
    if (other.prev_ > this.prev_) this.prev_ = other.prev_;
    return this.hdr.add(other.hdr);
  }
}

/** IntervalHistogram: a Histogram fed by an unref'd interval timer (monitorEventLoopDelay). */
export class IntervalHistogram extends Histogram {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly interval: number,
    private readonly onInterval: (h: Histogram) => void,
    lowest = 1,
  ) {
    super(lowest, INT64_MAX, 3);
  }
  start(reset?: unknown) {
    if (this.timer !== null) return;
    if (reset === true) this.reset();
    this.timer = nativeSetInterval(() => this.onInterval(this), this.interval);
  }
  stop() {
    if (this.timer === null) return;
    nativeClearInterval(this.timer);
    this.timer = null;
  }
}

export function createELDHistogram(interval: unknown) {
  const ms = Math.trunc(Number(interval));
  if (!(ms > 0)) throw new RangeError('interval must be greater than 0');
  return new IntervalHistogram(ms, (h) => h.recordDelta(), 1000);
}
