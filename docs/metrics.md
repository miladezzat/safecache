# Metrics

SafeCache metrics expose hits, misses, errors, invalidations, stale responses, lock waits, and
provider latency.

```ts
import { createMetricsCollector } from "@safecache/metrics";

const metrics = createMetricsCollector();
const detach = metrics.attach(cache);

metrics.observe("cache_provider_latency_ms", 3, { provider: "redis" });
console.log(metrics.toPrometheus());

detach();
```

Exported metric names:

```txt
cache_hits_total
cache_misses_total
cache_errors_total
cache_invalidations_total
cache_stale_served_total
cache_lock_wait_ms
cache_provider_latency_ms
```
