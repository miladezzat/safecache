import {
  createCache,
  InMemoryTagIndex,
  type Cache,
  type CacheEvent,
  type CacheEventBus,
  type CacheOptions,
  type CacheProvider,
  type CacheTagIndex,
  type Clock,
} from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

export class FakeClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

export class FakeProvider implements CacheProvider {
  readonly name = "fake";
  /**
   * Tag index backing tag-based invalidation. Reusing core's `InMemoryTagIndex`
   * keeps the fake faithful to a real provider: without it, `addTags` would have
   * nowhere to land and `invalidateByTag` would silently resolve to no keys.
   */
  readonly tagIndex: CacheTagIndex = new InMemoryTagIndex();
  private readonly values = new Map<string, { value: string | Uint8Array; expiresAt: number }>();

  constructor(private readonly clock: Clock = new FakeClock()) {}

  async get(key: string): Promise<string | Uint8Array | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.clock.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string | Uint8Array, options: { ttlMs: number }): Promise<void> {
    this.values.set(key, { value, expiresAt: this.clock.now() + options.ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

export class MockEventBus implements CacheEventBus {
  readonly events: CacheEvent[] = [];
  private readonly handlers = new Set<(event: CacheEvent) => Promise<void>>();

  async publish(event: CacheEvent): Promise<void> {
    this.events.push(event);
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  async subscribe(handler: (event: CacheEvent) => Promise<void>): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return async () => {
      this.handlers.delete(handler);
    };
  }
}

export interface TestCache {
  cache: Cache;
  clock: FakeClock;
}

/**
 * Options for {@link createTestCache}. The `clock` is narrowed to {@link FakeClock}
 * (rather than the broader `Clock`) so that a caller-supplied clock is always the
 * deterministic one returned in {@link TestCache.clock}; a non-fake `Clock` would
 * otherwise be silently discarded.
 */
export interface TestCacheOptions extends Omit<Partial<CacheOptions>, "clock"> {
  clock?: FakeClock;
}

export function createTestCache(options: TestCacheOptions = {}): TestCache {
  const clock = options.clock ?? new FakeClock();
  const cache = createCache({
    namespace: "test",
    defaultTtl: "1m",
    ...options,
    clock,
    provider: options.provider ?? memoryProvider({ clock }),
  });

  return { cache, clock };
}
