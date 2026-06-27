# Dashboard

The SafeCache dashboard package renders a read-only operations view for cache health and
invalidation visibility.

## Install

```bash
pnpm add @safecache/dashboard
```

## Create a dashboard

```ts
import { createDashboard } from "@safecache/dashboard";

const dashboard = createDashboard({
  readOnly: true,
  snapshot: async () => ({
    hitRate: 0.9,
    missRate: 0.1,
    hotKeys: [],
    tags: [],
    invalidationEvents: [],
    staleServed: 0,
    errors: [],
    lockContention: [],
    slowCacheCalls: [],
    providerHealth: [],
    pluginHealth: [],
  }),
});
```

## Serve it

```ts
app.get("/cache", async (_req, res) => {
  const response = await dashboard.handle({ method: "GET", path: "/" });
  res.status(response.status).set(response.headers).send(response.body);
});

app.get("/cache/api/snapshot", async (_req, res) => {
  const response = await dashboard.handle({ method: "GET", path: "/api/snapshot" });
  res.status(response.status).set(response.headers).send(response.body);
});
```

## What it shows

- hit rate and miss rate
- hot keys
- tag counts
- invalidation events
- stale served count
- cache errors
- lock contention
- slow cache calls
- provider health
- plugin health

## Production notes

The dashboard is read-only by default. Keep it behind internal authentication and network controls.
Do not expose operational cache metadata publicly.

## Related packages

- `@safecache/dashboard`
- `@safecache/metrics`
- `@safecache/cli`
