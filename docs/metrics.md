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
cache_lock_wait_ms
cache_provider_latency_ms
```

## Prometheus output

```ts
app.get("/metrics", (_req, res) => {
  res.type("text/plain").send(metrics.toPrometheus());
});
```

The collector is intentionally small. It can be bridged into Prometheus, OpenTelemetry, StatsD, or
another metrics stack.

## Common mistakes

- Tracking hit rate without also tracking stale responses and errors.
- Ignoring provider errors because requests are still succeeding through fail-open.
- Not tagging lock contention by provider or operation in downstream metrics.
- Treating metrics as a replacement for logs when invalidation debugging needs event context.

## Related packages

- `@safecache/core`
- `@safecache/metrics`
- `@safecache/dashboard`
- `@safecache/cli`
