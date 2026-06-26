import type {
  Cache,
  CacheRuntimeEvent,
  CacheRuntimeEventHandler,
  CacheStats,
} from "@safecache/core";

export const metricNames = {
  cacheHitsTotal: "cache_hits_total",
  cacheMissesTotal: "cache_misses_total",
  cacheErrorsTotal: "cache_errors_total",
  cacheInvalidationsTotal: "cache_invalidations_total",
  cacheStaleServedTotal: "cache_stale_served_total",
  cacheLockWaitMs: "cache_lock_wait_ms",
  cacheProviderLatencyMs: "cache_provider_latency_ms",
} as const;

export const safeCacheMetricNames = [
  metricNames.cacheHitsTotal,
  metricNames.cacheMissesTotal,
  metricNames.cacheErrorsTotal,
  metricNames.cacheInvalidationsTotal,
  metricNames.cacheStaleServedTotal,
  metricNames.cacheLockWaitMs,
  metricNames.cacheProviderLatencyMs,
] as const;

export type SafeCacheMetricName = (typeof safeCacheMetricNames)[number];
export type CounterMetricName =
  | typeof metricNames.cacheHitsTotal
  | typeof metricNames.cacheMissesTotal
  | typeof metricNames.cacheErrorsTotal
  | typeof metricNames.cacheInvalidationsTotal
  | typeof metricNames.cacheStaleServedTotal;
export type HistogramMetricName =
  | typeof metricNames.cacheLockWaitMs
  | typeof metricNames.cacheProviderLatencyMs;

export interface CounterSnapshot {
  value: number;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}

export interface MetricsSnapshot {
  counters: Record<CounterMetricName, CounterSnapshot>;
  histograms: Record<HistogramMetricName, HistogramSnapshot>;
}

export interface MetricsCollector {
  increment(name: CounterMetricName, amount?: number): void;
  observe(name: HistogramMetricName, value: number, labels?: Record<string, string>): void;
  recordRuntimeEvent(event: CacheRuntimeEvent): void;
  recordCacheStats(stats: CacheStats): void;
  attach(cache: Cache): () => void;
  snapshot(): MetricsSnapshot;
  toPrometheus(): string;
}

const counterNames = [
  metricNames.cacheHitsTotal,
  metricNames.cacheMissesTotal,
  metricNames.cacheErrorsTotal,
  metricNames.cacheInvalidationsTotal,
  metricNames.cacheStaleServedTotal,
] as const;

const histogramNames = [metricNames.cacheLockWaitMs, metricNames.cacheProviderLatencyMs] as const;

export function createMetricsCollector(): MetricsCollector {
  const counters = createCounters();
  const histograms = createHistograms();

  return {
    increment(name, amount = 1) {
      counters[name].value += amount;
    },

    observe(name, value) {
      const histogram = histograms[name];
      histogram.count += 1;
      histogram.sum += value;
      histogram.min = histogram.min === null ? value : Math.min(histogram.min, value);
      histogram.max = histogram.max === null ? value : Math.max(histogram.max, value);
    },

    recordRuntimeEvent(event) {
      switch (event.type) {
        case "hit":
          counters.cache_hits_total.value += 1;
          break;
        case "miss":
          counters.cache_misses_total.value += 1;
          break;
        case "stale":
          counters.cache_stale_served_total.value += 1;
          break;
        case "invalidate":
          counters.cache_invalidations_total.value += 1;
          break;
        case "error":
          counters.cache_errors_total.value += 1;
          break;
        case "refresh":
          break;
      }
    },

    recordCacheStats(stats) {
      counters.cache_hits_total.value = stats.hits;
      counters.cache_misses_total.value = stats.misses;
      counters.cache_errors_total.value = stats.errors;
      counters.cache_invalidations_total.value = stats.invalidations;
      counters.cache_stale_served_total.value = stats.staleServed;
    },

    attach(cache) {
      const handler: CacheRuntimeEventHandler = (event) => {
        this.recordRuntimeEvent(event);
      };
      for (const eventName of ["hit", "miss", "stale", "invalidate", "error"] as const) {
        cache.on(eventName, handler);
      }
      return () => {
        for (const eventName of ["hit", "miss", "stale", "invalidate", "error"] as const) {
          cache.off(eventName, handler);
        }
      };
    },

    snapshot() {
      return {
        counters: cloneCounters(counters),
        histograms: cloneHistograms(histograms),
      };
    },

    toPrometheus() {
      const lines: string[] = [];
      for (const name of counterNames) {
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${counters[name].value}`);
      }
      for (const name of histogramNames) {
        lines.push(`# TYPE ${name} summary`);
        lines.push(`${name}_count ${histograms[name].count}`);
        lines.push(`${name}_sum ${histograms[name].sum}`);
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

function createCounters(): Record<CounterMetricName, CounterSnapshot> {
  return {
    cache_hits_total: { value: 0 },
    cache_misses_total: { value: 0 },
    cache_errors_total: { value: 0 },
    cache_invalidations_total: { value: 0 },
    cache_stale_served_total: { value: 0 },
  };
}

function createHistograms(): Record<HistogramMetricName, HistogramSnapshot> {
  return {
    cache_lock_wait_ms: { count: 0, sum: 0, min: null, max: null },
    cache_provider_latency_ms: { count: 0, sum: 0, min: null, max: null },
  };
}

function cloneCounters(
  counters: Record<CounterMetricName, CounterSnapshot>,
): Record<CounterMetricName, CounterSnapshot> {
  return {
    cache_hits_total: { ...counters.cache_hits_total },
    cache_misses_total: { ...counters.cache_misses_total },
    cache_errors_total: { ...counters.cache_errors_total },
    cache_invalidations_total: { ...counters.cache_invalidations_total },
    cache_stale_served_total: { ...counters.cache_stale_served_total },
  };
}

function cloneHistograms(
  histograms: Record<HistogramMetricName, HistogramSnapshot>,
): Record<HistogramMetricName, HistogramSnapshot> {
  return {
    cache_lock_wait_ms: { ...histograms.cache_lock_wait_ms },
    cache_provider_latency_ms: { ...histograms.cache_provider_latency_ms },
  };
}
