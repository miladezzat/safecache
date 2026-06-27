# SafeCache Monorepo — Final Comprehensive Analysis Report

_Lead reviewer synthesis of per-area deep-dives, adversarially-verified issues, and five cross-cutting audits (architecture, security, correctness/concurrency, docs-vs-code, quality)._

---

## 1. Executive Summary

**What SafeCache is.** SafeCache is a production-safe caching framework for Node.js (>=24), shipped as a pnpm + Changesets monorepo of ~25 publishable `@safecache/*` packages plus 5 example apps. It is built on a contract-first, plugin/adapter architecture: `@safecache/core` defines every interface (provider, tag index, lock, event bus, serializer, plugin) and owns all real caching logic in a single 756-line engine (`packages/core/src/cache.ts`); every other package is a thin, dependency-injected implementation of one of those contracts. The framework's value proposition is _resilient behavior under failure_ — fail-open reads, stampede prevention (single-flight + distributed lock), stale-while-revalidate, circuit breaking, signed cross-instance invalidation, and "magic" database-change synchronization (Mongo change streams, Postgres outbox, Prisma/Mongoose hooks).

**Overall maturity/quality verdict: Strong engineering foundation (B+/A−), pre-1.0, with two systemic correctness gaps that must close before a 1.0 safety claim is credible.** TypeScript hygiene is excellent (full strict set + `noUncheckedIndexedAccess`, only 2 `any` in non-test source, zero `@ts-ignore`/`eslint-disable`). The dependency graph is a clean star/DAG with no cycles. Documentation is unusually accurate — every documented API maps to a real export, and competitive claims are honestly footnoted. The test suite's core failure-path coverage is genuinely excellent. However, the marketing promise of "safe" invalidation is undercut by verified concurrency races in the write path, and several backend adapters (memcached especially) silently violate the contracts the flagship Redis path upholds.

**Headline findings:**

