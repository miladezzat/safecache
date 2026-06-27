# SafeCache

[![CI](https://github.com/miladezzat/safecache/actions/workflows/ci.yml/badge.svg)](https://github.com/miladezzat/safecache/actions/workflows/ci.yml)
[![Release](https://github.com/miladezzat/safecache/actions/workflows/release.yml/badge.svg)](https://github.com/miladezzat/safecache/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@safecache/core.svg)](https://www.npmjs.com/package/@safecache/core)
[![license](https://img.shields.io/npm/l/@safecache/core.svg)](https://github.com/miladezzat/safecache/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@safecache/core.svg)](https://www.npmjs.com/package/@safecache/core)
[![pnpm](https://img.shields.io/badge/pnpm-11.7.0-F69220.svg)](https://pnpm.io/)

SafeCache is a production-safe caching framework for Node.js.

It is not a Redis wrapper and it is not just a local TTL map. SafeCache sits above cache providers
and gives applications a consistent cache-aside API, mutation-aware invalidation, tag organization,
stampede protection, fail-open behavior, distributed coordination, test utilities, and observability.

SafeCache is in active `0.x` development. The current packages are suitable for evaluation and
early integration, and APIs may evolve before `1.0`.

## Why SafeCache Exists

Most Node.js cache tools make storage easy: put a value in memory, Redis, or another backend with a
TTL. Production caching usually fails somewhere else:

- a write path forgets to invalidate related reads
- many requests stampede the database after one hot key expires
- Redis has a transient outage and the app fails closed
- one instance invalidates local memory while another serves stale data
- nobody can tell which key, tag, or plugin caused a bad cache state

SafeCache makes those behaviors explicit and repeatable.

## Install

```bash
pnpm add @safecache/core @safecache/memory
```

For Redis-backed distributed caching:

```bash
pnpm add @safecache/core @safecache/memory @safecache/redis @safecache/locks @safecache/pubsub
```

## Quick Start

```ts
import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

const cache = createCache({
  namespace: "app",
  provider: memoryProvider(),
  defaultTtl: "5m",
  safety: {
    failOpen: true,
    preventStampede: true,
  },
});

const user = await cache.query({
  key: `user:${id}`,
  tags: [`user:${id}`, "users"],
  fetcher: () => userRepo.findById(id),
});
```

## Mutation-Aware Invalidation

`mutate()` runs your write first. SafeCache invalidates only after the action succeeds.

```ts
await cache.mutate({
  tags: [`user:${id}`, "users"],
  action: () => userRepo.update(id, data),
});
```

## Distributed Setup

```ts
import { createCache } from "@safecache/core";
import { redisLock } from "@safecache/locks";
import { memoryProvider } from "@safecache/memory";
import { redisPubSub } from "@safecache/pubsub";
import { redisProvider } from "@safecache/redis";

const cache = createCache({
  namespace: "app",
  source: "api-1",
  layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
  distributed: {
    lock: redisLock(redis),
    events: redisPubSub(redis),
  },
  defaultTtl: "5m",
});
```

## What SafeCache Solves

- Stale data from forgotten invalidation.
- Cache stampede on hot keys.
- Redis or cache provider failures.
- Distributed invalidation across app instances.
- Key and tag organization across namespaces and tenants.
- Testability with deterministic providers and helpers.
- Observability through events, stats, metrics, CLI, and dashboard packages.
- Optional database-change sync through MongoDB streams and Postgres outbox integrations.

## When To Use SafeCache

Use SafeCache when your app needs:

- cache-aside reads with a consistent TypeScript API
- mutation-aware invalidation after successful writes
- tag-based invalidation for entity and collection dependencies
- local or distributed stampede protection
- fail-open behavior during cache provider outages
- multi-layer memory plus Redis caching
- observability through events, stats, metrics, CLI, or dashboard tooling

## When Not To Use SafeCache

Use a smaller tool instead when:

- you only need a single-process TTL map
- you only need direct Redis commands
- you do not need tags or mutation-aware invalidation
- you want a framework-specific route cache and do not need application-level cache safety
- you cannot accept `0.x` API evolution yet

## Packages

| Package                      | Purpose                                                              | Maturity      |
| ---------------------------- | -------------------------------------------------------------------- | ------------- |
| `@safecache/core`            | Cache engine, contracts, TTL, tags, invalidation, safety behavior    | Core          |
| `@safecache/memory`          | In-memory provider and tag index                                     | Core          |
| `@safecache/testing`         | Test helpers and in-memory cache factories                           | Core          |
| `@safecache/redis`           | Redis provider and Redis tag index                                   | Distributed   |
| `@safecache/locks`           | Redis `SET NX PX` lock adapter                                       | Distributed   |
| `@safecache/pubsub`          | Redis Pub/Sub event bus                                              | Distributed   |
| `@safecache/events`          | In-process event bus utilities                                       | Distributed   |
| `@safecache/serializers`     | JSON, a date-aware JSON serializer, and a JSON-over-bytes serializer | Provider      |
| `@safecache/valkey`          | Valkey-compatible provider export                                    | Provider      |
| `@safecache/memcached`       | Memcached provider                                                   | Provider      |
| `@safecache/decorators`      | `@Cached` and `@CacheSync` helpers                                   | DX            |
| `@safecache/express`         | Express request integration                                          | DX            |
| `@safecache/fastify`         | Fastify plugin integration                                           | DX            |
| `@safecache/nestjs`          | NestJS module and service integration                                | DX            |
| `@safecache/prisma`          | Prisma mutation invalidation plugin                                  | ORM           |
| `@safecache/mongoose`        | Mongoose mutation invalidation hooks                                 | ORM           |
| `@safecache/mongodb-streams` | MongoDB change stream invalidation                                   | Magic sync    |
| `@safecache/postgres-outbox` | Postgres outbox invalidation worker                                  | Magic sync    |
| `@safecache/metrics`         | Metrics collector and Prometheus output                              | Observability |
| `@safecache/cli`             | `safecache` operational CLI                                          | Observability |
| `@safecache/dashboard`       | Read-only dashboard primitives                                       | Observability |
| `@safecache/kafka`           | Kafka event bus adapter                                              | Advanced      |
| `@safecache/nats`            | NATS event bus adapter                                               | Advanced      |
| `@safecache/rabbitmq`        | RabbitMQ event bus adapter                                           | Advanced      |
| `@safecache/aws-events`      | AWS event bus adapter                                                | Advanced      |

## Safety Model

The database remains the source of truth. Cache errors should degrade performance, not break the app.

Default behavior is intentionally conservative:

- Provider read errors fall back to the fetcher.
- Provider write errors do not block returning fresh data.
- Mutation action errors propagate and do not invalidate cache entries.
- Same-process single-flight reduces local stampedes.
- Distributed locks and event buses are opt-in.
- Stale values are returned only when stale-while-revalidate is configured.
- Namespaces and tenants are part of key generation.

## Caching Comparisons

SafeCache is not trying to replace every cache tool. It is best when caching is part of application
correctness: reads need consistent cache-aside behavior, writes need predictable invalidation, and
multiple app instances need coordinated cache state.

| Tool                                   | Best fit                                                                               | What SafeCache adds                                                                                                                 | When to choose the other tool                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `cache-manager`                        | Mature general-purpose cache wrapper with store adapters                               | Tags, `mutate()`, explicit safety contracts, distributed coordination, DX                                                           | You want an established generic wrapper and can own invalidation                     |
| Keyv                                   | Small async key-value abstraction with TTL and adapters                                | Cache-aside workflow, tag invalidation, stampede protection                                                                         | You want portable `get`/`set` storage with TTL, namespacing, and pluggable backends  |
| `node-cache`                           | Simple in-process TTL cache                                                            | Namespaces, tags, fail-open fetchers, distributed invalidation events, multi-layer caching                                          | One Node.js process owns the data and local TTL is enough                            |
| `lru-cache`                            | Fast in-process bounded LRU cache (with native `fetch()` coalescing and stale serving) | Tags, mutation-aware invalidation, and distributed coordination around the storage layer                                            | You need a local eviction policy, not distributed cache behavior                     |
| Raw Redis clients (`redis`, `ioredis`) | Direct Redis commands and Redis data structures                                        | Provider contracts, serialization, locks, Pub/Sub invalidation                                                                      | Redis commands are the API you want to write directly                                |
| NestJS CacheModule                     | Framework-level cache integration                                                      | Framework-independent cache engine with explicit app semantics                                                                      | Route/method caching plus a store-backed cache manager is enough for your NestJS app |
| Decorator cache packages               | Terse method-level caching                                                             | Optional decorators backed by explicit `query()` and invalidation                                                                   | You prefer decorators only and do not need a broader cache contract                  |
| SWR helpers                            | Serving stale data while refreshing                                                    | SWR plus mutation-aware invalidation, tags, distributed locks/events, a metrics exporter, and a cross-provider multi-layer contract | Stale-while-revalidate is the only behavior you need                                 |

### Feature matrix

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

Wording: `Manual` = you can build it, but it is not the tool's primary abstraction; `Limited/custom` =
exists in some combinations or userland code, not a consistent cross-provider contract; `No` =
intentionally scoped elsewhere.

- **¹** SafeCache's circuit breaker is two-state (open/closed, consecutive-failure); it does not yet
  probe with a half-open trial request before fully reopening.
- **²** `lru-cache` refreshes on stale access via `allowStale`, but does not do proactive pre-expiry
  refresh-ahead.
- **³** SafeCache version checks are best-effort optimistic guards (non-atomic read-then-write), not a
  transactional compare-and-set.

In short: use smaller tools for simple storage. Use SafeCache when you need a shared caching layer
with safety rules, invalidation, distributed behavior, and observability.

See [Caching Comparisons](docs/comparisons.md) for the per-tool write-ups and positioning notes.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Core concepts](docs/core-concepts.md)
- [Safety model](docs/safety-model.md)
- [Cache-aside strategy](docs/cache-aside-strategy.md)
- [Tags and invalidation](docs/tags-and-invalidation.md)
- [Namespaces and tenants](docs/namespaces-and-tenants.md)
- [Stale-while-revalidate](docs/stale-while-revalidate.md)
- [Stampede prevention](docs/stampede-prevention.md)
- [Distributed invalidation](docs/distributed-invalidation.md)
- [Redis setup](docs/redis-setup.md)
- [Metrics](docs/metrics.md)
- [CLI](docs/cli.md)
- [Dashboard](docs/dashboard.md)
- [Caching comparisons](docs/comparisons.md)

## Examples

- [Basic Node](examples/basic-node/README.md)
- [Redis distributed](examples/redis-distributed/README.md)
- [NestJS](examples/nestjs/README.md)
- [MongoDB magic sync](examples/magic-mongodb/README.md)
- [Postgres outbox](examples/postgres-outbox/README.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

## Release

SafeCache uses Changesets and GitHub Actions. See [Releasing to npm](docs/releasing.md).

## License

MIT
