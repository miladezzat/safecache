import { createHmac, timingSafeEqual } from "node:crypto";
import { CircuitBreaker } from "./circuit-breaker";
import { parseDuration } from "./duration";
import { RuntimeEvents } from "./events";
import { scopeKey, scopePrefix } from "./keys";
import { PluginRegistry } from "./plugin";
import { jsonSerializer } from "./serializer";
import { SingleFlight } from "./single-flight";
import type {
  Cache,
  CacheEntry,
  CacheEvent,
  CacheLayer,
  CacheLockHandle,
  CacheOptions,
  CachePlugin,
  CacheProvider,
  CacheRuntimeEvent,
  CacheRuntimeEventHandler,
  CacheRuntimeEventName,
  CacheStats,
  CacheVersion,
  Clock,
  MutateOptions,
  QueryOptions,
  WrapOptions,
} from "./types";

type ReadResult<T> =
  | { state: "hit"; entry: CacheEntry<T>; layerIndex: number }
  | { state: "stale"; entry: CacheEntry<T>; layerIndex: number }
  | { state: "miss" };

const systemClock: Clock = {
  now: () => Date.now(),
};

const DEFAULT_LOCK_TTL_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 10;
// Bound the invalidation-epoch map so a long-lived process tracking many distinct
// keys cannot grow it without limit; the oldest entries are evicted past this size.
const MAX_INVALIDATION_EPOCHS = 5_000;

export function createCache(options: CacheOptions): Cache {
  return new SafeCache(options);
}

