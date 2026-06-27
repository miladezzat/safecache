import type {
  Cache,
  CacheRuntimeEvent,
  CacheRuntimeEventHandler,
  CacheRuntimeEventName,
} from "@safecache/core";
import { describe, expect, test } from "vitest";
import { createMetricsCollector, metricNames, safeCacheMetricNames } from "./index";

/**
 * Minimal fake cache that only implements the runtime-event surface used by
 * `attach()`. It lets tests drive `provider_latency`, `lock_wait`, and other
 * events without spinning up a real cache + providers.
 */
function createFakeCache(): Cache & { fire(event: CacheRuntimeEvent): void } {
  const handlers = new Map<CacheRuntimeEventName, Set<CacheRuntimeEventHandler>>();
  const notImplemented = () => {
    throw new Error("not implemented in fake cache");
  };

  return {
    query: notImplemented,
    wrap: notImplemented,
    mutate: notImplemented,
    invalidate: notImplemented,
    invalidateByTag: notImplemented,
    use: notImplemented,
    shutdown: notImplemented,
    stats: notImplemented,
    on(name, handler) {
      const set = handlers.get(name) ?? new Set<CacheRuntimeEventHandler>();
      set.add(handler);
      handlers.set(name, set);
    },
    off(name, handler) {
      handlers.get(name)?.delete(handler);
    },
    fire(event) {
      for (const handler of handlers.get(event.type) ?? []) {
        handler(event);
      }
    },
  };
}

describe("SafeCache metrics", () => {
  test("exports the required metric names", () => {
    expect(safeCacheMetricNames).toEqual([
      "cache_hits_total",
      "cache_misses_total",
      "cache_errors_total",
      "cache_invalidations_total",
      "cache_stale_served_total",
      "cache_refreshes_total",
      "cache_lock_wait_ms",
      "cache_provider_latency_ms",
    ]);
    expect(metricNames.cacheHitsTotal).toBe("cache_hits_total");
  });

  test("records runtime events and observations", () => {
    const metrics = createMetricsCollector();

    metrics.recordRuntimeEvent({ type: "hit", key: "user:1" });
    metrics.recordRuntimeEvent({ type: "miss", key: "user:2" });
    metrics.recordRuntimeEvent({ type: "stale", key: "user:3" });
    metrics.recordRuntimeEvent({ type: "invalidate", tag: "users" });
    metrics.recordRuntimeEvent({
      type: "error",
      operation: "get",
      error: new Error("redis"),
    });
    metrics.observe("cache_lock_wait_ms", 12, { provider: "redis" });
    metrics.observe("cache_provider_latency_ms", 3, { provider: "memory" });

    const snapshot = metrics.snapshot();
    expect(snapshot.counters.cache_hits_total.value).toBe(1);
    expect(snapshot.counters.cache_misses_total.value).toBe(1);
    expect(snapshot.counters.cache_stale_served_total.value).toBe(1);
    expect(snapshot.counters.cache_invalidations_total.value).toBe(1);
    expect(snapshot.counters.cache_errors_total.value).toBe(1);
    expect(snapshot.histograms.cache_lock_wait_ms.count).toBe(1);
    expect(snapshot.histograms.cache_provider_latency_ms.sum).toBe(3);
  });

  test("counts refresh runtime events", () => {
    const metrics = createMetricsCollector();

    metrics.recordRuntimeEvent({ type: "refresh", key: "user:1" });
    metrics.recordRuntimeEvent({ type: "refresh", key: "user:2" });

    expect(metrics.snapshot().counters.cache_refreshes_total.value).toBe(2);
  });

  test("populates latency/lock-wait histograms from runtime events", () => {
    const metrics = createMetricsCollector();

    metrics.recordRuntimeEvent({
      type: "provider_latency",
      layer: "redis",
      op: "get",
      durationMs: 8,
    });
    metrics.recordRuntimeEvent({
      type: "provider_latency",
      layer: "redis",
      op: "set",
      durationMs: 4,
    });
    metrics.recordRuntimeEvent({ type: "lock_wait", key: "user:1", durationMs: 15 });

    const snapshot = metrics.snapshot();
    expect(snapshot.histograms.cache_provider_latency_ms.count).toBe(2);
    expect(snapshot.histograms.cache_provider_latency_ms.sum).toBe(12);
    expect(snapshot.histograms.cache_lock_wait_ms.count).toBe(1);
    expect(snapshot.histograms.cache_lock_wait_ms.sum).toBe(15);
  });

  test("populates refresh counter and histograms from attached cache events", () => {
    const metrics = createMetricsCollector();
    const cache = createFakeCache();
    const detach = metrics.attach(cache);

    cache.fire({ type: "refresh", key: "user:1" });
    cache.fire({ type: "provider_latency", layer: "memory", op: "get", durationMs: 2 });
    cache.fire({ type: "lock_wait", key: "user:1", durationMs: 30 });

    let snapshot = metrics.snapshot();
    expect(snapshot.counters.cache_refreshes_total.value).toBe(1);
    expect(snapshot.histograms.cache_provider_latency_ms.count).toBe(1);
    expect(snapshot.histograms.cache_provider_latency_ms.sum).toBe(2);
    expect(snapshot.histograms.cache_lock_wait_ms.count).toBe(1);
    expect(snapshot.histograms.cache_lock_wait_ms.sum).toBe(30);

    detach();
    cache.fire({ type: "lock_wait", key: "user:2", durationMs: 99 });
    snapshot = metrics.snapshot();
    expect(snapshot.histograms.cache_lock_wait_ms.count).toBe(1);
  });

  test("includes the refresh counter in Prometheus output", () => {
    const metrics = createMetricsCollector();
    metrics.recordRuntimeEvent({ type: "refresh", key: "user:1" });

    const output = metrics.toPrometheus();
    expect(output).toContain("# TYPE cache_refreshes_total counter");
    expect(output).toContain("cache_refreshes_total 1");
  });

  test("renders Prometheus text", () => {
    const metrics = createMetricsCollector();
    metrics.increment("cache_hits_total", 2);

    expect(metrics.toPrometheus()).toContain("cache_hits_total 2");
  });
});
