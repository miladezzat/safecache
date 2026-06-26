import type { CacheProvider, CacheTagIndex } from "@safecache/core";

export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  flush?(): Promise<void>;
  version?(): Promise<string>;
}

export interface MemcachedProvider extends CacheProvider {
  tagIndex: CacheTagIndex;
  clear(): Promise<void>;
  health(): Promise<{ ok: boolean; details?: { version: string } }>;
}

export function memcachedProvider(client: MemcachedClient): MemcachedProvider {
  const tagIndex = new LocalTagIndex();
  return {
    name: "memcached",
    tagIndex,
    async get(key) {
      return client.get(key);
    },
    async set(key, value, options) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      await client.set(key, text, Math.max(1, Math.ceil(options.ttlMs / 1_000)));
    },
    async delete(key) {
      await client.delete(key);
      await tagIndex.removeKeyFromAllScopes(key);
    },
    async clear() {
      await client.flush?.();
      tagIndex.clear();
    },
    async health() {
      if (!client.version) {
        return { ok: true };
      }
      return { ok: true, details: { version: await client.version() } };
    },
  };
}

class LocalTagIndex implements CacheTagIndex {
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
