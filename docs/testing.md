# Testing Utilities

`@safecache/testing` provides deterministic test doubles for cache behavior: a controllable clock,
an in-memory provider, a mock event bus, and a one-call helper that wires them into a real cache.

## Install

```bash
pnpm add -D @safecache/testing
```

## createTestCache

The fastest way to get a working cache in a test. It builds a real `createCache` instance backed by
an in-memory provider and a `FakeClock`, and returns both so you can advance time deterministically.

```ts
import { createTestCache } from "@safecache/testing";

const { cache, clock } = createTestCache({ defaultTtl: "1m" });

const value = await cache.query({ key: "user:1", fetcher: () => loadUser(1) });

clock.advance(60_000); // expire the entry
// next query for the same key is a miss and re-runs the fetcher
```

`createTestCache(options)` accepts a partial `CacheOptions` (namespace defaults to `"test"`,
`defaultTtl` to `"1m"`). The `clock` option is narrowed to `FakeClock` so the deterministic clock is
always the one returned in the result; if you do not pass a `provider`, an in-memory one is created
that shares the same fake clock.

## FakeClock

A `Clock` implementation with manual control:

```ts
import { FakeClock } from "@safecache/testing";

const clock = new FakeClock(0);
clock.now(); // 0
clock.advance(500); // move forward 500ms
clock.set(10_000); // jump to an absolute time
```

## FakeProvider

An in-memory `CacheProvider` with a real `InMemoryTagIndex`, honoring TTLs against a `Clock` (pass
the same `FakeClock` to make expiry deterministic). Implements `get`/`set`/`delete`/`clear`.

```ts
import { FakeProvider, FakeClock } from "@safecache/testing";

const clock = new FakeClock();
const provider = new FakeProvider(clock);
```

## MockEventBus

An in-memory `CacheEventBus` that delivers published events to local subscribers — useful for
testing distributed invalidation paths without real infrastructure. Implements `publish` and
`subscribe` (which returns an async unsubscribe).

## Common mistakes

- Using the real system clock in tests — pass/advance a `FakeClock` for deterministic expiry.
- Creating a `FakeProvider` with a different clock than the cache, so expiry does not line up.
- Forgetting to `await` the unsubscribe returned by `MockEventBus.subscribe`.

## Related docs

- [Core concepts](core-concepts.md)
- [Safety model](safety-model.md)
- [Distributed invalidation](distributed-invalidation.md)
