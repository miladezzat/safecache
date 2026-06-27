# Stampede Prevention

A cache stampede happens when many requests miss the same key and all hit the source of truth at
once. SafeCache reduces this with local single-flight and optional distributed locks.

## Local single-flight

Same-process stampede prevention is enabled by default:

```ts
const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  safety: {
    preventStampede: true,
  },
});
```

Concurrent misses for the same scoped key share one fetcher call.

## Distributed locks

For multiple app instances, add a distributed lock:

```ts
import { redisLock } from "@safecache/locks";

const cache = createCache({
  namespace: "app",
  provider,
  distributed: {
    lock: redisLock(redis),
  },
  defaultTtl: "5m",
});
```

The Redis lock adapter uses `SET NX PX` and token-safe release when the client supports Lua `eval`.

## Common mistakes

- Assuming local single-flight protects multiple Node.js processes.
- Setting lock TTL shorter than the fetcher’s worst-case runtime.
- Treating lock contention as an error instead of an operational signal.
- Not combining stampede prevention with reasonable TTLs.

## Related packages

- `@safecache/core`
- `@safecache/locks`
- `@safecache/redis`
- `@safecache/metrics`
