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

SafeCache is early-stage. Packages are published as `0.1.0`; APIs are usable but may change before
`1.0`.

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

## Packages

| Package                      | Purpose                                                           | Maturity      |
| ---------------------------- | ----------------------------------------------------------------- | ------------- |
| `@safecache/core`            | Cache engine, contracts, TTL, tags, invalidation, safety behavior | Core          |
| `@safecache/memory`          | In-memory provider and tag index                                  | Core          |
| `@safecache/testing`         | Test helpers and in-memory cache factories                        | Core          |
| `@safecache/redis`           | Redis provider and Redis tag index                                | Distributed   |
| `@safecache/locks`           | Redis `SET NX PX` lock adapter                                    | Distributed   |
| `@safecache/pubsub`          | Redis Pub/Sub event bus                                           | Distributed   |
| `@safecache/events`          | In-process event bus utilities                                    | Distributed   |
| `@safecache/serializers`     | JSON, SuperJSON-style, and msgpack-style serializer entry points  | Provider      |
| `@safecache/valkey`          | Valkey-compatible provider export                                 | Provider      |
| `@safecache/memcached`       | Memcached provider                                                | Provider      |
| `@safecache/decorators`      | `@Cached` and `@CacheSync` helpers                                | DX            |
| `@safecache/express`         | Express request integration                                       | DX            |
| `@safecache/fastify`         | Fastify plugin integration                                        | DX            |
| `@safecache/nestjs`          | NestJS module and service integration                             | DX            |
| `@safecache/prisma`          | Prisma mutation invalidation plugin                               | ORM           |
| `@safecache/mongoose`        | Mongoose mutation invalidation hooks                              | ORM           |
| `@safecache/mongodb-streams` | MongoDB change stream invalidation                                | Magic sync    |
| `@safecache/postgres-outbox` | Postgres outbox invalidation worker                               | Magic sync    |
| `@safecache/metrics`         | Metrics collector and Prometheus output                           | Observability |
| `@safecache/cli`             | `safecache` operational CLI                                       | Observability |
| `@safecache/dashboard`       | Read-only dashboard primitives                                    | Observability |
| `@safecache/kafka`           | Kafka event bus adapter                                           | Advanced      |
| `@safecache/nats`            | NATS event bus adapter                                            | Advanced      |
| `@safecache/rabbitmq`        | RabbitMQ event bus adapter                                        | Advanced      |
| `@safecache/aws-events`      | AWS event bus adapter                                             | Advanced      |

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

## Comparison

Use `lru-cache`, `node-cache`, or raw Redis when you only need a simple storage primitive. Use
SafeCache when you need the application-level caching layer around those primitives: cache-aside
reads, mutation-aware invalidation, tags, stampede protection, distributed events, fail-open
behavior, and observability.

See [Caching Comparisons](docs/comparisons.md) for a detailed comparison with `cache-manager`,
Keyv, `node-cache`, `lru-cache`, Redis clients, decorator libraries, and framework cache modules.

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
