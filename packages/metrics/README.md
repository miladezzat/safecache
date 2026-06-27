# @safecache/metrics

SafeCache metrics collector with counters, histograms, snapshots, and Prometheus output.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/metrics @safecache/core
```

## Usage

```ts
import { createMetricsCollector } from "@safecache/metrics";

const metrics = createMetricsCollector();
const detach = metrics.attach(cache);

console.log(metrics.toPrometheus());
detach();
```

## API

- `createMetricsCollector`
- `metricNames`
- `safeCacheMetricNames`

## When To Use This

Use this package to turn SafeCache runtime events and stats into operational metrics.

## Related Packages

- `@safecache/core`
- `@safecache/dashboard`
- `@safecache/cli`

## Documentation

- [Metrics](../../docs/metrics.md)
- [Dashboard](../../docs/dashboard.md)
- [SafeCache README](../../README.md)
