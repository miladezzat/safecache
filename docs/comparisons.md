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
- Stale-while-revalidate helpers: utilities focused on returning stale values while refreshing.

## Summary Table

| Feature                         | SafeCache | cache-manager               | Keyv           | node-cache     | lru-cache      | Raw Redis clients |
| ------------------------------- | --------- | --------------------------- | -------------- | -------------- | -------------- | ----------------- |
| Cache-aside `query()` API       | Yes       | Partial                     | Manual         | Manual         | Manual         | Manual            |
| `wrap()` convenience API        | Yes       | Yes                         | Manual         | Manual         | Manual         | Manual            |
| Mutation-aware invalidation     | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Tag invalidation                | Yes       | Store/custom-code dependent | Manual         | Manual         | Manual         | Manual            |
| Namespace-aware keys            | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Tenant-aware keys               | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Local stampede protection       | Yes       | Limited/custom              | Manual         | Manual         | Manual         | Manual            |
| Distributed lock support        | Yes       | Adapter/custom              | Manual         | No             | No             | Manual            |
| Distributed invalidation events | Yes       | Adapter/custom              | Manual         | No             | No             | Manual            |
| Fail-open behavior              | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Provider circuit breaker        | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Stale-while-revalidate          | Yes       | Limited/custom              | Manual         | Manual         | Manual         | Manual            |
| Refresh-ahead                   | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Version checks                  | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Runtime events and stats        | Yes       | Limited/custom              | Limited/custom | Limited/custom | Limited/custom | Manual            |
| Prometheus-style metrics        | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Testing utilities               | Yes       | Manual                      | Manual         | Manual         | Manual         | Manual            |
| Optional DB-change sync         | Yes       | No                          | No             | No             | No             | Manual            |

The table uses conservative wording:

- `Manual` means the tool can be used to build the behavior, but the behavior is not the primary
  abstraction.
- `Limited/custom` means the behavior may exist in some combinations, stores, or userland code, but
  it is not a consistent cross-provider contract.
- `No` means the tool is intentionally scoped elsewhere.

## SafeCache vs `cache-manager`

`cache-manager` is a mature general cache wrapper with a familiar `wrap()` style. It is useful when
you want a conventional cache abstraction and store ecosystem.

SafeCache differs by making cache safety and invalidation the main abstraction:

- Canonical `query()` API with tags, tenants, TTL, stale behavior, and fetcher semantics.
- `mutate()` for action-first invalidation after successful writes.
- Built-in tag invalidation contract.
- Multi-layer cache backfill.
- Local single-flight for stampede protection.
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

`node-cache` and `lru-cache` are local in-process caches. They are simple and fast for one process.

SafeCache can use an in-memory layer too, but it adds behavior around that layer:

- Tags and invalidation flows.
- Fail-open fetcher fallback.
- Multi-layer memory plus Redis setups.
- Events and metrics.
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

Decorator libraries can make cache usage terse, but they often hide the cache instance or encourage
implicit global behavior.

SafeCache decorators are optional and explicit:

- `@Cached` delegates to `cache.query()`.
- `@CacheSync` delegates to invalidation APIs.
- `withSafeCache(instance, cache)` attaches the cache explicitly.
- Core does not require decorators.

Use SafeCache decorators when they improve ergonomics. Use the core API when explicit cache calls
are clearer.

## SafeCache vs Stale-While-Revalidate Helpers

Stale-while-revalidate libraries focus on serving stale values while refreshing in the background.
That is useful, but it is only one caching behavior.

SafeCache includes stale-while-revalidate as one option alongside:

- Mutation-aware invalidation.
- Tag invalidation.
- Refresh-ahead.
- Stampede protection.
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
