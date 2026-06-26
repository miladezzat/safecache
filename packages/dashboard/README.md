# @safecache/dashboard

Read-only SafeCache dashboard renderer.

```ts
import { createDashboard, createEmptyDashboardSnapshot } from "@safecache/dashboard";

const dashboard = createDashboard({
  snapshot: async () => createEmptyDashboardSnapshot(),
});
```