class SafeCache implements Cache {
  private readonly layers: CacheLayer[];
  private readonly serializer;
  private readonly clock;
  private readonly events;
  private readonly singleFlight;
  private readonly circuitBreaker;
  private readonly pluginRegistry;
  private readonly source: string;
  private readonly seenEventIds = new Set<string>();
  private readonly unsubscribers: Array<() => Promise<void>> = [];
  private eventCounter = 0;
  // Monotonic counter stamped onto each invalidation. fetchAndStore/backfill capture
  // the current epoch for a key before they read/fetch and re-check it before (and
  // after) writing, so a write that races a concurrent invalidation is fenced out
  // instead of resurrecting data the invalidation just removed (the headline bug).
  private epochCounter = 0;
  private readonly invalidationEpochs = new Map<string, number>();
  private readonly counters: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    invalidations: 0,
    staleServed: 0,
    refreshes: 0,
    circuitBreakerOpen: false,
  };

  constructor(private readonly options: CacheOptions) {
    this.serializer = options.serializer ?? jsonSerializer();
    this.clock = options.clock ?? systemClock;
    this.events = new RuntimeEvents();
    this.singleFlight = new SingleFlight();
    this.circuitBreaker = new CircuitBreaker(options.safety, this.clock);
    this.source = options.source ?? `safecache-${Math.random().toString(36).slice(2)}`;
    this.layers = normalizeLayers(options);
    // Register the user's error notifier first so it observes every cache-side
    // failure, including any raised during plugin setup / subscription below.
    if (options.onError) {
      this.events.on("error", options.onError as CacheRuntimeEventHandler);
    }
    this.pluginRegistry = new PluginRegistry(this, (event) => this.emit(event));
    this.subscribeToDistributedEvents();
    for (const plugin of options.plugins ?? []) {
      this.use(plugin);
    }
  }

  async query<T>(query: QueryOptions<T>): Promise<T> {
    const ttlMs = this.resolveTtl(query);
    const scopedKey = scopeKey(this.options.namespace, query.key, query.tenant);
    // Capture the epoch BEFORE the read so a backfill cannot resurrect a key that
    // is invalidated between the read and the backfill write.
    const epoch = this.currentEpoch(scopedKey);
    const read = await this.readLayers<T>(query, scopedKey);

    if (read.state === "hit") {
      this.counters.hits += 1;
      this.emit({ type: "hit", key: query.key, tenant: query.tenant });
      await this.backfill(read, scopedKey, epoch, query.key, query.tenant);
      this.refreshAheadIfNeeded(query, scopedKey, read.entry, ttlMs);
      return read.entry.value;
    }

    if (read.state === "stale" && this.canServeStale(query)) {
      this.counters.staleServed += 1;
      this.emit({ type: "stale", key: query.key, tenant: query.tenant });
      this.refreshInBackground(query, scopedKey, ttlMs);
      return read.entry.value;
    }

    this.counters.misses += 1;
    this.emit({ type: "miss", key: query.key, tenant: query.tenant });

    const load = () => this.fetchAndStoreWithDistributedLock(query, scopedKey, ttlMs);
    if (this.options.safety?.preventStampede ?? true) {
      return this.singleFlight.run(scopedKey, load);
    }
    return load();
  }

  wrap<T>(key: string, fetcher: () => Promise<T>, options: WrapOptions<T>): Promise<T> {
    return this.query({ ...options, key, fetcher });
  }

  async mutate<T>(options: MutateOptions<T>): Promise<T> {
    const result = await options.action();
    for (const key of options.keys ?? []) {
      await this.invalidate(key, { tenant: options.tenant });
    }
    for (const tag of options.tags ?? []) {
      await this.invalidateByTag(tag, { tenant: options.tenant });
    }
    return result;
  }

  async invalidate(key: string, options: { tenant?: string } = {}): Promise<void> {
    await this.invalidateKeyInternal(key, options, true);
  }

  async invalidateByTag(tag: string, options: { tenant?: string } = {}): Promise<void> {
    await this.invalidateTagInternal(tag, options, true);
  }

  use(plugin: CachePlugin): void {
    this.pluginRegistry.use(plugin);
  }

  async shutdown(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      await unsubscribe();
    }
    await this.pluginRegistry.shutdown();
  }

  on(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void {
    this.events.on(name, handler);
  }

  off(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void {
    this.events.off(name, handler);
  }

  stats(): CacheStats {
    return { ...this.counters, circuitBreakerOpen: this.circuitBreaker.isOpen };
  }

  /** Latest invalidation epoch observed for `scopedKey` (0 if never invalidated). */
  private currentEpoch(scopedKey: string): number {
    return this.invalidationEpochs.get(scopedKey) ?? 0;
  }

  /**
   * Stamp a fresh epoch onto `scopedKey`, fencing out any in-flight write that
   * captured an earlier epoch. The map is bounded: once it exceeds
   * MAX_INVALIDATION_EPOCHS the oldest insertions are evicted (Map preserves
   * insertion order, so the iterator yields oldest-first).
   */
  private bumpEpoch(scopedKey: string): void {
    this.invalidationEpochs.set(scopedKey, ++this.epochCounter);
    if (this.invalidationEpochs.size > MAX_INVALIDATION_EPOCHS) {
      const overflow = this.invalidationEpochs.size - MAX_INVALIDATION_EPOCHS;
      let removed = 0;
      for (const oldest of this.invalidationEpochs.keys()) {
        this.invalidationEpochs.delete(oldest);
        removed += 1;
        if (removed >= overflow) {
          break;
        }
      }
    }
  }

  private async invalidateKeyInternal(
    key: string,
    options: { tenant?: string } = {},
    publish: boolean,
  ): Promise<void> {
    const scopedKey = scopeKey(this.options.namespace, key, options.tenant);
    // Fence first: any write that already captured an older epoch for this key will
    // now abort (or compensate) instead of resurrecting the value we are deleting.
    this.bumpEpoch(scopedKey);
    await this.deleteScopedKey(scopedKey, key, options.tenant);
    for (const layer of this.layers) {
      await this.safeTagIndexOperation("removeKey", () =>
        layer.tagIndex?.removeKey(scopePrefix(this.options.namespace, options.tenant), scopedKey),
      );
    }
    this.counters.invalidations += 1;
    this.emit({ type: "invalidate", key, tenant: options.tenant });
    if (publish) {
      await this.publishDistributedEvent({
        type: "invalidate:key",
        key,
        tenant: options.tenant,
      });
    }
  }

  private async invalidateTagInternal(
    tag: string,
    options: { tenant?: string } = {},
    publish: boolean,
  ): Promise<void> {
    const scope = scopePrefix(this.options.namespace, options.tenant);
    // Best-effort, bounded TOCTOU: the key set is snapshotted from the tag index
    // here; a write that adds a brand-new key under `tag` AFTER this read but before
    // we delete will not be caught by this pass. That residual race is acceptable —
    // such a write either captured a pre-bump epoch (and is fenced by FIX-1) or is a
    // genuinely newer value the invalidation never intended to remove.
    const keys = new Set<string>();
    for (const layer of this.layers) {
      const indexedKeys = await this.safeTagIndexRead(() =>
        layer.tagIndex?.getKeysByTag(scope, tag),
      );
      for (const key of indexedKeys) {
        keys.add(key);
      }
    }

    for (const key of keys) {
      // Fence every scoped key the tag resolved to so an in-flight write racing this
      // tag invalidation cannot re-store any of the affected entries.
      this.bumpEpoch(key);
      await this.deleteScopedKey(key, undefined, options.tenant);
    }
    for (const layer of this.layers) {
      await this.safeTagIndexOperation("removeTag", () => layer.tagIndex?.removeTag(scope, tag));
    }
    this.counters.invalidations += 1;
    this.emit({ type: "invalidate", tag, tenant: options.tenant });
    if (publish) {
      await this.publishDistributedEvent({
        type: "invalidate:tag",
        tag,
        tenant: options.tenant,
      });
    }
  }

  private async readLayers<T>(query: QueryOptions<T>, scopedKey: string): Promise<ReadResult<T>> {
    if (this.circuitBreaker.isOpen) {
      return { state: "miss" };
    }

    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index];
      if (!layer) {
        continue;
      }
      const raw = await this.safeProviderRead(layer.provider, scopedKey, query);
      if (raw === null) {
        continue;
      }

      try {
        const entry = this.serializer.deserialize<T>(raw);
        const now = this.clock.now();
        if (entry.expiresAt > now) {
          return { state: "hit", entry, layerIndex: index };
        }
        if (entry.staleUntil && entry.staleUntil > now) {
          return { state: "stale", entry, layerIndex: index };
        }
      } catch (error) {
        this.recordError("deserialize", error, query.key, query.tenant);
        if (!this.failOpen) {
          throw error;
        }
      }
    }

    return { state: "miss" };
  }

  private async fetchAndStore<T>(
    query: QueryOptions<T>,
    scopedKey: string,
    ttlMs: number,
  ): Promise<T> {
    // Capture the invalidation epoch the instant BEFORE the origin fetch begins.
    // Every fetchAndStore call site (foreground, lock holder, background refresh,
    // refresh-ahead) flows through here, so this single capture fences them all: a
    // concurrent invalidate()/invalidateByTag() that lands while the fetcher runs
    // (or while writeEntry awaits) bumps the epoch and the write is dropped.
    const epochAtStart = this.currentEpoch(scopedKey);
    const value = await query.fetcher();
    if ((value === null && query.cacheNull !== true) || value === undefined) {
      return value;
    }

    const version = await resolveVersion(query.version, value);
    const now = this.clock.now();
    const staleUntil = this.resolveStaleUntil(query, ttlMs);
    const entry: CacheEntry<T> = {
      value,
      tags: query.tags ?? [],
      createdAt: now,
      expiresAt: now + ttlMs,
      staleUntil,
      ...(version === undefined ? {} : { version }),
    };

    // Persist a physical lifetime that covers the stale-while-revalidate window so
    // TTL-honoring stores (Redis/Valkey/Memcached) do not evict the key before the
    // logical stale window elapses. Logical hit/stale/miss classification still uses
    // expiresAt/staleUntil inside the entry. Non-SWR behavior is unchanged.
    const physicalTtlMs = this.resolvePhysicalTtl(now, ttlMs, staleUntil);

    await this.writeEntry(scopedKey, entry, physicalTtlMs, query.tenant, epochAtStart, query.key);
    return value;
  }

  private resolvePhysicalTtl(now: number, ttlMs: number, staleUntil: number | undefined): number {
    if (staleUntil === undefined) {
      return ttlMs;
    }
    return Math.max(ttlMs, staleUntil - now);
  }

  private async fetchAndStoreWithDistributedLock<T>(
    query: QueryOptions<T>,
    scopedKey: string,
    ttlMs: number,
  ): Promise<T> {
    const lock = this.options.distributed?.lock;
    const shouldUseLock = query.lock ?? Boolean(lock);
    if (!shouldUseLock || !lock) {
      return this.fetchAndStore(query, scopedKey, ttlMs);
    }

    const lockTtl = this.resolveLockTtl();
    let handle: CacheLockHandle | null;
    const acquireStart = this.clock.now();
    try {
      handle = await this.withTimeout(() => lock.acquire(scopedKey, lockTtl), query.timeout);
    } catch (error) {
      this.recordError("lock", error, query.key, query.tenant);
      if (!this.failOpen) {
        throw error;
      }
      return this.fetchAndStore(query, scopedKey, ttlMs);
    } finally {
      this.emit({
        type: "lock_wait",
        key: query.key,
        durationMs: this.clock.now() - acquireStart,
        tenant: query.tenant,
      });
    }

    if (handle) {
      const acquired = handle;
      // Keep the lock alive for as long as we hold it: a slow origin fetch must not
      // let the lock TTL lapse and admit a second holder. Renew at half the TTL.
      const renewIntervalMs = Math.max(1000, Math.floor(lockTtl / 2));
      const renewTimer = setInterval(() => {
        void acquired.renew(lockTtl).then(
          (stillHeld) => {
            if (!stillHeld) {
              this.recordError(
                "lock:renew",
                new Error("lock renewal reported the lock is no longer held"),
                query.key,
                query.tenant,
              );
            }
          },
          (error: unknown) => this.recordError("lock:renew", error, query.key, query.tenant),
        );
      }, renewIntervalMs);
      // Do not keep the event loop alive solely for the renewal timer.
      renewTimer.unref();
      try {
        // Another process may have populated the cache between our initial read and
        // acquiring the lock. Re-check the layers before hitting the origin so the
        // lock holder also benefits from a peer's freshly stored value.
        const recheck = await this.readLayers<T>(query, scopedKey);
        if (recheck.state === "hit" || (recheck.state === "stale" && this.canServeStale(query))) {
          return recheck.entry.value;
        }
        return await this.fetchAndStore(query, scopedKey, ttlMs);
      } finally {
        clearInterval(renewTimer);
        await this.releaseLock(acquired, query);
      }
    }

    const peerRead = await this.waitForPeerRefresh<T>(query, scopedKey);
    if (peerRead.state === "hit" || (peerRead.state === "stale" && this.canServeStale(query))) {
      return peerRead.entry.value;
    }

    return this.fetchAndStore(query, scopedKey, ttlMs);
  }

  private async writeEntry<T>(
    scopedKey: string,
    entry: CacheEntry<T>,
    ttlMs: number,
    tenant: string | undefined,
    epochAtStart: number,
    logicalKey?: string,
  ): Promise<void> {
    // Fence the whole write against a concurrent invalidation: if an invalidation
    // landed between the epoch capture (before the fetch) and now, drop the write
    // entirely so we never re-store data that was just invalidated.
    if (this.currentEpoch(scopedKey) !== epochAtStart) {
      return;
    }

    let raw: string | Uint8Array;
    try {
      raw = this.serializer.serialize(entry);
    } catch (error) {
      this.recordError("serialize", error, logicalKey ?? scopedKey, tenant);
      if (!this.failOpen) {
        throw error;
      }
      return;
    }

    for (const layer of this.layers) {
      // Re-check before each layer: an invalidation can land mid-loop too.
      if (this.currentEpoch(scopedKey) !== epochAtStart) {
        return;
      }
      if (await this.isStaleVersion(layer.provider, scopedKey, entry.version)) {
        continue;
      }
      await this.safeProviderWrite(layer.provider, scopedKey, raw, ttlMs, logicalKey, tenant);
      await this.safeTagIndexOperation("addTags", () =>
        layer.tagIndex?.addTags(
          scopePrefix(this.options.namespace, tenant),
          scopedKey,
          entry.tags,
          ttlMs,
        ),
      );
    }

    // Re-check AFTER all provider.set calls: an invalidation may have landed during
    // the write's awaits and already deleted the (now superseded) old value before
    // our set completed, leaving our fresh-but-stale value behind. Compensate by
    // deleting what we just wrote so the invalidation wins.
    if (this.currentEpoch(scopedKey) !== epochAtStart) {
      await this.deleteScopedKey(scopedKey, logicalKey, tenant);
    }
  }

  private async isStaleVersion(
    provider: CacheProvider,
    scopedKey: string,
    nextVersion: CacheVersion | undefined,
  ): Promise<boolean> {
    if (nextVersion === undefined || this.circuitBreaker.isOpen) {
      return false;
    }
    try {
      const raw = await provider.get(scopedKey);
      if (raw === null) {
        return false;
      }
      const current = this.serializer.deserialize(raw);
      return compareVersions(nextVersion, current.version) < 0;
    } catch {
      return false;
    }
  }

  private async backfill<T>(
    read: ReadResult<T>,
    scopedKey: string,
    epoch: number,
    logicalKey?: string,
    tenant?: string,
  ): Promise<void> {
    if (read.state === "miss" || read.layerIndex === 0) {
      return;
    }
    const ttlMs = Math.max(0, read.entry.expiresAt - this.clock.now());
    if (ttlMs === 0) {
      return;
    }
    // Fence: if the key was invalidated between the read and now, do not re-warm the
    // upper layers with the value the invalidation just removed.
    if (this.currentEpoch(scopedKey) !== epoch) {
      return;
    }
    const raw = this.serializer.serialize(read.entry);
    for (let index = 0; index < read.layerIndex; index += 1) {
      const layer = this.layers[index];
      if (layer) {
        await this.safeProviderWrite(layer.provider, scopedKey, raw, ttlMs, logicalKey, tenant);
      }
    }
  }

  private refreshAheadIfNeeded<T>(
    query: QueryOptions<T>,
    scopedKey: string,
    entry: CacheEntry<T>,
    ttlMs: number,
  ): void {
    if (!query.refreshAhead && !this.options.safety?.refreshAhead) {
      return;
    }
    const remaining = entry.expiresAt - this.clock.now();
    const threshold =
      typeof query.refreshAhead === "string" || typeof query.refreshAhead === "number"
        ? parseDuration(query.refreshAhead)
        : ttlMs / 2;
    if (remaining <= threshold) {
      this.refreshInBackground(query, scopedKey, ttlMs);
    }
  }

  private refreshInBackground<T>(query: QueryOptions<T>, scopedKey: string, ttlMs: number): void {
    // Coalesce background refreshes for a hot key so SWR + refresh-ahead never spawn
    // an unbounded number of concurrent origin fetches. A distinct key keeps the
    // background refresh independent of any foreground single-flight on the same key,
    // and the bookkeeping lives inside the task so it runs exactly once per real fetch.
    void this.singleFlight
      .run(`refresh:${scopedKey}`, async () => {
        await this.fetchAndStore(query, scopedKey, ttlMs);
        this.counters.refreshes += 1;
        this.emit({ type: "refresh", key: query.key, tenant: query.tenant });
      })
      .catch((error: unknown) => this.recordError("refresh", error, query.key, query.tenant));
  }

  private canServeStale<T>(query: QueryOptions<T>): boolean {
    if (this.options.consistency === "strict") {
      return false;
    }
    return Boolean(query.staleWhileRevalidate ?? this.options.safety?.staleWhileRevalidate);
  }

  private resolveStaleUntil<T>(query: QueryOptions<T>, ttlMs: number): number | undefined {
    const stale = query.staleWhileRevalidate;
    if (!stale) {
      return undefined;
    }
    const staleMs = stale === true ? ttlMs : parseDuration(stale, "staleWhileRevalidate");
    return this.clock.now() + ttlMs + staleMs;
  }

  private resolveTtl<T>(query: QueryOptions<T>): number {
    const ttl = query.ttl ?? this.options.defaultTtl;
    if (ttl === undefined) {
      throw new Error("query() requires ttl unless defaultTtl is configured");
    }
    return parseDuration(ttl, "ttl");
  }

  private async safeProviderRead<T>(
    provider: CacheProvider,
    scopedKey: string,
    query: QueryOptions<T>,
  ): Promise<string | Uint8Array | null> {
    const start = this.clock.now();
    try {
      const value = await this.withTimeout(() => provider.get(scopedKey), query.timeout);
      this.circuitBreaker.recordSuccess();
      return value;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.recordError("get", error, query.key, query.tenant);
      if (!this.failOpen) {
        throw error;
      }
      return null;
    } finally {
      this.emit({
        type: "provider_latency",
        layer: provider.name,
        op: "get",
        durationMs: this.clock.now() - start,
        key: query.key,
        tenant: query.tenant,
      });
    }
  }

  private async safeProviderWrite(
    provider: CacheProvider,
    scopedKey: string,
    raw: string | Uint8Array,
    ttlMs: number,
    logicalKey?: string,
    tenant?: string,
  ): Promise<void> {
    if (this.circuitBreaker.isOpen) {
      return;
    }
    const start = this.clock.now();
    try {
      await this.withTimeout(() => provider.set(scopedKey, raw, { ttlMs }));
    } catch (error) {
      this.circuitBreaker.recordFailure();
      // Prefer the logical key + tenant so error consumers see the same identity
      // they queried; fall back to the scoped key only when the logical one is
      // out of scope (e.g. backfill paths without a query in hand).
      this.recordError("set", error, logicalKey ?? scopedKey, tenant);
      if (!this.failOpen) {
        throw error;
      }
    } finally {
      this.emit({
        type: "provider_latency",
        layer: provider.name,
        op: "set",
        durationMs: this.clock.now() - start,
        key: logicalKey ?? scopedKey,
        tenant,
      });
    }
  }

  private async deleteScopedKey(
    scopedKey: string,
    logicalKey?: string,
    tenant?: string,
  ): Promise<void> {
    for (const layer of this.layers) {
      const start = this.clock.now();
      try {
        await this.withTimeout(() => layer.provider.delete(scopedKey));
      } catch (error) {
        this.recordError("delete", error, logicalKey ?? scopedKey, tenant);
      } finally {
        this.emit({
          type: "provider_latency",
          layer: layer.provider.name,
          op: "delete",
          durationMs: this.clock.now() - start,
          key: logicalKey ?? scopedKey,
          tenant,
        });
      }
    }
  }

  private async safeTagIndexRead(task: () => Promise<string[]> | undefined): Promise<string[]> {
    try {
      return (await task()) ?? [];
    } catch (error) {
      this.recordError("tagIndex", error);
      return [];
    }
  }

  private async safeTagIndexOperation(
    operation: string,
    task: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.recordError(operation, error);
    }
  }

  /**
   * Race `task` against a timeout. NOTE: a timed-out op is abandoned, not
   * cancelled — the underlying provider call (e.g. a slow set) may still complete
   * later and land its write. That late write can no longer resurrect invalidated
   * data, because the FIX-1 epoch fence in writeEntry re-checks the invalidation
   * epoch and compensates (deletes) when an invalidation raced the write.
   */
  private async withTimeout<T>(
    task: () => Promise<T>,
    timeout = this.options.safety?.timeout,
  ): Promise<T> {
    if (!timeout) {
      return task();
    }
    const timeoutMs = parseDuration(timeout, "timeout");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Cache operation timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private recordError(operation: string, error: unknown, key?: string, tenant?: string): void {
    this.counters.errors += 1;
    this.emit({
      type: "error",
      operation,
      error: error instanceof Error ? error : new Error(String(error)),
      key,
      tenant,
    });
  }

  private emit(event: CacheRuntimeEvent): void {
    this.events.emit(event);
  }

  private async waitForPeerRefresh<T>(
    query: QueryOptions<T>,
    scopedKey: string,
  ): Promise<ReadResult<T>> {
    const deadline = Date.now() + this.resolveLockTtl();
    while (Date.now() < deadline) {
      await delay(LOCK_POLL_INTERVAL_MS);
      const read = await this.readLayers<T>(query, scopedKey);
      if (read.state === "hit" || (read.state === "stale" && this.canServeStale(query))) {
        return read;
      }
    }
    return { state: "miss" };
  }

  private async releaseLock<T>(handle: CacheLockHandle, query: QueryOptions<T>): Promise<void> {
    try {
      await handle.release();
    } catch (error) {
      this.recordError("lock:release", error, query.key, query.tenant);
      if (!this.failOpen) {
        throw error;
      }
    }
  }

  private resolveLockTtl(): number {
    // Lock TTL is decoupled from query.timeout: a per-request timeout governs how
    // long we wait on a single provider op, whereas the lock must live long enough
    // for the holder to finish fetching+storing regardless of any read timeout.
    const configured = this.options.safety?.lockTtl;
    return configured ? parseDuration(configured, "lockTtl") : DEFAULT_LOCK_TTL_MS;
  }

  private get failOpen(): boolean {
    return this.options.safety?.failOpen ?? true;
  }

  private subscribeToDistributedEvents(): void {
    const bus = this.options.distributed?.events;
    if (!bus) {
      return;
    }
    void bus
      .subscribe(async (event) => {
        if (event.namespace !== this.options.namespace || event.source === this.source) {
          return;
        }
        if (!this.verifyIncomingEvent(event)) {
          return;
        }
        if (this.hasSeenEvent(event.id)) {
          return;
        }
        const tenant = typeof event.tenant === "string" ? event.tenant : undefined;
        if (event.type === "invalidate:key" && typeof event.key === "string") {
          await this.invalidateKeyInternal(event.key, { tenant }, false);
        }
        if (event.type === "invalidate:tag" && typeof event.tag === "string") {
          await this.invalidateTagInternal(event.tag, { tenant }, false);
        }
      })
      .then((unsubscribe) => this.unsubscribers.push(unsubscribe))
      .catch((error: unknown) => this.recordError("subscribe", error));
  }

  private hasSeenEvent(id: string): boolean {
    if (this.seenEventIds.has(id)) {
      return true;
    }
    this.seenEventIds.add(id);
    // Bounded best-effort dedup: we keep only the most recent ~1000 ids and evict the
    // oldest. A duplicate that arrives after its id has aged out will be re-processed,
    // but invalidation is idempotent so the worst case is a redundant invalidate.
    if (this.seenEventIds.size > 1_000) {
      const first = this.seenEventIds.values().next().value;
      if (first) {
        this.seenEventIds.delete(first);
      }
    }
    return false;
  }

  private async publishDistributedEvent(
    event:
      | { type: "invalidate:key"; key: string; tenant?: string }
      | { type: "invalidate:tag"; tag: string; tenant?: string },
  ): Promise<void> {
    const bus = this.options.distributed?.events;
    if (!bus) {
      return;
    }
    try {
      const payload: CacheEvent = {
        id: `${this.source}:${this.clock.now()}:${this.eventCounter++}`,
        source: this.source,
        timestamp: this.clock.now(),
        namespace: this.options.namespace,
        ...event,
      };
      const secret = this.options.distributed?.signingSecret;
      if (secret) {
        payload.signature = signEvent(payload, secret);
      }
      await bus.publish(payload);
    } catch (error) {
      this.recordError("publish", error);
    }
  }

  private verifyIncomingEvent(event: CacheEvent): boolean {
    const secret = this.options.distributed?.signingSecret;
    if (!secret) {
      return true;
    }
    const expected = signEvent(event, secret);
    const provided = event.signature;
    if (typeof provided !== "string" || provided.length !== expected.length) {
      this.recordError("event:signature", new Error("missing or malformed event signature"));
      return false;
    }
    const matches = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!matches) {
      this.recordError("event:signature", new Error("invalid event signature"));
      return false;
    }
    return true;
  }
}

