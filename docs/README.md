# SafeCache Documentation

This directory contains the operational and integration documentation for SafeCache.

SafeCache is early-stage. Packages are published as `0.1.0`; APIs are usable but may change before
`1.0`.

## Start Here

- [Getting started](getting-started.md)
- [Core concepts](core-concepts.md)
- [Safety model](safety-model.md)
- [Cache-aside strategy](cache-aside-strategy.md)
- [Caching comparisons](comparisons.md)

## Runnable Tutorials

- [Basic Node](../examples/basic-node/README.md)
- [Redis distributed](../examples/redis-distributed/README.md)
- [NestJS](../examples/nestjs/README.md)
- [MongoDB magic sync](../examples/magic-mongodb/README.md)
- [Postgres outbox](../examples/postgres-outbox/README.md)

## Core Caching

- [Tags and invalidation](tags-and-invalidation.md)
- [Namespaces and tenants](namespaces-and-tenants.md)
- [Stale-while-revalidate](stale-while-revalidate.md)
- [Stampede prevention](stampede-prevention.md)

## Distributed Caching

- [Redis setup](redis-setup.md)
- [Distributed invalidation](distributed-invalidation.md)
- [Advanced event buses](advanced-event-buses.md)
- [Audit, actor, and reason tracking](audit-actor-reason-tracking.md)
- [Multi-region notes](multi-region.md)

## Framework Integrations

- [Decorators](decorators.md)
- [NestJS usage](nestjs-usage.md)

## ORM Integrations

- [Prisma usage](prisma-usage.md)
- [Mongoose usage](mongoose-usage.md)

## Magic Sync

- [MongoDB magic sync](mongodb-magic-sync.md)
- [Postgres outbox](postgres-outbox.md)

## Observability And Operations

- [Metrics](metrics.md)
- [CLI](cli.md)
- [Dashboard](dashboard.md)
- [Releasing](releasing.md)
