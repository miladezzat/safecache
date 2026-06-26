import {
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
  insertedAt: number;
}

const systemClock: Clock = {
  now: () => Date.now(),
};

export function memoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const clock = options.clock ?? systemClock;
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
      const oldest = [...values.entries()].sort((a, b) => a[1].insertedAt - b[1].insertedAt)[0];
      if (!oldest) {
        return;
      }
      values.delete(oldest[0]);
      void tagIndex.removeKeyFromAllScopes(oldest[0]);
    }
  }

  return {
    name: "memory",
    tagIndex,
    async get(key) {
      return evictExpired(key, values.get(key))?.value ?? null;
    },
    async set(key, value, setOptions) {
      const ttlMs = setOptions.ttlMs ?? (options.ttl ? parseDuration(options.ttl) : 0);
      values.set(key, {
        value,
        expiresAt: clock.now() + ttlMs,
        insertedAt: clock.now(),
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

class MemoryTagIndex implements CacheTagIndex {
  private readonly tags = new Map<string, Set<string>>();
  private readonly keyTags = new Map<string, Set<string>>();

  async addTags(scope: string, key: string, tags: string[]): Promise<void> {
    const scopedKey = this.scopedKey(scope, key);
    const existing = this.keyTags.get(scopedKey) ?? new Set<string>();
    for (const tag of tags) {
      const scopedTag = this.scopedTag(scope, tag);
      const keys = this.tags.get(scopedTag) ?? new Set<string>();
      keys.add(key);
      this.tags.set(scopedTag, keys);
      existing.add(tag);
    }
    this.keyTags.set(scopedKey, existing);
  }

  async getKeysByTag(scope: string, tag: string): Promise<string[]> {
    return [...(this.tags.get(this.scopedTag(scope, tag)) ?? [])];
  }

  async removeKey(scope: string, key: string): Promise<void> {
    const scopedKey = this.scopedKey(scope, key);
    const tags = this.keyTags.get(scopedKey) ?? new Set<string>();
    for (const tag of tags) {
      this.tags.get(this.scopedTag(scope, tag))?.delete(key);
    }
    this.keyTags.delete(scopedKey);
  }

  async removeTag(scope: string, tag: string): Promise<void> {
    const scopedTag = this.scopedTag(scope, tag);
    const keys = this.tags.get(scopedTag) ?? new Set<string>();
    for (const key of keys) {
      this.keyTags.get(this.scopedKey(scope, key))?.delete(tag);
    }
    this.tags.delete(scopedTag);
  }

  async removeKeyFromAllScopes(key: string): Promise<void> {
    for (const scopedKey of [...this.keyTags.keys()]) {
      if (scopedKey.endsWith(`::${key}`)) {
        const scope = scopedKey.slice(0, -`::${key}`.length);
        await this.removeKey(scope, key);
      }
    }
  }

  clear(): void {
    this.tags.clear();
    this.keyTags.clear();
  }

  private scopedTag(scope: string, tag: string): string {
    return `${scope}::${tag}`;
  }

  private scopedKey(scope: string, key: string): string {
    return `${scope}::${key}`;
  }
}