- **CRITICAL — Writes are never reconciled against concurrent invalidations.** `fetchAndStore` → `writeEntry` (cache.ts:249–367) unconditionally stores a fetched value with no "invalidated-since-fetch-began" fence, no tombstone, and no generation token. An `invalidate()` arriving mid-fetch is silently overwritten by stale data for a full TTL — on a single node _and_ across instances. This is the single most serious finding and it directly contradicts the framework's central guarantee.
- **CRITICAL — The distributed lock provides mutual exclusion but no fencing.** Lock TTL is never renewed during a long fetch, the handle exposes no fencing token, and `writeEntry` never verifies ownership. A lock that silently expires mid-fetch yields double-fetch + last-writer-wins clobber — defeating stampede protection for exactly the slow keys it most needs to protect. The lock TTL is derived from `query.timeout`, so a fail-fast configuration makes this common rather than exotic.
- **HIGH — Several backend adapters break contracts the Redis path upholds.** Memcached corrupts non-UTF8/binary values via a lossy `TextDecoder` round-trip and mis-handles TTLs >30 days (Memcached's absolute-timestamp quirk → immediate expiry → every read a miss). Kafka load-balances events across instances instead of fanning out, so a shared consumer group means only one instance ever invalidates.
- **HIGH — Magic-sync coverage gaps.** Many common Mongoose write ops (`updateMany`, `replaceOne`, `findOneAndDelete`, `bulkWrite`, `$merge`/`$out`) are never intercepted, so committed writes leave stale cache indefinitely. Mongo change-stream re-watch reuses a dead resume token on non-resumable errors, causing a permanent reconnect loop against a real driver.
- **MEDIUM — The circuit breaker is effectively a two-state flapper.** No half-open probe (full reopen → thundering herd), and `recordSuccess` zeroing the counter on every success means only strictly-consecutive failures ever trip it — under interleaved success/failure it may never open at all.
- **Observability is partly aspirational.** Two documented histograms (`cache_lock_wait_ms`, `cache_provider_latency_ms`) are never populated by core; `actor`/`reason`/`region` audit fields exist in types and helpers but the engine never emits them. Security is otherwise well-defended (HMAC + `timingSafeEqual`, parameterized SQL, escaped dashboard HTML), with distributed invalidation unauthenticated-by-default the main hardening gap.

---

## 2. Architecture Overview

SafeCache is a **contract-first, plugin/adapter star architecture** with `@safecache/core` as the hub. `core` has zero workspace dependencies; every other package implements a contract defined in `core/src/types.ts`. The graph is a strict DAG with no cycles — only `redis`, `memory`, and `metrics` are depended upon by other satellites (`valkey→redis`, `testing→memory`, `cli`/`dashboard→metrics`). Most adapters import _only types_ from core, so runtime coupling is near-zero.

### Layered design

| Layer                                               | Packages                                                                         | Role                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — Core engine + contracts**                     | `core`                                                                           | `cache.ts` engine (`createCache`), all interfaces in `types.ts`, support primitives (`keys`, `single-flight`, `circuit-breaker`, `events`, `plugin`, `serializer`, `duration`) |
| **1 — Providers** (`CacheProvider`)                 | `memory`, `redis`, `valkey` (re-export of redis), `memcached`                    | Pluggable storage backends + tag indexes                                                                                                                                       |
| **2 — Serializers** (`CacheSerializer`)             | `serializers`                                                                    | `jsonSerializer`, `superJsonSerializer`, `msgpackSerializer` (JSON-over-bytes)                                                                                                 |
| **3 — Coordination** (`CacheLock`, `CacheEventBus`) | `locks`, `events` (helpers), `pubsub`, `kafka`, `nats`, `rabbitmq`, `aws-events` | Distributed lock + cross-instance invalidation transports                                                                                                                      |
| **4 — Integrations** (`CachePlugin`)                | `prisma`, `mongoose`, `mongodb-streams`, `postgres-outbox`                       | DB-write → cache invalidation ("magic sync")                                                                                                                                   |
| **5 — Framework adapters**                          | `decorators`, `express`, `fastify`, `nestjs`                                     | Inject a `Cache` reference into app code (no response caching)                                                                                                                 |
| **6 — Observability**                               | `metrics`, `cli`, `dashboard`                                                    | Consume runtime events + `stats()`                                                                                                                                             |
| **Cross-cutting**                                   | `testing`                                                                        | Deterministic fakes + `createTestCache`                                                                                                                                        |

```
@safecache/core   (no @safecache deps — the contract hub)
   ├── memory, redis, locks, pubsub, events, serializers, memcached  → core
   ├── decorators, express, fastify, nestjs                          → core
   ├── prisma, mongoose, mongodb-streams, postgres-outbox            → core
   ├── kafka, nats, rabbitmq, aws-events                             → core
   ├── metrics                                                       → core
   ├── valkey     → redis
   ├── testing    → core + memory
   ├── cli        → core + metrics
   └── dashboard  → core + metrics
```

### End-to-end read flow — `cache.query()` (cache.ts:82)

1. `resolveTtl()` resolves `query.ttl ?? defaultTtl`; `scopeKey(namespace, key, tenant)` builds the physical key.
2. `readLayers()` (cache.ts:214): if the circuit breaker `isOpen`, short-circuit to **miss**; else iterate layers in order (e.g. memory → redis), each `provider.get()` wrapped in `withTimeout`, errors recorded against the breaker and (if `failOpen`, the default) returning null to continue. Bytes are deserialized; entry classified by `clock.now()`: `expiresAt > now` ⇒ **hit**, else `staleUntil > now` ⇒ **stale**, else continue.
3. **Hit:** increment, emit `hit`; `backfill()` promotes the entry into faster layers; `refreshAheadIfNeeded()` may kick a background refresh.
4. **Stale** (SWR, opt-in, non-strict): serve stale immediately, fire coalesced `refreshInBackground` under single-flight key `refresh:<scopedKey>`.
5. **Miss:** the load is wrapped in `singleFlight.run(scopedKey, …)` (default on), then `fetchAndStoreWithDistributedLock()`: acquire `lock.acquire(scopedKey, ttl)` if configured; holder re-reads layers then `fetchAndStore`; non-holder polls layers every 10ms via `waitForPeerRefresh` until populated or the lock-TTL deadline, then falls through to its own fetch.
6. `fetchAndStore()`: run `query.fetcher()`; null/undefined not cached unless `cacheNull`; build `CacheEntry` with a **physical TTL** = `max(ttlMs, staleUntil−now)` so SWR windows survive backend eviction; `writeEntry()` per layer with an optional optimistic version guard, then `tagIndex.addTags`.

### End-to-end invalidation flow — `cache.mutate()` (cache.ts:116)

1. **Write-first:** `await options.action()` runs the DB write; if it throws, the error propagates and **nothing is invalidated** (the documented safety guarantee).
2. On success: per key → `invalidate(key)`; per tag → `invalidateByTag(tag)`.
3. Locally: delete the scoped key from every layer's provider; clean each layer's tag index; emit `invalidate`. Tag invalidation resolves affected keys via `getKeysByTag`, deletes them, then `removeTag`.
4. **Fan-out:** build a `CacheEvent` `{id: source:ts:counter, type, source, namespace, key/tag, tenant}`; if `distributed.signingSecret` is set, attach an HMAC-SHA256 `signature` over a canonicalized (sorted-key, signature-excluded) payload; publish via the configured bus.
5. **Peers** receive via `subscribeToDistributedEvents`: drop foreign-namespace and self-source events; `verifyIncomingEvent` timing-safe-compares the HMAC (when a secret is set); `hasSeenEvent` dedupes against a bounded 1000-id window; then apply `invalidate*Internal(..., publish=false)` — local eviction without re-broadcast, terminating fan-out.

**Five extension points** (all interfaces in `types.ts`): Provider (+ TagIndex), Event bus, Lock, Serializer, Plugin — plus two observability surfaces (`cache.on/off` runtime events consumed by `metrics.attach`, and `cache.stats()` consumed by `cli`/`dashboard`).

---

## 3. Per-Area Findings

### Core engine (`packages/core/src/cache.ts`)

**Purpose:** The orchestrator that composes every primitive into the full cache behavior.
**Strengths:** Comprehensive feature set genuinely implemented (SWR with physical-TTL extension, refresh-ahead, single-flight, distributed lock with peer re-check, HMAC signing, namespace/tenant scoping). Write-first mutation ordering is correct and tested.
**Notable issues:** This file is the locus of the two CRITICAL concurrency findings (no write/invalidate reconciliation; lock without fencing) detailed in §4. Additional verified races: read-repair `backfill` can resurrect just-invalidated values; SWR background refresh keyed separately from foreground fetch can clobber a fresher write; `withTimeout` cancels the wait, not the work, so a timed-out fetch can still write later; `recordError` passes inconsistent key shapes (scoped vs logical) and drops tenant on the write path.

### Core support (`keys`, `single-flight`, `circuit-breaker`, `events`, `plugin`, `serializer`, `duration`, `types`)

**Purpose:** Leaf-level, individually-testable primitives.
**Strengths:** Clean config normalization in CircuitBreaker; correct single-flight `.finally` cleanup (a failed fetch doesn't poison the key); PluginRegistry funnels sync + async setup errors uniformly and shuts down in reverse order; `parseDuration` validates numeric inputs and uses an anchored regex; the runtime-event model is a well-formed discriminated union.
**Notable issues:** **Circuit breaker has no half-open state** (full reopen → thundering herd) and **`recordSuccess` zeroes the counter on every success** (only strictly-consecutive failures trip it; interleaved success/failure may never open it). **Key builder has no escaping** — `::` separator collisions across namespace/tenant/key/tag boundaries (latent cross-tenant/poisoning hazard). `PluginRegistry.shutdown` aborts the whole disposal chain if any plugin rejects. `RuntimeEvents.emit` doesn't isolate handler exceptions (one throwing observer drops the rest and can corrupt the emitting operation). `parseDuration` can silently overflow on huge string durations; `jsonSerializer.deserialize`'s guard only checks for object-ness + `'expiresAt' in parsed`, so `expiresAt:'soon'` passes and later poisons comparisons.

### Providers (`memory`, `redis`, `valkey`, `memcached`)

**Purpose:** Pluggable storage backends implementing `CacheProvider` (+ optional `CacheTagIndex`).
**Strengths:** Redis correctly maps `ttlMs`→`PX` and has an explicit non-UTF8 binary round-trip test; redis tag index self-cleans orphaned metadata via EXPIRE; memory expires lazily and removes evicted keys from the tag index; valkey is zero-cost, correct delegation to redis; all providers are dependency-injected (no socket-leak risk).
**Notable issues:** **Memcached corrupts binary values** (lossy `TextDecoder`) and **mis-handles TTL >30 days** (Memcached's absolute-timestamp quirk → immediate expiry) — both HIGH, and both amplified by core's larger physical TTLs. Redis tag-index writes are **non-atomic** (2N+1 round-trips with partial-failure divergence windows). Memory eviction is **FIFO, not LRU** (hot keys evicted first) and **O(n log n) per insert** (full sort in a loop). Memory/memcached `removeKeyFromAllScopes` uses **suffix matching** that can hit the wrong key when scoped keys themselves contain `::`. Redis `set()` forwards `PX:0` (invalid) and `health()` throws on a non-string `ping()`. `LocalTagIndex` (memcached) is a byte-for-byte copy of `MemoryTagIndex` — duplication that belongs in core.

### Coordination — locks (`packages/locks`)

**Purpose:** Distributed `CacheLock` via Redis `SET NX PX` + Lua token-fenced release.
**Strengths:** Token-compare-and-delete release script is the correct safety primitive; well-decoupled via an injected client.
**Notable issues:** The handle exposes **no fencing token** to the write path (root of the CRITICAL lock-without-fencing finding), and there is **no TTL renewal** during long fetches. The non-`eval` fallback does a non-atomic GET-then-DEL race. Test coverage is the weakest of any non-trivial package — the Lua `eval` path and the foreign-token (compare-mismatch) no-op are completely untested, despite being the entire reason the lock is safe.

### Event buses (`events`, `pubsub`, `kafka`, `nats`, `rabbitmq`, `aws-events`)

**Purpose:** Broadcast invalidation events to peers; core owns dedupe/filtering/verification, so transports target at-least-once fanout.
**Strengths:** Consistent bare-JSON wire format across transports (cross-transport interop; HMAC field survives). Kafka has the most careful consumer-loop error handling (poison message + throwing handler both swallowed so offset advances). aws-events correctly surfaces EventBridge's silent partial-failure mode.
**Notable issues:** **Kafka load-balances instead of fanning out** (HIGH) — a shared consumer group means only one instance invalidates; the README implies the failing config and neither doc warns each instance needs a unique groupId. **RabbitMQ leaks unhandled rejections** when a handler throws (bypasses `onError`, can crash the process) and **never acks good messages** (the interface has no `ack`; works only in auto-ack, contradicting the durable-queue guidance). NATS publish is **fire-and-forget** with no way to detect a failed publish. Validation is inconsistent — only RabbitMQ validates incoming shape; kafka/nats/pubsub blindly cast `JSON.parse(...) as CacheEvent`. `onError` signatures differ across transports. `@safecache/events`'s `EventDeduper` duplicates core's inline dedupe and is unused by the runtime path.

### Mongo integrations (`mongoose`, `mongodb-streams`)

**Purpose:** Automatic invalidation for in-process (`mongoose` hooks) and out-of-process (`mongodb-streams` change streams) writes.
**Strengths:** Excellent error containment (a failed invalidation never rejects a committed write nor tears down the stream). Bounded exponential-backoff re-watch with `unref`'d timers and a `getHealth()` surface. Correct per-collection resume-token tracking.
**Notable issues:** **Many common Mongoose write ops are never intercepted** (HIGH) — `updateMany`, `replaceOne`, `findOneAndReplace`, `findOneAndDelete`, `bulkWrite` (no middleware at all), `$merge`/`$out` — so committed writes leave stale cache; docs only hedge that bulk ops "may not include IDs." **Re-watch reuses a dead resume token on non-resumable errors** (HIGH) → permanent reconnect loop against a real driver (the test's fake accepts any token, hiding it). On delete, change-stream tag/tenant derivation only has `_id`, so function resolvers reading other fields silently invalidate the wrong (default) scope. The bare-token-vs-map detection heuristic can misclassify. All packages share the write-vs-invalidation race (core has the `version` mechanism but neither integration wires it up).

### SQL integrations (`prisma`, `postgres-outbox`)

**Purpose:** Connect DB writes to invalidation — Prisma via `$extends`/`mutate()`, Postgres via a durable transactional outbox worker.
**Strengths:** Outbox concurrency is correct (`FOR UPDATE SKIP LOCKED` lets HA workers share one table without double-claiming, faithfully simulated and tested). SQL is injection-safe (`quoteIdentifier` allowlist + bound `$n` params everywhere). At-least-once is sound (side-effect + `processed_at` in one transaction). Dead-lettering prevents a poison row blocking the FIFO head. Prisma invalidation is best-effort and resilient.
**Notable issues:** **Cache invalidation runs inside the open transaction**, holding row locks across N network round-trips (MEDIUM) — a slow/hung cache pins a pooled connection and can exhaust the pool; this is in direct tension with the same-transaction at-least-once guarantee. A row whose side-effect succeeded but commit failed is re-invalidated (benign duplicate, but undocumented), and retry-count bookkeeping is lost on rollback. Dead-lettered rows are silently dropped (no event emitted). `setInterval` polling has no backoff/jitter. Prisma id inference is shallow (misses compound/non-`id` primary keys and `updateMany`/`deleteMany` scope). `parsePayload` throws on malformed JSON, consuming retries on a permanent defect.

### Framework adapters (`express`, `fastify`, `nestjs`, `decorators`)

**Purpose:** Inject a shared `Cache` reference into app code idiomatically; **none cache HTTP responses** (the safe choice — no header/cookie leakage path).
**Strengths:** Fastify uses the correct lifecycle (single `decorateRequest` slot + per-request `onRequest` assignment) and re-implements fastify-plugin's skip-override symbols without the dependency. NestJS `forRootAsync` threads the resolved token so the factory runs once. Decorators avoid a hidden global singleton; `withSafeCache` attaches non-enumerable. Tenant threading is consistent.
**Notable issues:** **Decorators are legacy-only** (`experimentalDecorators`) and silently no-op under TS5 standard decorators, with no README note. `@Cached` omitting `ttl` is a latent runtime throw (only at first invocation) rather than a startup/decoration-time error. `@CacheSync` stops invalidations on the first failing key/tag (no `Promise.allSettled`). Express request augmentation isn't merged into Express's `Request` type (DX gap). Core deps are normal (not peer) dependencies — fine with bundling but can cause identity mismatches if versions drift.

### Observability (`metrics`, `cli`, `dashboard`)

**Purpose:** Consume runtime events + stats; expose Prometheus, CLI ops, and a read-only dashboard.
**Strengths:** Counters (`cache_hits/misses/errors/invalidations/stale_served_total`) are auto-populated via `metrics.attach(cache)`. CLI's 7 commands and adapter shape match docs exactly. Dashboard escapes HTML and enforces read-only (405 on non-GET).
**Notable issues:** **Two documented histograms (`cache_lock_wait_ms`, `cache_provider_latency_ms`) are never fed by core** — they stay at zero unless the consumer manually calls `.observe()`; the `refresh` runtime event maps to no counter. The dashboard has **no built-in `Cache`→`DashboardSnapshot` wiring** (every field is caller-supplied) and **ships no auth** (info-disclosure risk if bound publicly; consider an `authorize?(request)` hook). Error events surface raw cache keys and messages (document that keys must not embed secrets).

### Testing (`packages/testing`)

**Purpose:** Deterministic fakes (`FakeClock`, `FakeProvider`, `MockEventBus`) + `createTestCache` factory.
**Strengths:** Best decision is `createTestCache` defaulting to the **real** memory provider + real core engine, so genuine TTL/single-flight/SWR/tag/event behavior runs (no fake-drift). `FakeClock` is injected end-to-end; boundary semantics match the real provider.
**Notable issues:** **`FakeProvider` omits `tagIndex`**, so substituting it makes `invalidateByTag` a silent no-op that still increments counters and emits events — a false sense of safety (MEDIUM). `createTestCache` silently discards a caller-supplied non-FakeClock (type should narrow to `FakeClock`). Thin coverage of the fakes themselves (no tests for `FakeClock.set`, `FakeProvider.delete/clear`, unsubscribe, custom-provider override).

### Tests (suite quality)

**Purpose:** The correctness contract for a safety-first library; vitest + hand-rolled in-memory fakes of every backend, no external services.
**Strengths:** Core failure-path coverage is genuinely excellent (fail-open _and_ fail-closed, lock fail-open fallback, peer-populated double-check race, SWR at both logical and physical-TTL layers, signed/tampered/unsigned event handling via a `TamperingEventBus`). The "concurrent stale reads → exactly one background refresh" test (cache.test.ts:675) uses a captured deferred — the model the timer-based tests should follow. postgres-outbox and mongodb-streams CDC tests are unusually thorough.
**Notable issues:** Coverage is **inversely correlated with risk** in places — locks (the safety-critical primitive) has the weakest test (the Lua/eval path and foreign-token release are untested). No direct tests for `parseDuration` (h/d units, validation), `CircuitBreaker` in isolation (recordSuccess reset, half-open re-trip, disabled no-op), or the outbox `setInterval`/plugin lifecycle. Determinism leans on fragile `setTimeout(0/10)` outside the one good deferred example. No coverage thresholds configured.

### Docs (`docs/`)

**Purpose:** Operational + integration reference alongside per-package READMEs.
**Strengths:** **Code samples are overwhelmingly accurate** — every documented import/option/call shape maps to a real export; no fabricated APIs found across all 25 docs. No broken cross-references. Competitive claims are unusually disciplined (partial capabilities explicitly footnoted: two-state breaker, non-atomic version checks, empty-by-default histograms).
**Notable issues:** The three weak spots are **observability/metadata claims the runtime never populates**: metrics histograms (lock wait / provider latency), and `actor`/`reason`/`region` audit + multi-region (the types and `@safecache/events` helpers exist, but `publishDistributedEvent` never sets these fields). `docs/README` says packages are 0.1.0 (actual 0.1.1). Six published packages (serializers, testing, express, fastify, valkey, memcached) have no dedicated docs page.

### Examples (`examples/`)

**Purpose:** Five runnable/typecheckable workspace packages doubling as integration smoke tests and copy-paste starters.
**Strengths:** All five `tsc --noEmit` clean under strict config; every import resolves to a real export; runnable ones (basic-node, postgres-outbox, magic-mongodb) execute and produce README-matching output. Dependency versions consistent (redis ^6.0.1 → 6.0.1).
**Notable issues:** No example exercises `decorators`, `mongoose`, `metrics`, or `events`. All `build` scripts are `tsc --noEmit` (no JS emit despite README "build" instructions). Doc drift: nestjs README claims `forRoot()` but the example only uses `forRootAsync()`; redis-distributed README omits the `safety` block the code includes. redis provider/lock use node-redis v6 deprecated flat `PX`/`NX` option shape.

### Tooling (root config, CI/CD)

**Purpose:** Shared TS base config, tsup dual ESM/CJS bundling, vitest, Changesets publishing, two GitHub Actions workflows.
**Strengths:** CI uses safe `pull_request` (not `pull_request_target`); Release is correctly set up for npm provenance (`id-token: write`, `NPM_CONFIG_PROVENANCE`, `--frozen-lockfile`). All 25 packages consistently wired (identical exports shape, `engines node>=24`, type:module, README each). tsup produces correct dual output; CLI shebang preserved. `allowBuilds` uses the correct pnpm 11 key. Node version wiring fully consistent (`.nvmrc` 24).
**Notable issues:** **`exports.require` is missing a `types` condition** (MEDIUM) — CJS type resolution falls back to the ESM `.d.ts` (the `@arethetypeswrong` "masquerading" case); harmless only because the two `.d.ts`/`.d.cts` are currently byte-identical. `lint` is just `tsc --noEmit` (a typecheck alias) and is never run in CI — there is **no ESLint/Biome config anywhere**. Redundant root `vitest.config.ts` overlaps the per-package configs without the core-source alias. Root devDep versions drift below per-package versions. CI push trigger lists a dead `master`. Actions pinned to mutable major tags rather than SHAs.

---

## 4. Cross-Cutting Findings

### Correctness / Concurrency

Two systemic root causes generate most of the high-severity findings:

1. **Writes are never reconciled against concurrent invalidations.** `fetchAndStore` → `writeEntry` (cache.ts:249–367) always writes the fetched value with no "has this key been invalidated since the fetch began" check — no generation token, no delete tombstone. `isStaleVersion` only compares against a value _present_ in the store, so a freshly-deleted key returns `null`, the guard returns `false`, and the stale write proceeds. This produces: **lost invalidation via in-flight fetch** (CRITICAL), **read-repair `backfill` resurrecting invalidated data** (HIGH), and **cross-instance divergence** where an invalidating node stays empty while a serving node re-caches the pre-invalidation value for a full TTL.

2. **The distributed lock provides mutual exclusion but no fencing.** TTL is not renewed during long fetches (locks/src/index.ts:37–56), the handle exposes no fencing token (types.ts:56–58), and `writeEntry` never verifies ownership. A lock expiring mid-fetch yields double-fetch + last-writer-wins clobber (CRITICAL). Because the lock TTL is derived from `query.timeout` (cache.ts:600), fail-fast configs make this routine.

Supporting issues: circuit-breaker flapping (a single success fully closes; interleaved success/failure may never open); `isOpen` is read at three points within one `query()` and its lazy-reset side effect means it can read open early and closed later (non-atomic breaker state); non-atomic tag invalidation (read tag-set → delete keys → drop tag is a TOCTOU that leaks orphans and survives values added mid-invalidation); SWR background refresh keyed separately from foreground fetch can clobber a fresher write; `seenEventIds` FIFO eviction can resurrect a duplicate under reordering; pub/sub at-most-once delivery silently loses invalidations on a momentary disconnect with no reconciliation; `withTimeout` cancels the wait, not the work.

### Security

Overall well-defended; **no critical exploitable vulnerability found.** Serializers are not prototype-pollution-vulnerable (`__proto__` lands as an own property, `Object.prototype` untouched); distributed events use HMAC-SHA256 + `timingSafeEqual` with a length pre-check and canonicalized payload; SQL is fully parameterized with identifier allowlisting; the CLI takes no shell/path input; the dashboard escapes HTML. Hardening gaps: **distributed invalidation is unauthenticated by default** (`verifyIncomingEvent` returns `true` when no `signingSecret` — anyone able to publish to the bus can force arbitrary cross-tenant invalidation; warn once at startup); the **dashboard ships no auth** and exposes operational data; **error events surface raw keys/messages** (document that keys must not contain secrets); the **non-escaped `::` key delimiter** is a theoretical cross-tenant collision if tenant/key is attacker-influenced; `cacheOutboxTableSql` interpolates the (validated) table name for the index name — safe today but fragile.

### Docs-vs-Code accuracy

Excellent for substantive engine claims (cache-aside, tags, mutation invalidation, stampede prevention, fail-open, SWR, distributed invalidation across all transports, magic sync, outbox, CLI, decorators, namespaces/tenants, ORM plugins, circuit breaker all genuinely implemented and matching). The README's competitor matrix footnotes are unusually honest. The only inaccuracies are **observability/metadata features that types or standalone helpers expose but the runtime never wires**: metrics histograms, and audit `actor`/`reason`/`region` + multi-region. `msgpackSerializer` is misleadingly named (it is JSON-over-bytes — the README table is honest).

### Code quality / Consistency

Strong (B+/A−): excellent strictness, clean DAG, smart zero-runtime-dependency adapter design, uniform build tooling, thoughtful comments where they matter. The consistency gaps are concentrated in **shared logic not yet hoisted into core**: `toError` copy-pasted in 6 files; event parse/validate logic reinvented per transport (and inconsistently — only RabbitMQ validates); `MemoryTagIndex`/`LocalTagIndex` duplicated; `onError` signatures and `health()` return shapes diverge; mongoose is the lone `console.warn` offender. The highest-leverage maintainability investment is a **real ESLint config** (none exists); the highest-leverage correctness-consistency step is **centralizing event validation** so kafka/nats/pubsub stop trusting unvalidated JSON.

---

## 5. Prioritized Issue List (verified)

### Critical

| Area              | File                                       | Issue                                                                                                              | One-line fix                                                                                                                                              |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core/concurrency  | cache.ts:249–367                           | Write path never reconciles against concurrent invalidation → lost invalidation, stale served for full TTL         | Add a generation/tombstone fence: record an invalidation epoch per key and have `writeEntry` drop writes whose fetch began before the latest invalidation |
| Locks/concurrency | cache.ts:288–334, locks/src/index.ts:37–56 | Lock has no fencing token and no TTL renewal → double-fetch + last-writer-wins clobber when lock expires mid-fetch | Expose a fencing token on `CacheLockHandle`, verify it in `writeEntry`, and/or renew the lock during long fetches                                         |

### High

| Area        | File                                                  | Issue                                                                                             | One-line fix                                                                                           |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Providers   | packages/memcached/src/index.ts:26                    | Binary/non-UTF8 values corrupted by lossy `TextDecoder`                                           | Base64-encode Uint8Array with a sentinel prefix and decode on read                                     |
| Providers   | packages/memcached/src/index.ts                       | TTL >30 days reinterpreted as absolute epoch → immediate expiry                                   | If `seconds > 2_592_000`, pass `floor(Date.now()/1000)+seconds`                                        |
| Event buses | packages/kafka/src/index.ts:58–87                     | Shared consumer group load-balances instead of fanning out → only one instance invalidates        | Generate a unique per-instance groupId by default (or document the hard requirement)                   |
| Mongo       | packages/mongoose/src/index.ts:13–20                  | `updateMany`/`replaceOne`/`findOneAndDelete`/`bulkWrite`/`$merge` never intercepted → stale cache | Register the missing query hooks (model-tag fallback); document `bulkWrite`/aggregation as unsupported |
| Mongo       | packages/mongodb-streams/src/index.ts:149–230         | Re-watch reuses dead resume token on non-resumable errors → permanent reconnect loop              | Clear `resumeToken` (or use `startAfter`) on non-resumable/invalidate errors                           |
| Concurrency | cache.ts:50–63 (circuit-breaker), :389–404 (backfill) | Breaker flaps / never opens; backfill resurrects invalidated data                                 | Add half-open + failure-rate model; gate backfill behind a post-read invalidation check                |
| Tests       | packages/locks/src/locks.test.ts                      | Lua/eval release path and foreign-token no-op untested (the lock's entire safety property)        | Add a fake with `eval` emulating `RELEASE_SCRIPT` + a compare-mismatch no-op test                      |

### Medium

| Area         | File                                           | Issue                                                                                                            | One-line fix                                                                                                    |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Security     | cache.ts:676–693                               | Distributed invalidation unauthenticated by default                                                              | Warn once at startup when a bus is configured without `signingSecret`; document signing as required             |
| Security     | packages/dashboard/src/index.ts:90–119         | Dashboard ships no auth, exposes ops data                                                                        | Add an optional `authorize?(request)` hook; recommend localhost binding                                         |
| Core support | packages/core/src/circuit-breaker.ts           | No half-open (thundering herd) + consecutive-only trip                                                           | Introduce half-open single-probe + sliding-window/decay failure model                                           |
| Core support | packages/core/src/keys.ts:1–11                 | `::` separator collisions (cross-tenant/poisoning)                                                               | Escape/encode or length-prefix each component; apply to tag-index key builders                                  |
| Core support | packages/core/src/plugin.ts:34–42              | `shutdown` aborts on first rejecting plugin → resource leak                                                      | Wrap each shutdown in try/catch (emit error, continue) or `Promise.allSettled`                                  |
| Core support | packages/core/src/events.ts:16–20              | `emit` doesn't isolate handler throws → drops remaining handlers, corrupts emitting op                           | Wrap each handler call in try/catch                                                                             |
| Providers    | packages/memory/src/index.ts:48,53             | FIFO (not LRU) eviction + O(n log n) per insert                                                                  | Bump recency on get; evict via Map insertion order (O(1))                                                       |
| Providers    | packages/redis/src/index.ts                    | Tag-index writes non-atomic (2N+1 round-trips, divergence window)                                                | Use MULTI/pipeline or a Lua script for all-or-nothing index mutation                                            |
| Providers    | packages/memory/src/index.ts:131, memcached:85 | `removeKeyFromAllScopes` suffix-matches the wrong key when keys contain `::`                                     | Store scope alongside each reverse entry; iterate exact membership                                              |
| Event buses  | packages/rabbitmq/src/index.ts:78,60–79        | Unhandled rejection on throwing handler; never acks good messages                                                | Guard dispatch with `.catch`→`onError`+nack; add `ack` to the interface and call it                             |
| Event buses  | packages/nats/src/index.ts:34–36               | Fire-and-forget publish cannot surface broker outages                                                            | Offer a delivery-confirming (JetStream-style) publish path; inspect RabbitMQ `publish` boolean                  |
| Mongo        | packages/mongodb-streams/src/index.ts          | Function tenant resolver on delete silently invalidates default scope; bare-vs-map token heuristic misclassifies | Require tenant derivable from documentKey on delete (warn otherwise); use an explicit `resumeTokens` map option |
| SQL          | packages/postgres-outbox/src/index.ts:159      | Cache IO runs inside open txn, holding row locks across N round-trips                                            | Adopt claim-then-dispatch (or add per-poll cache timeout + batchSize guidance)                                  |
| SQL          | packages/postgres-outbox/src/index.ts:198      | Commit-failure re-delivery + retry-count lost on rollback                                                        | Per-row txn/savepoint; document at-least-once                                                                   |
| Frameworks   | packages/decorators/src/index.ts:51–56         | `@Cached` without `ttl` is a latent first-call throw                                                             | Document the `defaultTtl` requirement; validate on first cache resolution                                       |
| Testing      | packages/testing/src/index.ts                  | `FakeProvider` omits `tagIndex` → silent `invalidateByTag` no-op                                                 | Implement `CacheTagIndex` on FakeProvider (or document the limitation)                                          |
| Tooling      | packages/\*/package.json                       | `exports.require` missing `types` condition (CJS resolves ESM `.d.ts`)                                           | Nest per-format `types` (`require.types`→`index.d.cts`) across all 25 packages                                  |
| Tests        | postgres-outbox / circuit-breaker / duration   | `setInterval` loop, breaker isolation, and `parseDuration` h/d + validation untested                             | Add `vi.useFakeTimers` plugin-lifecycle tests + dedicated breaker/duration unit suites                          |

### Low / Nit

| Area         | File                                                 | Issue                                                                                                                | One-line fix                                                                            |
| ------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Core support | packages/core/src/duration.ts:18–31                  | String durations can overflow to non-finite/unsafe → poisoned `expiresAt`                                            | Guard with `Number.isSafeInteger` on the result                                         |
| Core support | packages/core/src/serializer.ts                      | Guard accepts structurally-wrong entries (`expiresAt:'soon'`)                                                        | Validate field types; document JSON round-trip limits                                   |
| Core support | packages/core/src/single-flight.ts:4–15              | Hung task wedges the key; coalesced callers share first caller's error/timeout                                       | Wrap `query.fetcher()` in `withTimeout`; document coalescing semantics                  |
| Providers    | packages/redis/src/index.ts:35                       | `PX:0` forwarded (Redis rejects); `health()` throws on non-string ping                                               | Clamp/omit PX for `ttl<=0`; coerce `String(pong)`                                       |
| Providers    | packages/memcached/src/index.ts:33                   | `clear()` silent no-op flush leaves un-invalidatable stale data                                                      | Throw/warn when `client.flush` is absent                                                |
| Event buses  | packages/events/src/index.ts; aws-events:91–97       | `EventDeduper` is unused dead code; aws-events subscribe is bring-your-own with undocumented Detail contract         | Extract/share or mark advisory; document the EventBridge `Detail`→`CacheEvent` contract |
| Mongo        | packages/mongoose/src/index.ts                       | Read-then-set race; insertMany depends on `_id` back-fill; model-resolution throws are silent                        | Document the races; surface model-resolution failures via the runtime error event       |
| SQL          | packages/postgres-outbox/src/index.ts:185,123,292    | Dead-letter silently dropped; no backoff/jitter; `parsePayload` throws on malformed JSON                             | Emit a dead-letter event/count; add backoff+jitter; dead-letter on parse error          |
| SQL          | packages/prisma/src/index.ts:88                      | Id inference misses compound/non-`id` keys and bulk scope                                                            | Document the literal-`id` assumption; recommend explicit `mutate({tags})`               |
| Frameworks   | packages/decorators/src/index.ts:40–47; express:3–12 | Legacy-decorators-only (silent no-op under TS5); Express `Request` not augmented; `CacheSync` stops on first failure | Document `experimentalDecorators`; ship Express augmentation; use `Promise.allSettled`  |
| Testing      | packages/testing/src/index.ts:88                     | Silently discards caller-supplied non-FakeClock                                                                      | Narrow param type to `clock?: FakeClock`                                                |
| Docs         | docs/README.md:5; docs/metrics.md:30                 | Stale 0.1.0 reference; histograms/refresh documented as auto-populated                                               | De-version the README; note histograms require manual `observe()`                       |
| Examples     | examples/nestjs & redis-distributed READMEs          | `forRoot()` claimed but unused; missing `safety` block                                                               | Align READMEs with actual example code                                                  |
| Tooling      | package.json scripts; .github/workflows              | `lint`=typecheck (never run); redundant root vitest config; mutable action tags; dead `master`                       | Add real ESLint to CI (or drop fake `lint`); SHA-pin release actions; remove `master`   |
| Quality      | kafka/nats/rabbitmq/pubsub, memory/memcached         | `toError` ×6, event parse/validate, and in-memory tag index duplicated                                               | Hoist `toError`, `parseCacheEvent`, `isCacheEvent`, and `InMemoryTagIndex` into core    |

---

## 6. Recommendations & Roadmap to 1.0

Ordered by leverage. The first two are non-negotiable for a framework that markets itself on _safe_ invalidation.

1. **Close the write/invalidate reconciliation gap (CRITICAL).** Introduce a per-key invalidation epoch (generation counter or short-lived tombstone). `fetchAndStore` captures the epoch before calling the fetcher; `writeEntry` drops the write if the epoch advanced. This single change fixes the in-flight-fetch race, the backfill resurrection, the SWR-refresh clobber, and the cross-instance divergence — the bulk of the high-severity correctness findings. Add the deterministic test (invalidate-during-fetch asserts the value is gone) modeled on cache.test.ts:675.

2. **Add lock fencing and renewal (CRITICAL).** Expose a fencing token on `CacheLockHandle`, thread it into `writeEntry` ownership checks, and renew the lock TTL during long fetches (or decouple lock TTL from `query.timeout`). Then write the missing lock tests (Lua `eval` path + foreign-token no-op) — currently the safety-critical primitive is the least-tested package.

3. **Fix the memcached contract violations and Kafka fanout (HIGH).** Base64-encode binary values, guard the 30-day TTL boundary, and either auto-generate unique Kafka group ids or document the requirement prominently. These are silent data-loss / silent-stale bugs in advertised backends. Add the memcached binary/TTL regression tests and a Kafka fanout note.

4. **Make magic-sync honest about coverage (HIGH).** Register the missing Mongoose hooks, document the genuinely-unsupported ops (`bulkWrite`, mutating aggregations), and fix the change-stream dead-token re-watch loop with a test that rejects a known-dead token. Wire core's `version` mechanism (or document the read-then-set race) so the "safe" positioning is defensible.

5. **Rework the circuit breaker (MEDIUM, but central to the value prop).** Move from consecutive-failure to a sliding-window/failure-rate model with a real half-open single-probe state. Add isolated breaker unit tests. This makes the breaker actually protect a flaky backend instead of flapping.

6. **Harden the security defaults (MEDIUM).** Warn at startup when a distributed bus runs without `signingSecret`; add the dashboard `authorize?` hook; escape the `::` key delimiter; document that cache keys must not embed secrets. None require deep changes and they collectively make the default posture safe-by-default.

7. **Finish the observability story (MEDIUM).** Either wire `observe()` into the core lock/provider timing paths (and add `cache_refreshes_total`) or update the docs to mark the two histograms and `actor`/`reason`/`region` as manual/userland. Today the docs over-promise on metadata the engine never emits.

8. **Pay down shared-logic duplication and add real linting (quality).** Hoist `toError`, `parseCacheEvent`/`isCacheEvent`, and `InMemoryTagIndex` into core (this also fixes the kafka/nats/pubsub unvalidated-JSON gap and keeps memory/memcached tag indexes in sync). Add ESLint (type-aware) to CI — the single highest-leverage maintainability investment, currently absent.

9. **Tooling/packaging cleanup before publishing 1.0.** Nest `exports.require.types` across all packages (catch with `@arethetypeswrong/cli` in CI), align dev-dependency versions, remove the dead root vitest config and `master` trigger, and SHA-pin release-workflow actions.

10. **Backfill the test gaps and add coverage gates.** Beyond locks/breaker/duration, cover the outbox `setInterval`/plugin lifecycle, `FakeProvider.tagIndex`, and migrate fragile `setTimeout` ordering to the captured-deferred pattern. Coverage thresholds would surface the thin packages automatically.

**Bottom line:** SafeCache is a well-architected, strictly-typed, honestly-documented framework whose engine, docs, and core test suite are above-average for a 0.x project. It is not yet 1.0-ready because the headline "safe invalidation" guarantee has verified holes (items 1–2) and two advertised backends silently break their contracts (item 3). Land items 1–4 with their tests and SafeCache earns its name; items 5–10 are the polish that makes a 1.0 release durable.
