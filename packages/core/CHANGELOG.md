# @safecache/core

## 0.1.2

### Patch Changes

- Reliability and fail-safe hardening across the framework.

  Correctness/concurrency:

  - core: fence the write path against concurrent invalidation via a per-key invalidation epoch, so an `invalidate()` during an in-flight fetch can no longer be overwritten with stale data; read-repair backfill is fenced the same way.
  - core/locks: `CacheLockHandle` now exposes a fencing `token` and `renew()`, the holder renews the lock during long fetches, and lock TTL is decoupled from `query.timeout` via `safety.lockTtl`.
  - core: real half-open circuit breaker (single probe, sliding-window failure accounting), collision-safe key escaping, plugin/event-handler isolation, stricter entry deserialization, and duration overflow guards.

  Fail-safe guarantee:

  - core: new `onError` notifier on `createCache` — a single place to observe every cache-side failure. SafeCache remains fail-open by default; cache-side errors are reported, never thrown into the application unless you opt into `safety.failOpen: false` or per-adapter `propagateInvalidationErrors`.
  - decorators/express/fastify/nestjs/mongoose/prisma/mongodb-streams/postgres-outbox/event buses: hardened so a cache-side failure never breaks the host operation.

  Providers/transports/integrations:

  - memcached: binary-safe values and TTL > 30 days handling; redis: atomic tag-index writes and node-redis v6 option shapes; memory: LRU eviction and exact-match tag index; locks: atomic Lua release/renew.
  - kafka: unique consumer group fan-out; rabbitmq: manual ack; nats: delivery confirmation; shared event validation across transports.
  - mongoose: broader write-op hook coverage; mongodb-streams: dead resume-token recovery; postgres-outbox: claim-then-dispatch (invalidation outside the transaction), dead-letter events, and backoff.
  - metrics: provider-latency, lock-wait, and refresh metrics are now populated; dashboard: optional authorization hook; testing: faithful tag-index support.

## 0.1.1

### Patch Changes

- Fix distributed lock coordination, fail-closed cache errors, NestJS async cache reuse, and Redis tag cleanup.
- f127ad8: Improve package README documentation and examples links.
