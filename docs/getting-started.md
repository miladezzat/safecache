# Getting Started

SafeCache gives Node.js applications a cache-aside API with safe defaults. The database remains the
source of truth; SafeCache stores derived values and invalidates them after successful writes.

## Install

```bash
pnpm add @safecache/core @safecache/memory
```

Use Node.js 24 or newer.

## Create a cache

```ts
import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

export const cache = createCache({
  namespace: "app",
  provider: memoryProvider({ maxEntries: 10_000 }),
  defaultTtl: "5m",
  safety: {
    failOpen: true,
    preventStampede: true,
  },
});
```

`namespace` keeps keys from different applications apart. `defaultTtl` is used when a query does
not provide its own `ttl`.

## Read through the cache

```ts
export async function getUser(id: string) {
  return cache.query({
    key: `user:${id}`,
    tags: [`user:${id}`, "users"],
    ttl: "5m",
    fetcher: () => userRepo.findById(id),
  });
}
```

On a miss, SafeCache calls `fetcher()` and stores the result. On a hit, it returns the cached value.
If the provider fails and `failOpen` is enabled, SafeCache falls back to the fetcher.

## Invalidate after writes

```ts
export async function updateUser(id: string, data: Partial<User>) {
  return cache.mutate({
    tags: [`user:${id}`, "users"],
    action: () => userRepo.update(id, data),
  });
}
```

`mutate()` runs `action()` first. Cache invalidation happens only after the action succeeds. If the
write throws, the cache is left unchanged and the error is propagated.

## Try the example

See [Basic Node Example](../examples/basic-node/README.md). It demonstrates misses, hits,
mutation-aware invalidation, and tag organization with the memory provider.

## Common mistakes

- Do not cache mutable database records without a clear invalidation tag.
- Do not use the same namespace for unrelated applications.
- Do not hide the cache in a global singleton if dependency injection is available.
- Do not assume stale values are returned by default; configure stale-while-revalidate explicitly.

## Related packages

- `@safecache/core`
- `@safecache/memory`
- `@safecache/testing`
- `@safecache/redis`
