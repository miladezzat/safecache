# Safety Model

SafeCache treats the database or backing service as the source of truth. The cache is an
optimization layer. Cache failures should degrade performance, not take the application down.

## Default posture

SafeCache is designed around safe cache-aside behavior:

- Reads fall back to the fetcher when a provider read fails.
- Writes to cache do not block returning fresh data.
- Mutation actions run before invalidation.
- Mutation action errors propagate and do not invalidate.
- Same-process single-flight prevents duplicate fetches for the same miss.
- Stale values are returned only when stale-while-revalidate is enabled.

## Fail open

With `failOpen: true`, provider read errors are converted to misses:

```ts
const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  safety: {
    failOpen: true,
  },
});
```

This protects request paths from Redis outages, serializer issues, and transient provider errors.
The tradeoff is extra load on the source of truth while the cache is unhealthy.

## Stampede prevention

Same-process single-flight is enabled by default through `preventStampede`.

```ts
safety: {
  preventStampede: true;
}
```

Concurrent misses for the same scoped key share one fetcher call. Distributed stampede prevention
requires a distributed lock adapter such as `@safecache/locks`.

## Mutation safety

Use `mutate()` for writes:

```ts
await cache.mutate({
  tags: [`user:${id}`, "users"],
  action: () => userRepo.update(id, data),
});
```

SafeCache invalidates only after `action()` succeeds. Invalidation errors are emitted through
runtime events and should be observed, but they do not change the result of a successful write.

## Common mistakes

- Treating cache data as authoritative.
- Returning stale values without deciding which data classes may be stale.
- Sharing keys across tenants without a tenant field.
- Invalidating before a database write commits.
- Ignoring runtime error events from providers or plugins.

## Related docs

- [Stampede prevention](stampede-prevention.md)
- [Stale-while-revalidate](stale-while-revalidate.md)
- [Tags and invalidation](tags-and-invalidation.md)
- [Metrics](metrics.md)
