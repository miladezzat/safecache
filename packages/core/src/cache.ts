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
    this.pluginRegistry = new PluginRegistry(this, (event) => this.emit(event));
    this.subscribeToDistributedEvents();
    for (const plugin of options.plugins ?? []) {
      this.use(plugin);
    }
  }

  async query<T>(query: QueryOptions<T>): Promise<T> {
    const ttlMs = this.resolveTtl(query);
    const scopedKey = scopeKey(this.options.namespace, query.key, query.tenant);
    const read = await this.readLayers<T>(query, scopedKey);

    if (read.state === "hit") {
      this.counters.hits += 1;
      this.emit({ type: "hit", key: query.key, tenant: query.tenant });
      await this.backfill(read, scopedKey);
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

  private async invalidateKeyInternal(
    key: string,
    options: { tenant?: string } = {},
    publish: boolean,
  ): Promise<void> {
    const scopedKey = scopeKey(this.options.namespace, key, options.tenant);
    await this.deleteScopedKey(scopedKey);
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
      await this.deleteScopedKey(key);
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
    const value = await query.fetcher();
    if ((value === null && query.cacheNull !== true) || value === undefined) {
      return value;
    }

    const version = await resolveVersion(query.version, value);
    const entry: CacheEntry<T> = {
      value,
      tags: query.tags ?? [],
      createdAt: this.clock.now(),
      expiresAt: this.clock.now() + ttlMs,
      staleUntil: this.resolveStaleUntil(query, ttlMs),
      ...(version === undefined ? {} : { version }),
    };

    await this.writeEntry(scopedKey, entry, ttlMs, query.tenant);
    return value;
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

    let handle: CacheLockHandle | null;
    try {
      handle = await this.withTimeout(
        () => lock.acquire(scopedKey, this.resolveLockTtl(query)),
        query.timeout,
      );
    } catch (error) {
      this.recordError("lock", error, query.key, query.tenant);
      if (!this.failOpen) {
        throw error;
      }
      return this.fetchAndStore(query, scopedKey, ttlMs);
    }

    if (handle) {
      try {
        return await this.fetchAndStore(query, scopedKey, ttlMs);
      } finally {
        await this.releaseLock(handle, query);
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
    tenant?: string,
  ): Promise<void> {
    let raw: string | Uint8Array;
    try {
      raw = this.serializer.serialize(entry);
    } catch (error) {
      this.recordError("serialize", error, scopedKey, tenant);
      if (!this.failOpen) {
        throw error;
      }
      return;
    }

    for (const layer of this.layers) {
      if (await this.isStaleVersion(layer.provider, scopedKey, entry.version)) {
        continue;
      }
      await this.safeProviderWrite(layer.provider, scopedKey, raw, ttlMs);
      await this.safeTagIndexOperation("addTags", () =>
        layer.tagIndex?.addTags(
          scopePrefix(this.options.namespace, tenant),
          scopedKey,
          entry.tags,
          ttlMs,
        ),
      );
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

  private async backfill<T>(read: ReadResult<T>, scopedKey: string): Promise<void> {
    if (read.state === "miss" || read.layerIndex === 0) {
      return;
    }
    const ttlMs = Math.max(0, read.entry.expiresAt - this.clock.now());
    if (ttlMs === 0) {
      return;
    }
    const raw = this.serializer.serialize(read.entry);
    for (let index = 0; index < read.layerIndex; index += 1) {
      const layer = this.layers[index];
      if (layer) {
        await this.safeProviderWrite(layer.provider, scopedKey, raw, ttlMs);
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
    void this.fetchAndStore(query, scopedKey, ttlMs)
      .then(() => {
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
    }
  }

  private async safeProviderWrite(
    provider: CacheProvider,
    scopedKey: string,
    raw: string | Uint8Array,
    ttlMs: number,
  ): Promise<void> {
    if (this.circuitBreaker.isOpen) {
      return;
    }
    try {
      await this.withTimeout(() => provider.set(scopedKey, raw, { ttlMs }));
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.recordError("set", error, scopedKey);
      if (!this.failOpen) {
        throw error;
      }
    }
  }

  private async deleteScopedKey(scopedKey: string): Promise<void> {
    for (const layer of this.layers) {
      try {
        await this.withTimeout(() => layer.provider.delete(scopedKey));
      } catch (error) {
        this.recordError("delete", error, scopedKey);
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
    const deadline = Date.now() + this.resolveLockTtl(query);
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

  private resolveLockTtl<T>(query: QueryOptions<T>): number {
    return query.timeout ? parseDuration(query.timeout, "timeout") : DEFAULT_LOCK_TTL_MS;
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
        if (this.hasSeenEvent(event.id)) {
          return;
        }
        if (event.type === "invalidate:key" && event.key) {
          await this.invalidateKeyInternal(event.key, { tenant: event.tenant }, false);
        }
        if (event.type === "invalidate:tag" && event.tag) {
          await this.invalidateTagInternal(event.tag, { tenant: event.tenant }, false);
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
      await bus.publish({
        id: `${this.source}:${this.clock.now()}:${this.eventCounter++}`,
        source: this.source,
        timestamp: this.clock.now(),
        namespace: this.options.namespace,
        ...event,
      });
    } catch (error) {
      this.recordError("publish", error);
    }
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
