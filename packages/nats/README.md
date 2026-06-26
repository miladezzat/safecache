# @safecache/nats

NATS `CacheEventBus` adapter for SafeCache.

```ts
import { natsEventBus } from "@safecache/nats";

const events = natsEventBus({ client, subject: "cache.events" });
```
