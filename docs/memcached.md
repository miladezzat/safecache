# Memcached Provider

`@safecache/memcached` adapts a Memcached client to the SafeCache `CacheProvider` interface. Tags
are tracked with an in-process `InMemoryTagIndex` (Memcached has no native set/tag support), and the
provider follows the SafeCache fail-open contract: cache-side errors are caught, routed to an
optional `onError` notifier, and swallowed so the host operation continues as if the cache were
absent.

## Install

```bash
pnpm add @safecache/memcached @safecache/core
```

Add your Memcached client separately.

## Provider setup

```ts
import { createCache } from "@safecache/core";
import { memcachedProvider } from "@safecache/memcached";

const cache = createCache({
  namespace: "app",
  provider: memcachedProvider(client, {
    onError: (error) => logger.warn(error, "memcached degraded"),
  }),
  defaultTtl: "5m",
});
```

## Options

- `onError?: (error: Error) => void` — invoked for every cache-path failure (`get`/`set`/`delete`/
  `clear`). Defaults to a silent no-op; wire it to your logger / Sentry / metrics. It is called
  defensively, so a throwing notifier cannot break the caller.
- `propagateInvalidationErrors?: boolean` — opt into fail-closed `clear()`. When `true`, a `clear()`
  against a client that does not implement `flush()` rejects instead of routing to `onError`.
  Default `false` keeps the SafeCache swallow-and-notify contract.

## Required client shape

```ts
interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  flush?(): Promise<void>; // enables clear()
  version?(): Promise<string>; // surfaced via health()
}
```

## Behavior notes

- **TTLs:** Memcached treats a TTL above 30 days (in seconds) as an absolute Unix timestamp. The
  provider converts large TTLs to an absolute epoch so long stale-while-revalidate / refresh-ahead
  windows do not expire immediately.
- **Binary safety:** values are prefixed with a one-byte sentinel so strings and binary
  (`Uint8Array`) payloads round-trip losslessly; binary values are base64-encoded.
- **Health:** `health()` reports `ok: true`, including the server `version` when the client exposes
  `version()`.

## Common mistakes

- Expecting `clear()` to work without a client `flush()` implementation.
- Assuming tags are shared across processes — the tag index is in-process, so use a distributed
  event bus for cross-instance invalidation.

## Related docs

- [Safety model](safety-model.md)
- [Tags and invalidation](tags-and-invalidation.md)
- [Distributed invalidation](distributed-invalidation.md)
