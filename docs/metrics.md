# Metrics

SafeCache metrics expose cache behavior as counters and histograms. Use them to understand hit
rate, stale serving, invalidation volume, provider errors, lock contention, and provider latency.

## Install

```bash
pnpm add @safecache/metrics @safecache/core
```

## Attach a collector

```ts
import { createMetricsCollector } from "@safecache/metrics";

const metrics = createMetricsCollector();
const detach = metrics.attach(cache);

console.log(metrics.snapshot());
console.log(metrics.toPrometheus());

detach();
```

## Metric names

```txt
cache_hits_total
cache_misses_total
cache_errors_total
cache_invalidations_total
cache_stale_served_total
cache_refreshes_total
cache_lock_wait_ms
cache_provider_latency_ms
```

Counters (`*_total`) are emitted as Prometheus counters; `cache_lock_wait_ms` and
`cache_provider_latency_ms` are emitted as Prometheus summaries (a `_count` and `_sum` line each).

## Histograms are populated

`cache_lock_wait_ms` and `cache_provider_latency_ms` are now populated automatically when you
`attach()` the collector. Core emits two runtime events that the collector observes into these
histograms:

- `provider_latency` — emitted around every provider `get`/`set`/`delete`, carrying `durationMs`,
  the `layer` name, and the `op`. Observed into `cache_provider_latency_ms`.
- `lock_wait` — emitted when a distributed lock is acquired for a single-flight miss, carrying the
  time spent acquiring (`durationMs`) and the `key`. Observed into `cache_lock_wait_ms`.

No extra wiring is required: `metrics.attach(cache)` subscribes to `hit`, `miss`, `stale`,
`refresh`, `invalidate`, `error`, `provider_latency`, and `lock_wait`.

## cache_refreshes_total

`cache_refreshes_total` counts background refreshes (stale-while-revalidate and refresh-ahead
revalidations). It is incremented from the core `refresh` runtime event and is also reconciled from
`cache.stats().refreshes` via `recordCacheStats`. Use it together with `cache_stale_served_total` to
see how often stale values are served versus how often the cache revalidates in the background.

## Prometheus output

```ts
app.get("/metrics", (_req, res) => {
  res.type("text/plain").send(metrics.toPrometheus());
});
```

The collector is intentionally small. It can be bridged into Prometheus, OpenTelemetry, StatsD, or
another metrics stack.

## Common mistakes

- Tracking hit rate without also tracking stale responses, refreshes, and errors.
- Ignoring `cache_errors_total` because requests are still succeeding through fail-open — a rising
  error count with a stable hit rate means the cache is degraded but invisibly absorbing failures.
- Watching `cache_provider_latency_ms` without breaking it down by `layer`/`op` in a downstream
  metrics backend (the in-process collector aggregates across all layers and operations).
- Treating metrics as a replacement for logs when invalidation debugging needs event context; wire
  the `error` runtime event (or `onError`) to a logger as well.

## Related packages

- `@safecache/core`
- `@safecache/metrics`
- `@safecache/dashboard`
- `@safecache/cli`
