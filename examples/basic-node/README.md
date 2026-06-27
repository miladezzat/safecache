# Basic Node Example

This example demonstrates the smallest useful SafeCache setup: `@safecache/core` with the in-memory
provider.

## What it demonstrates

- `createCache()`
- `query()` cache-aside reads
- `mutate()` action-first invalidation
- entity and collection tags
- local stampede protection
- basic runtime stats
- `onError` fail-safe notifier

## Packages used

```txt
@safecache/core
@safecache/memory
```

## Verify the example

```bash
pnpm --filter basic-node typecheck
pnpm --filter basic-node build
```

## Walkthrough

`getUser("1")` reads through SafeCache:

```ts
return cache.query({
  key: `user:${id}`,
  tags: [`user:${id}`, "users"],
  fetcher: async () => users.get(id) ?? null,
});
```

`updateUser("1", data)` updates the source map first and invalidates only after that action
succeeds:

```ts
return cache.mutate({
  tags: [`user:${id}`, "users"],
  action: async () => {
    const next = { ...current, ...data };
    users.set(id, next);
    return next;
  },
});
```

SafeCache is fail-open: internal faults are never thrown into your application,
but they are reported through `onError` so a degraded cache stays observable.
Wire it to your logger / Sentry / metrics:

```ts
export const cache = createCache({
  namespace: "basic-node",
  provider: memoryProvider(),
  defaultTtl: "5m",
  safety: { failOpen: true, preventStampede: true },
  onError: (event) => {
    console.error(`[safecache] ${event.operation} failed:`, event.error.message);
  },
});
```

The same stream is available imperatively after construction via
`cache.on("error", handler)`.

## Expected behavior

`runBasicNodeExample()` performs:

1. first read: miss, fetches from source
2. second read: hit, skips fetcher
3. mutation: updates source and invalidates tags
4. final read: miss again, fetches updated value

## What to copy into a real app

- Keep `createCache()` near application composition.
- Put `query()` around explicit read paths.
- Put `mutate()` around write paths.
- Use both entity tags and collection tags.
- Pass `onError` so a degraded cache reaches your logger / Sentry / metrics.

## Related docs

- [Getting started](../../docs/getting-started.md)
- [Cache-aside strategy](../../docs/cache-aside-strategy.md)
- [Tags and invalidation](../../docs/tags-and-invalidation.md)
