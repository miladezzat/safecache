export type DurationInput =
  | number
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`;

export type CacheVersion = string | number;

export type CacheEventType = "invalidate:key" | "invalidate:tag" | "refresh:key";

export type ConsistencyLevel = "performance" | "balanced" | "strict";

export interface CacheEntry<T = unknown> {
  value: T;
  tags: string[];
  createdAt: number;
  expiresAt: number;
  staleUntil?: number;
  version?: CacheVersion;
}

export interface ProviderHealth {
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface CacheTagIndex {
  addTags(scope: string, key: string, tags: string[], ttlMs: number): Promise<void>;
  getKeysByTag(scope: string, tag: string): Promise<string[]>;
  removeKey(scope: string, key: string, tags?: string[]): Promise<void>;
  removeTag(scope: string, tag: string): Promise<void>;
}

export interface CacheProvider {
  name: string;
  tagIndex?: CacheTagIndex;
  get(key: string): Promise<string | Uint8Array | null>;
  set(key: string, value: string | Uint8Array, options: { ttlMs: number }): Promise<void>;
  delete(key: string): Promise<void>;
  clear?(): Promise<void>;
  health?(): Promise<ProviderHealth>;
}

export interface CacheLayer {
  provider: CacheProvider;
  tagIndex?: CacheTagIndex;
}

export interface CacheSerializer {
  serialize(entry: CacheEntry): string | Uint8Array;
  deserialize<T>(raw: string | Uint8Array): CacheEntry<T>;
}

export interface CacheLockHandle {
  release(): Promise<void>;
}

export interface CacheLock {
  acquire(key: string, ttlMs: number): Promise<CacheLockHandle | null>;
}

export interface CacheEvent {
  id: string;
  type: CacheEventType;
  source: string;
  timestamp: number;
  namespace: string;
  tenant?: string;
  key?: string;
  tag?: string;
}

export interface CacheEventBus {
  publish(event: CacheEvent): Promise<void>;
  subscribe(handler: (event: CacheEvent) => Promise<void>): Promise<() => Promise<void>>;
}

export interface Clock {
  now(): number;
}

export interface CachePluginContext {
  cache: Cache;
  emit(event: CacheRuntimeEvent): void;
}

export interface CachePlugin {
  name: string;
  setup(ctx: CachePluginContext): Promise<void> | void;
  shutdown?(): Promise<void>;
}

export interface CircuitBreakerOptions {
  enabled: boolean;
  failureThreshold: number;
  resetAfter: DurationInput;
}

export interface CacheSafetyOptions {
  failOpen?: boolean;
  timeout?: DurationInput;
  preventStampede?: boolean;
  staleWhileRevalidate?: boolean;
  refreshAhead?: boolean;
  circuitBreaker?: boolean | Partial<CircuitBreakerOptions>;
}

export interface CacheOptions {
  namespace: string;
  provider?: CacheProvider | CacheLayer;
  layers?: Array<CacheProvider | CacheLayer>;
  defaultTtl?: DurationInput;
  serializer?: CacheSerializer;
  safety?: CacheSafetyOptions;
  distributed?: {
    lock?: CacheLock;
    events?: CacheEventBus;
  };
  consistency?: ConsistencyLevel;
  plugins?: CachePlugin[];
  clock?: Clock;
  source?: string;
}

export interface QueryOptions<T> {
  key: string;
  tags?: string[];
  tenant?: string;
  ttl?: DurationInput;
  fetcher: () => Promise<T>;
  staleWhileRevalidate?: boolean | DurationInput;
  refreshAhead?: boolean | DurationInput;
  timeout?: DurationInput;
  lock?: boolean;
  cacheNull?: boolean;
  cacheErrors?: boolean;
  version?: CacheVersion | ((value: T) => CacheVersion | Promise<CacheVersion>);
}

export interface WrapOptions<T> extends Omit<QueryOptions<T>, "key" | "fetcher"> {}

export interface MutateOptions<T> {
  tags?: string[];
  keys?: string[];
  tenant?: string;
  action: () => Promise<T>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  invalidations: number;
  staleServed: number;
  refreshes: number;
  circuitBreakerOpen: boolean;
}

export type CacheRuntimeEventName = "hit" | "miss" | "stale" | "refresh" | "invalidate" | "error";

export type CacheRuntimeEvent =
  | { type: "hit"; key: string; tenant?: string }
  | { type: "miss"; key: string; tenant?: string }
  | { type: "stale"; key: string; tenant?: string }
  | { type: "refresh"; key: string; tenant?: string }
  | { type: "invalidate"; key?: string; tag?: string; tenant?: string }
  | { type: "error"; operation: string; error: Error; key?: string; tenant?: string };

export type CacheRuntimeEventHandler = (event: CacheRuntimeEvent) => void;

export interface Cache {
  query<T>(options: QueryOptions<T>): Promise<T>;
  wrap<T>(key: string, fetcher: () => Promise<T>, options: WrapOptions<T>): Promise<T>;
  mutate<T>(options: MutateOptions<T>): Promise<T>;
  invalidate(key: string, options?: { tenant?: string }): Promise<void>;
  invalidateByTag(tag: string, options?: { tenant?: string }): Promise<void>;
  use(plugin: CachePlugin): void;
  shutdown(): Promise<void>;
  on(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void;
  off(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void;
  stats(): CacheStats;
}
