import { describe, expect, test } from "vitest";
import { createMetricsCollector, metricNames, safeCacheMetricNames } from "./index";

describe("SafeCache metrics", () => {
  test("exports the required metric names", () => {
    expect(safeCacheMetricNames).toEqual([
      "cache_hits_total",
      "cache_misses_total",
      "cache_errors_total",
      "cache_invalidations_total",
      "cache_stale_served_total",
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

  test("renders Prometheus text", () => {
    const metrics = createMetricsCollector();
    metrics.increment("cache_hits_total", 2);

    expect(metrics.toPrometheus()).toContain("cache_hits_total 2");
  });
});
