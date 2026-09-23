/**
 * Metrics.
 *
 * The audit asked for p50/p95/p99 per endpoint. The naive way — keep every
 * sample and sort on scrape — costs memory proportional to traffic, which is
 * the wrong shape for a laptop under load: the monitoring becomes heaviest
 * exactly when the machine is busiest.
 *
 * So latency goes into fixed **bucketed histograms**. Memory is proportional
 * to the number of routes, not the number of requests, and quantiles are
 * interpolated from bucket boundaries. That interpolation is approximate, and
 * the approximation is worth naming: a p99 read from a histogram whose top
 * bucket is `+Inf` tells you "above 5 seconds" and not how far above. For
 * alerting that is enough; for chasing one pathological request it is not,
 * which is what the query log and EXPLAIN endpoint are for.
 *
 * Buckets are Prometheus-compatible so the same numbers serve the dashboard
 * and the scrape endpoint without two sources of truth.
 */

/** Seconds. Chosen around the latencies that actually matter here: a local
 *  query is single-digit milliseconds, anything past a second is a problem. */
const BUCKETS_MS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export interface HistogramSnapshot {
  count: number;
  sum: number;
  buckets: { le: number; count: number }[];
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

class Histogram {
  private counts = new Array<number>(BUCKETS_MS.length + 1).fill(0);
  private sum = 0;
  private total = 0;
  private maximum = 0;

  observe(valueMs: number): void {
    this.sum += valueMs;
    this.total += 1;
    if (valueMs > this.maximum) this.maximum = valueMs;

    let index = BUCKETS_MS.findIndex((bound) => valueMs <= bound);
    if (index === -1) index = BUCKETS_MS.length; // +Inf
    this.counts[index] = (this.counts[index] ?? 0) + 1;
  }

  /**
   * Linear interpolation within the bucket the quantile falls in — the same
   * method `histogram_quantile` uses, so the dashboard and Prometheus agree
   * rather than disagreeing by a few percent for reasons nobody can explain.
   */
  private quantile(q: number): number {
    if (this.total === 0) return 0;
    const target = q * this.total;
    let cumulative = 0;

    for (let i = 0; i < this.counts.length; i += 1) {
      const bucketCount = this.counts[i] ?? 0;
      if (cumulative + bucketCount >= target) {
        const lower = i === 0 ? 0 : BUCKETS_MS[i - 1]!;
        const upper = i === BUCKETS_MS.length ? this.maximum || lower : BUCKETS_MS[i]!;
        if (bucketCount === 0) return upper;
        const within = (target - cumulative) / bucketCount;
        return Number((lower + (upper - lower) * within).toFixed(2));
      }
      cumulative += bucketCount;
    }
    return this.maximum;
  }

  snapshot(): HistogramSnapshot {
    let cumulative = 0;
    const buckets = BUCKETS_MS.map((bound, i) => {
      cumulative += this.counts[i] ?? 0;
      return { le: bound, count: cumulative };
    });
    buckets.push({ le: Number.POSITIVE_INFINITY, count: this.total });

    return {
      count: this.total,
      sum: Number(this.sum.toFixed(2)),
      buckets,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      max: Number(this.maximum.toFixed(2)),
    };
  }

  reset(): void {
    this.counts.fill(0);
    this.sum = 0;
    this.total = 0;
    this.maximum = 0;
  }
}

type LabelSet = Record<string, string>;

function labelKey(name: string, labels: LabelSet): string {
  const parts = Object.keys(labels).sort().map((key) => `${key}="${labels[key]}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

class Registry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, Histogram>();
  private labelsFor = new Map<string, { name: string; labels: LabelSet }>();

  increment(name: string, labels: LabelSet = {}, by = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    this.labelsFor.set(key, { name, labels });
  }

  setGauge(name: string, value: number, labels: LabelSet = {}): void {
    const key = labelKey(name, labels);
    this.gauges.set(key, value);
    this.labelsFor.set(key, { name, labels });
  }

  observe(name: string, valueMs: number, labels: LabelSet = {}): void {
    const key = labelKey(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      // Cardinality guard. An unbounded label set — a raw URL with ids in it,
      // say — turns this map into a memory leak that looks like a slow
      // resource exhaustion bug. Routes are normalised before they get here,
      // but this is the backstop for when one slips through.
      if (this.histograms.size >= 500) return;
      histogram = new Histogram();
      this.histograms.set(key, histogram);
      this.labelsFor.set(key, { name, labels });
    }
    histogram.observe(valueMs);
  }

  histogramSnapshots(): { name: string; labels: LabelSet; snapshot: HistogramSnapshot }[] {
    return [...this.histograms.entries()].map(([key, histogram]) => ({
      name: this.labelsFor.get(key)?.name ?? key,
      labels: this.labelsFor.get(key)?.labels ?? {},
      snapshot: histogram.snapshot(),
    }));
  }

  /** Prometheus text exposition for everything held here. */
  render(): string {
    const lines: string[] = [];

    const counterNames = new Set([...this.counters.keys()].map((key) => this.labelsFor.get(key)?.name ?? key));
    for (const name of counterNames) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of this.counters) {
        if ((this.labelsFor.get(key)?.name ?? key) === name) lines.push(`${key} ${value}`);
      }
    }

    const gaugeNames = new Set([...this.gauges.keys()].map((key) => this.labelsFor.get(key)?.name ?? key));
    for (const name of gaugeNames) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, value] of this.gauges) {
        if ((this.labelsFor.get(key)?.name ?? key) === name) lines.push(`${key} ${value}`);
      }
    }

    for (const { name, labels, snapshot } of this.histogramSnapshots()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const bucket of snapshot.buckets) {
        const le = bucket.le === Number.POSITIVE_INFINITY ? '+Inf' : String(bucket.le / 1000);
        lines.push(`${labelKey(`${name}_bucket`, { ...labels, le })} ${bucket.count}`);
      }
      lines.push(`${labelKey(`${name}_sum`, labels)} ${(snapshot.sum / 1000).toFixed(4)}`);
      lines.push(`${labelKey(`${name}_count`, labels)} ${snapshot.count}`);
    }

    return lines.join('\n');
  }

  resetHistograms(): void {
    for (const histogram of this.histograms.values()) histogram.reset();
  }
}

export const metrics = new Registry();

/**
 * Normalise a route for use as a label.
 *
 * Fastify gives the route pattern (`/projects/:ref/sql`) rather than the
 * resolved URL, which is exactly what is wanted — labelling by resolved URL
 * would create one time series per project and blow up cardinality within a
 * day.
 */
export function normaliseRoute(url: string, pattern?: string): string {
  if (pattern) return pattern;
  return url
    .split('?')[0]!
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}
