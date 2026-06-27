# @safecache/memory

In-memory SafeCache provider with TTL, max-entry eviction, health, and tag index support.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/memory @safecache/core
```

## Usage

```ts
import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

const cache = createCache({
  namespace: "app",
  provider: memoryProvider({ ttl: "5m", maxEntries: 10_000 }),
  defaultTtl: "5m",
});
```

## API

- `memoryProvider`
- `MemoryProvider`
- `MemoryProviderOptions`

## When To Use This

Use this package for local development, tests, single-process apps, or the fast first layer in a multi-layer cache.

## Production Notes

The memory provider is process-local. Use it alone for single-process apps and tests, or as the first layer in front of Redis for multi-instance deployments.

## Related Packages

- `@safecache/core`
- `@safecache/testing`
- `@safecache/redis`

## Documentation

- [Getting Started](../../docs/getting-started.md)
- [Core Concepts](../../docs/core-concepts.md)
- [SafeCache README](../../README.md)
