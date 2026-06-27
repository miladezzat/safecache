# @safecache/core

Core SafeCache engine, cache-aside API, contracts, events, and safety behavior.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/core @safecache/memory
```

## Usage

```ts
import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

const cache = createCache({
  namespace: "app",
  provider: memoryProvider(),
  defaultTtl: "5m",
});

const user = await cache.query({
  key: "user:" + id,
  tags: ["user:" + id, "users"],
  fetcher: () => userRepo.findById(id),
});
```

## API

- `createCache`
- `Cache`
- `CacheProvider`
- `CacheTagIndex`
- `CacheSerializer`
- `CacheLock`
- `CacheEventBus`
- `CachePlugin`
- `CacheEntry`
- `CacheEvent`
- `DurationInput`

## When To Use This

Use this package in every SafeCache setup. It owns query, wrap, mutate, invalidation, stats, plugins, and provider contracts.

## Production Notes

Keep cache construction at application composition boundaries. Use explicit tags on every cached read and prefer `mutate()` for write paths so invalidation happens after successful source-of-truth changes.

## Related Packages

- `@safecache/memory`
- `@safecache/redis`
- `@safecache/testing`
- `@safecache/metrics`

## Documentation

- [Getting Started](../../docs/getting-started.md)
- [Core Concepts](../../docs/core-concepts.md)
- [Safety Model](../../docs/safety-model.md)
- [Cache Aside Strategy](../../docs/cache-aside-strategy.md)
- [SafeCache README](../../README.md)
