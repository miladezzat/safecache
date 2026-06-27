# @safecache/dashboard

Read-only dashboard primitives for SafeCache metrics, health, errors, and hot keys.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/dashboard
```

## Usage

```ts
import { createDashboard } from "@safecache/dashboard";

const dashboard = createDashboard({
  readOnly: true,
  snapshot: async () => snapshotFromMetrics(),
});

const response = await dashboard.handle({ method: "GET", path: "/api/snapshot" });
```

## API

- `createDashboard`
- `createEmptyDashboardSnapshot`
- `renderDashboard`

## When To Use This

Use this package when you want an embeddable read-only dashboard endpoint for SafeCache operational state.

## Related Packages

- `@safecache/core`
- `@safecache/metrics`
- `@safecache/cli`

## Documentation

- [Dashboard](../../docs/dashboard.md)
- [Metrics](../../docs/metrics.md)
- [SafeCache README](../../README.md)
