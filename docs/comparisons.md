# Caching Comparisons

SafeCache overlaps with cache wrappers, key-value abstractions, decorator libraries,
stale-while-revalidate helpers, framework cache modules, and direct Redis usage. Its focus is the
application caching layer: safe cache-aside reads, mutation-aware invalidation, distributed
coordination, stampede protection, optional database-change sync, and observability-first debugging.

SafeCache is not the best choice for every cache problem. If you only need a local TTL map, use a
small local cache. If you only need Redis commands, use a Redis client directly. SafeCache is for
applications where cache correctness, invalidation behavior, failure handling, and operational
visibility matter.

## Compared Projects

- [`cache-manager`](https://www.npmjs.com/package/cache-manager): general-purpose Node.js cache manager with store adapters.
- [`keyv`](https://www.npmjs.com/package/keyv): simple key-value storage abstraction with TTL and adapter support.
- [`node-cache`](https://www.npmjs.com/package/node-cache): in-process Node.js cache with TTL.
- [`lru-cache`](https://www.npmjs.com/package/lru-cache): in-process least-recently-used cache.
- [`redis`](https://www.npmjs.com/package/redis) and [`ioredis`](https://www.npmjs.com/package/ioredis): Redis clients.
- NestJS [`CacheModule`](https://docs.nestjs.com/techniques/caching): framework-level cache integration.
- Decorator caching packages: method-level helpers that usually sit above a cache store.
- Stale-while-revalidate helpers: utilities focused on returning stale values while refreshing, usually with request deduplication. Examples: the React data hook [`swr`](https://www.npmjs.com/package/swr) and the server-side, storage-agnostic [`stale-while-revalidate-cache`](https://www.npmjs.com/package/stale-while-revalidate-cache).

## Summary Table

Competitor grades reflect cache-manager v7.x (Keyv-based), keyv v5.x, node-cache v5.x,
lru-cache v11.x, and node-redis v6 / ioredis v5 as of mid-2026.

| Feature                         | SafeCache | cache-manager (v7)          | Keyv (v5)      | node-cache (v5) | lru-cache (v11) | Raw Redis clients |
| ------------------------------- | --------- | --------------------------- | -------------- | --------------- | --------------- | ----------------- |
| Cache-aside `query()` API       | Yes       | Partial (`wrap`)            | Manual         | Manual          | Via `fetch()`   | Manual            |
| `wrap()` convenience API        | Yes       | Yes                         | Manual         | Manual          | Manual          | Manual            |
| Mutation-aware invalidation     | Yes       | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Tag invalidation                | Yes       | Store/custom-code dependent | No             | Manual          | Manual          | Manual            |
| Namespace-aware keys            | Yes       | Via Keyv namespace          | Yes (native)   | Manual          | Manual          | Manual            |
| Tenant-aware keys               | Yes       | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Local stampede protection       | Yes       | Yes (`wrap` coalescing)     | Manual         | Manual          | Yes (`fetch()`) | Manual            |
| Distributed lock support        | Yes       | Adapter/custom              | Manual         | No              | No              | Manual            |
| Distributed invalidation events | Yes       | Adapter/custom              | Manual         | No              | No              | Manual            |
| Fail-open behavior              | Yes       | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Provider circuit breaker        | Yes¹      | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Stale-while-revalidate          | Yes       | Yes (`refreshThreshold`)    | Manual         | Manual          | Yes (`fetch()`) | Manual            |
| Refresh-ahead                   | Yes       | Yes (`refreshThreshold`)    | Manual         | Manual          | Manual²         | Manual            |
| Version checks                  | Yes³      | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Runtime events and stats        | Yes       | Limited/custom              | Limited/custom | Limited/custom  | Limited/custom  | Manual            |
| Prometheus-style metrics        | Yes       | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Testing utilities               | Yes       | Manual                      | Manual         | Manual          | Manual          | Manual            |
| Optional DB-change sync         | Yes       | No                          | No             | No              | No              | Manual            |

The table uses conservative wording:

- `Manual` means the tool can be used to build the behavior, but the behavior is not the primary
  abstraction.
- `Limited/custom` means the behavior may exist in some combinations, stores, or userland code, but
  it is not a consistent cross-provider contract.
- `No` means the tool is intentionally scoped elsewhere.

Footnotes:

- **¹** SafeCache's circuit breaker is two-state (open/closed, consecutive-failure); it does not yet
  probe with a half-open trial request before fully reopening.
- **²** `lru-cache` refreshes on stale access via `allowStale`, but does not do proactive pre-expiry
  refresh-ahead.
- **³** SafeCache version checks are best-effort optimistic guards (non-atomic read-then-write), not a
  transactional compare-and-set.

## SafeCache vs `cache-manager`

`cache-manager` is a mature general cache wrapper with a familiar `wrap()` style. It is useful when
you want a conventional cache abstraction and store ecosystem.

SafeCache differs by making cache safety and invalidation the main abstraction:

- Canonical `query()` API with tags, tenants, TTL, stale behavior, and fetcher semantics.
- `mutate()` for action-first invalidation after successful writes.
- Built-in tag invalidation contract.
- Multi-layer cache backfill across providers (cache-manager also supports tiered stores).
- Local single-flight for stampede protection as an explicit default (cache-manager also coalesces concurrent calls via `wrap()`).
- Redis lock and Pub/Sub adapters for distributed coordination.
- Runtime events, stats, metrics, CLI, and dashboard packages.
- Optional database-change sync through MongoDB streams and Postgres outbox.

Use `cache-manager` when you need a broad, established cache wrapper. Use SafeCache when the hard
part is not storing values, but keeping cache behavior safe and observable.

## SafeCache vs Keyv

Keyv is a small key-value abstraction. It is useful when you want a consistent `get`/`set`/`delete`
interface across storage backends.

SafeCache uses provider contracts too, but it operates at a higher level:

- Keyv is storage-oriented.
- SafeCache is workflow-oriented: read-through/cache-aside, invalidation, stale handling,
  stampede protection, and observability.

Use Keyv for a simple portable key-value store. Use SafeCache when cache access needs to coordinate
with application reads and mutations.

## SafeCache vs `node-cache` and `lru-cache`

`node-cache` and `lru-cache` are local in-process caches. They are simple and fast for one process
(modern `lru-cache` also coalesces concurrent loads and can serve stale values through its `fetch()` API).

SafeCache can use an in-memory layer too, but it adds behavior around that layer:

- Tags and invalidation flows.
- Fail-open fetcher fallback.
- Multi-layer memory plus Redis setups.
- Distributed invalidation events and a metrics exporter (`node-cache` already has local events and `getStats()`).
- Distributed invalidation when multiple processes are running.

Use a local cache when process-local data is enough. Use SafeCache when the same cache rules must
hold across modules, services, tenants, or instances.

## SafeCache vs Raw Redis Clients

Redis clients expose Redis commands. That is exactly what you want when Redis is your data structure
layer.

SafeCache does not replace Redis clients. It uses Redis-style clients behind provider, lock, and
event bus adapters. The difference is where application logic lives:

- With raw Redis, the app owns key naming, serialization, TTLs, stampede protection, invalidation,
  Pub/Sub dedupe, and failure behavior.
- With SafeCache, those concerns move into a shared cache layer with explicit contracts.

Use raw Redis for direct Redis features. Use SafeCache when Redis is one implementation detail of an
application cache.

## SafeCache vs Decorator Libraries

Decorator libraries can make cache usage terse. Many (for example `@type-cacheable`'s global
`useAdapter`, or `memoizee`'s per-function cache) encourage implicit or global cache state, though
some (for example `node-ts-cache`) require an explicit cache instance.

SafeCache decorators are optional and explicit:

- `@Cached` delegates to `cache.query()`.
- `@CacheSync` delegates to invalidation APIs.
- `withSafeCache(instance, cache)` attaches the cache explicitly.
- Core does not require decorators.

Use SafeCache decorators when they improve ergonomics. Use the core API when explicit cache calls
are clearer.

## SafeCache vs Stale-While-Revalidate Helpers

Stale-while-revalidate libraries focus on serving stale values while refreshing in the background,
usually with request deduplication. That is useful, but it is a focused behavior rather than a full
cache-safety model.

SafeCache includes stale-while-revalidate as one option alongside:

- Mutation-aware invalidation.
- Tag invalidation.
- Refresh-ahead.
- Distributed stampede protection.
- Provider failure behavior.
- Distributed coordination.

Use a stale-while-revalidate helper when stale reads are the only problem. Use SafeCache when stale
reads are one part of a broader cache safety model.

## SafeCache vs Framework Cache Modules

Framework cache modules are convenient for framework integration. They usually focus on attaching a
cache store or caching a route/method.

SafeCache keeps the cache engine framework-independent and offers thin adapters for Express,
Fastify, and NestJS. The framework layer should not own cache correctness; it should expose the
same SafeCache instance to application code.

## Positioning

SafeCache is for teams that need:

- Cache-aside reads with consistent options.
- Action-first mutation invalidation.
- Tag-based invalidation.
- Namespaces and tenants.
- Local and distributed stampede prevention.
- Fail-open behavior during cache provider outages.
- Observability from the beginning.
- Optional sync from database changes.

SafeCache is probably more than you need if:

- You only need a single-process TTL map.
- You only cache a few values and can tolerate manual invalidation.
- Redis commands are the actual interface you want.
- You do not need tags, mutation flows, or distributed behavior.
