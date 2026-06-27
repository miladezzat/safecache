# Safety Model

SafeCache treats the database or backing service as the source of truth. The cache is an
optimization layer. Cache failures should degrade performance, not take the application down.

## The safety guarantee: fail-open by default

This is the central promise of SafeCache:

> A cache-side failure NEVER reaches your application unless you explicitly opt in.

SafeCache is **fail-open by default**. Any error that originates on the cache path — the provider
is down, a value fails to (de)serialize, a tag-index update fails, a lock cannot be acquired,
renewed, or released, or a distributed publish/subscribe fails — is caught internally. The failure
is:

1. **Surfaced** through the `onError` notifier you pass to `createCache` (and equivalently through
   `cache.on("error", ...)`), and through per-adapter notifiers on providers and event buses.
2. **Swallowed** so the request continues as if the cache were absent (a read falls back to the
   fetcher; a write still completes).

It is **never thrown** into your code unless you opt into fail-closed behavior — either globally
with `safety.failOpen: false`, or per adapter with `propagateInvalidationErrors: true`.

The one deliberate exception is your own application logic: a `mutate()` `action()` error and a
`query()` `fetcher()` error are _your_ code, not cache-side failures, so they propagate normally.

## Default posture

SafeCache is designed around safe cache-aside behavior:

- Reads fall back to the fetcher when a provider read fails.
- Writes to cache do not block returning fresh data.
- Mutation actions run before invalidation.
- Mutation action errors propagate and do not invalidate.
- Same-process single-flight prevents duplicate fetches for the same miss.
- Stale values are returned only when stale-while-revalidate is enabled.

## Observing failures with onError

Because failures are swallowed, observability is not optional — wire the `onError` notifier so a
degraded cache is visible. It receives a `CacheErrorEvent`:
`{ type: "error"; operation: string; error: Error; key?: string; tenant?: string }`.

```ts
import { createCache } from "@safecache/core";
import * as Sentry from "@sentry/node";

const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  onError: (event) => {
    // `operation` identifies the failing path, e.g. "provider:get",
    // "serializer:deserialize", "lock:release", "events:publish".
    logger.warn(
      { op: event.operation, key: event.key, tenant: event.tenant, err: event.error },
      "safecache degraded (fail-open)",
    );
    Sentry.captureException(event.error, { tags: { safecache_op: event.operation } });
  },
});
```

The same stream is available imperatively, which is handy for attaching listeners after
construction (the metrics collector uses this internally):

```ts
const onError = (event) => logger.warn({ op: event.operation }, event.error.message);
cache.on("error", onError);
// later: cache.off("error", onError);
```

`onError` (and any `error` handler) is invoked defensively: if your notifier itself throws, the
throw is swallowed so the notifier can never break the caller.

## Opting into fail-closed

When stale or missing cache data is unacceptable for a workload, opt into fail-closed so cache-side
errors propagate instead of being swallowed:

```ts
const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  safety: {
    failOpen: false, // provider/serializer/lock errors now throw
  },
});
```

Per-adapter, invalidation-side failures can be propagated selectively without going fully
fail-closed. Provider and event-bus adapters (for example `@safecache/memcached`,
`@safecache/aws-events`, `@safecache/prisma`, `@safecache/mongodb-streams`) accept their own
`onError` / `onInvalidationError` notifier and a `propagateInvalidationErrors` flag that re-throws
the failure instead of only notifying:

```ts
import { memcachedProvider } from "@safecache/memcached";

const provider = memcachedProvider(client, {
  onError: (error) => logger.warn(error),
  propagateInvalidationErrors: false, // default: swallow + notify (SafeCache contract)
});
```

## Fail open (the default)

`failOpen` defaults to `true`, so the example below is the out-of-the-box behavior — provider read
errors are converted to misses and the fetcher runs:

```ts
const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  safety: {
    failOpen: true, // default; shown here for clarity
  },
});
```

This protects request paths from Redis outages, serializer issues, and transient provider errors.
The tradeoff is extra load on the source of truth while the cache is unhealthy. Pair fail-open with
`onError` (see above) so the degradation is observable.

## Stampede prevention

Same-process single-flight is enabled by default through `preventStampede`.

```ts
safety: {
  preventStampede: true;
}
```

Concurrent misses for the same scoped key share one fetcher call. Distributed stampede prevention
requires a distributed lock adapter such as `@safecache/locks`.

## Lock TTL

When a distributed lock is used, `safety.lockTtl` controls how long the acquired lock lives. It is
deliberately **decoupled** from `query.timeout`: the per-request timeout bounds how long a single
provider operation may take, whereas the lock must live long enough for the holder to finish
fetching _and_ storing the value, regardless of any read timeout.

```ts
const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  distributed: { lock: redisLock(redis) },
  safety: {
    lockTtl: "10s", // how long the single-flight lock is held while one caller fetches
  },
});
```

`lockTtl` accepts the standard duration input (a number of milliseconds or a string such as
`"10s"` / `"500ms"`). When unset, SafeCache uses a built-in default. The lock holder renews the
lock periodically while it works, and waiting peers poll for the refreshed value until the lock TTL
elapses.

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
- Running fail-open without wiring `onError` (or `cache.on("error", ...)`) — a degraded cache then
  fails silently.
- Assuming a `mutate()`/`query()` error is a cache failure: application `action`/`fetcher` errors
  propagate by design.
- Setting `lockTtl` shorter than a typical fetch, so the lock expires mid-fetch and stampede
  protection lapses.

## Related docs

- [Stampede prevention](stampede-prevention.md)
- [Stale-while-revalidate](stale-while-revalidate.md)
- [Tags and invalidation](tags-and-invalidation.md)
- [Metrics](metrics.md)
