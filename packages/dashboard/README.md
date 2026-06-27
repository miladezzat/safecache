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

## Security

The dashboard ships with **no authentication** and exposes operational data
(key names, tags, errors, health). Treat it as internal:

- **Bind to localhost / an internal network by default.** Never expose the
  dashboard endpoint on a public interface without auth in front of it.
- **Gate requests with the `authorize` hook.** When provided, it runs on every
  request before any snapshot is read or HTML rendered. Return `false` (or
  reject) to deny — the handler responds `401` (denied) or `403` (the hook
  threw) without leaking data.

```ts
const dashboard = createDashboard({
  snapshot: async () => snapshotFromMetrics(),
  authorize: (request) => isInternalRequest(request), // boolean | Promise<boolean>
  onError: (error) => log.warn({ err: error }, "dashboard cache error"),
});
```

## Cache safety

The dashboard upholds the SafeCache guarantee: a cache/stats failure **never
throws into the host HTTP server**. Any error raised while producing the
snapshot (or evaluating `authorize`) is caught, routed to the optional
`onError` notifier, and rendered as a safe `503` response — the host keeps
serving. `onError` defaults to a silent no-op so library code never writes to
your logs uninvited.

## API

- `createDashboard`
- `createEmptyDashboardSnapshot`
- `renderDashboard`

## When To Use This

Use this package when you want an embeddable read-only dashboard endpoint for SafeCache operational state.

## Production Notes

Keep the dashboard internal. It can expose key names, tags, errors, and
operational metadata. Bind it to localhost by default and gate every request
with the `authorize` hook (see [Security](#security)) before exposing it on any
shared network.

## Related Packages

- `@safecache/core`
- `@safecache/metrics`
- `@safecache/cli`

## Documentation

- [Dashboard](../../docs/dashboard.md)
- [Metrics](../../docs/metrics.md)
- [SafeCache README](../../README.md)
