# Dashboard

The SafeCache dashboard is a read-only operations UI for cache health and invalidation visibility.

```ts
import { createDashboard } from "@safecache/dashboard";

const dashboard = createDashboard({
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

The rendered dashboard includes hit rate, miss rate, hot keys, tags, invalidation events, stale
served, errors, lock contention, slow cache calls, provider health, and plugin health.

Mutation requests return `405` unless `readOnly` is explicitly disabled.