function normalizeLayers(options: CacheOptions): CacheLayer[] {
  const configured = options.layers ?? (options.provider ? [options.provider] : []);
  if (configured.length === 0) {
    throw new Error("createCache requires provider or layers");
  }
  return configured.map((layer) => {
    if ("provider" in layer) {
      return { provider: layer.provider, tagIndex: layer.tagIndex ?? layer.provider.tagIndex };
    }
    return { provider: layer, tagIndex: layer.tagIndex };
  });
}

async function resolveVersion<T>(
  version: QueryOptions<T>["version"],
  value: T,
): Promise<CacheVersion | undefined> {
  if (typeof version === "function") {
    return version(value);
  }
  return version;
}

function compareVersions(next: CacheVersion, current: CacheVersion | undefined): number {
  if (current === undefined) {
    return 1;
  }
  if (typeof next === "number" && typeof current === "number") {
    return next - current;
  }
  return String(next).localeCompare(String(current));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signEvent(event: CacheEvent, secret: string): string {
  return createHmac("sha256", secret).update(canonicalizeEvent(event)).digest("hex");
}

/**
 * Deterministic serialization of an event for signing/verification. The signature
 * field is excluded and keys are emitted in a stable order so both sides agree on
 * the exact bytes regardless of property insertion order across the bus.
 */
function canonicalizeEvent(event: CacheEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(record).sort()) {
    if (key === "signature") {
      continue;
    }
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    entries.push([key, value]);
  }
  return JSON.stringify(entries);
}
