# @safecache/memcached

Memcached provider for SafeCache.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/memcached @safecache/core
```

## Usage

```ts
import { memcachedProvider } from "@safecache/memcached";

const cache = createCache({
  namespace: "app",
  provider: memcachedProvider(memcachedClient),
  defaultTtl: "5m",
});
```

## API

- `memcachedProvider`
- `MemcachedClient`
- `MemcachedProvider`

## When To Use This

Use this package when Memcached is the backing provider and tag metadata can remain local to the process.

## Related Packages

- `@safecache/core`
- `@safecache/memory`
- `@safecache/redis`

## Documentation

- [Core Concepts](../../docs/core-concepts.md)
- [SafeCache README](../../README.md)
