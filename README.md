# SafeCache

SafeCache is a production-safe cache reliability framework for Node.js.

It is not a Redis wrapper. SafeCache is designed around cache-aside reads, mutation-aware
invalidation, distributed coordination, stampede protection, fail-open safety, and optional
database-change sync.

## Status

This repository is being implemented phase by phase:

1. Core, memory provider, and testing utilities.
2. Redis provider, distributed locks, and Pub/Sub invalidation.
3. Serializers and additional providers.
4. Decorators and framework adapters.
5. ORM plugins.
6. Magic sync from database changes.
7. Metrics and CLI.
8. Dashboard.
9. Advanced event buses and enterprise features.

## Package Goals

- `@safecache/core`: dependency-light cache engine and contracts.
- `@safecache/memory`: in-memory provider and tag index.
- `@safecache/testing`: deterministic testing utilities.
- `@safecache/redis`: Redis-backed provider and tag index.
- `@safecache/locks`: distributed locks.
- `@safecache/pubsub`: distributed invalidation.
- `@safecache/kafka`, `@safecache/nats`, `@safecache/rabbitmq`, `@safecache/aws-events`:
  advanced event bus adapters.

## Safety Model

The database remains the source of truth. Cache errors should degrade performance, not break the app.
