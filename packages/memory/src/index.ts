import {
  InMemoryTagIndex,
  parseDuration,
  type CacheProvider,
  type CacheTagIndex,
  type Clock,
  type DurationInput,
} from "@safecache/core";

export interface MemoryProviderOptions {
  maxEntries?: number;
  ttl?: DurationInput;
  clock?: Clock;
}

export interface MemoryProvider extends CacheProvider {
  tagIndex: CacheTagIndex;
  clear(): Promise<void>;
  health(): Promise<{ ok: boolean; details: { entries: number } }>;
}

interface StoredValue {
  value: string | Uint8Array;
  expiresAt: number;
}

const systemClock: Clock = {
  now: () => Date.now(),
};

export function memoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const clock = options.clock ?? systemClock;
  // Insertion order in this Map doubles as the recency order: the first entry is
  // the least-recently-used and the last is the most-recently-used. `get()` bumps
  // recency by re-inserting, and overflow eviction removes the first entry. Both
  // are O(1) — no sorting.
  const values = new Map<string, StoredValue>();
  const tagIndex = new MemoryTagIndex();

  function evictExpired(key: string, item: StoredValue | undefined): StoredValue | null {
    if (!item) {
      return null;
    }
    if (item.expiresAt <= clock.now()) {
      values.delete(key);
      void tagIndex.removeKeyFromAllScopes(key);
      return null;
    }
    return item;
  }

  function enforceMaxEntries() {
    const maxEntries = options.maxEntries;
    if (!maxEntries) {
      return;
    }
    while (values.size > maxEntries) {
      // Map iteration yields entries in insertion order, so the first key is the
      // least-recently-used. Pull it in O(1) rather than scanning/sorting.
      const lru = values.keys().next();
      if (lru.done) {
        return;
      }
      values.delete(lru.value);
      void tagIndex.removeKeyFromAllScopes(lru.value);
    }
  }

  return {
    name: "memory",
    tagIndex,
    async get(key) {
      const item = evictExpired(key, values.get(key));
      if (!item) {
        return null;
      }
      // Bump recency: re-inserting moves the key to the end (most-recently-used)
      // of the Map's insertion order so LRU eviction targets stale keys.
      values.delete(key);
      values.set(key, item);
      return item.value;
    },
    async set(key, value, setOptions) {
      const ttlMs = setOptions.ttlMs ?? (options.ttl ? parseDuration(options.ttl) : 0);
      // ttlMs <= 0 means "do not store": such an entry would be expired the
      // instant it was written (expiresAt <= now), so we skip the write entirely
      // and drop any prior value/tags for the key to keep get() consistent.
      if (ttlMs <= 0) {
        values.delete(key);
        await tagIndex.removeKeyFromAllScopes(key);
        return;
      }
      // Re-insert so a re-set key also counts as most-recently-used.
      values.delete(key);
      values.set(key, {
        value,
        expiresAt: clock.now() + ttlMs,
      });
      enforceMaxEntries();
    },
    async delete(key) {
      values.delete(key);
      await tagIndex.removeKeyFromAllScopes(key);
    },
    async clear() {
      values.clear();
      tagIndex.clear();
    },
    async health() {
      return { ok: true, details: { entries: values.size } };
    },
  };
}

/**
 * Tag index for the memory provider. Delegates every (scope, key)-addressed
 * operation to core's {@link InMemoryTagIndex}, which performs EXACT composite
 * matching (no suffix/prefix collisions). On top of that it tracks, per bare
 * key, the exact set of scopes the key has been tagged under, so the provider
 * can purge a key's tags during eviction/delete — where only the flat
 * (unscoped) key is known — without resorting to error-prone suffix matching.
 */
class MemoryTagIndex extends InMemoryTagIndex {
  /** Reverse map: bare key -> exact scopes the key currently has tags in. */
  private readonly scopesByKey = new Map<string, Set<string>>();

  override async addTags(scope: string, key: string, tags: string[], ttlMs: number): Promise<void> {
    await super.addTags(scope, key, tags, ttlMs);
    let scopes = this.scopesByKey.get(key);
    if (scopes === undefined) {
      scopes = new Set<string>();
      this.scopesByKey.set(key, scopes);
    }
    scopes.add(scope);
  }

  override async removeKey(scope: string, key: string, tags?: string[]): Promise<void> {
    await super.removeKey(scope, key, tags);
    // A bare `removeKey` (no `tags`) clears every tag for the key in this scope,
    // so forget the (scope, key) hint. A partial removal may leave tags behind,
    // so keep the hint; it stays accurate enough — the underlying exact removal
    // is a no-op for tags that are already gone.
    if (tags === undefined) {
      this.forgetScope(key, scope);
    }
  }

  /**
   * Remove the EXACT key from every scope it was tagged under. Uses the tracked
   * scope set (exact strings), never suffix matching, so an unrelated key whose
   * composite merely shares a trailing substring is never touched.
   */
  async removeKeyFromAllScopes(key: string): Promise<void> {
    const scopes = this.scopesByKey.get(key);
    if (scopes === undefined) {
      return;
    }
    for (const scope of [...scopes]) {
      await super.removeKey(scope, key);
    }
    this.scopesByKey.delete(key);
  }

  /**
   * Drop every association. Core's `InMemoryTagIndex` keeps its maps private, so
   * we wipe it by exact-removing each tracked (scope, key) before clearing our
   * own tracking — leaving both indexes empty.
   */
  clear(): void {
    for (const [key, scopes] of this.scopesByKey) {
      for (const scope of scopes) {
        void super.removeKey(scope, key);
      }
    }
    this.scopesByKey.clear();
  }

  /** Forget that `key` had tags in `scope`, pruning the empty entry. */
  private forgetScope(key: string, scope: string): void {
    const scopes = this.scopesByKey.get(key);
    if (scopes === undefined) {
      return;
    }
    scopes.delete(scope);
    if (scopes.size === 0) {
      this.scopesByKey.delete(key);
    }
  }
}
