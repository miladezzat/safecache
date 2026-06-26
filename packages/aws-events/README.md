# @safecache/aws-events

AWS EventBridge-style `CacheEventBus` adapter for SafeCache.

```ts
import { awsEventBus } from "@safecache/aws-events";

const events = awsEventBus({
  client,
  eventBusName: "cache-events",
  source: "safecache",
  subscribe,
});
```
