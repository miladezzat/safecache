import type { CacheProvider, CacheTagIndex } from "@safecache/core";

export interface RedisProviderClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sAdd(key: string, members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping?(): Promise<string>;
}

export interface RedisProviderOptions {
  tagPrefix?: string;
}

export interface RedisProvider extends CacheProvider {
  tagIndex: CacheTagIndex;
  health(): Promise<{ ok: boolean; details?: { response: string } }>;
}

export function redisProvider(
  client: RedisProviderClient,
  options: RedisProviderOptions = {},
): RedisProvider {
  const tagIndex = new RedisTagIndex(client, options.tagPrefix ?? "__safecache:tags");
  return {
    name: "redis",
    tagIndex,
    async get(key) {
      return client.get(key);
    },
    async set(key, value, setOptions) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      await client.set(key, text, { PX: setOptions.ttlMs });
    },
    async delete(key) {
      await client.del(key);
    },
    async health() {
      if (!client.ping) {
        return { ok: true };
      }
      const pong = await client.ping();
      return { ok: pong.toUpperCase() === "PONG", details: { response: pong } };
    },
  };
}

class RedisTagIndex implements CacheTagIndex {
  constructor(
    private readonly client: RedisProviderClient,
    private readonly prefix: string,
  ) {}

  async addTags(scope: string, key: string, tags: string[], ttlMs: number): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    const seconds = Math.max(1, Math.ceil(ttlMs / 1_000));
    const keyTagsKey = this.keyTagsKey(scope, key);
    await this.client.sAdd(keyTagsKey, tags);
    await this.client.expire(keyTagsKey, seconds);
    for (const tag of tags) {
      const redisKey = this.tagKey(scope, tag);
      await this.client.sAdd(redisKey, [key]);
      await this.client.expire(redisKey, seconds);
    }
  }

  async getKeysByTag(scope: string, tag: string): Promise<string[]> {
    return this.client.sMembers(this.tagKey(scope, tag));
  }

  async removeKey(scope: string, key: string, tags: string[] = []): Promise<void> {
    const keyTagsKey = this.keyTagsKey(scope, key);
    const tagsToRemove = tags.length > 0 ? tags : await this.client.sMembers(keyTagsKey);
    for (const tag of tagsToRemove) {
      await this.client.sRem(this.tagKey(scope, tag), [key]);
    }
    await this.client.del(keyTagsKey);
  }

  async removeTag(scope: string, tag: string): Promise<void> {
    const tagKey = this.tagKey(scope, tag);
    const keys = await this.client.sMembers(tagKey);
    for (const key of keys) {
      await this.client.sRem(this.keyTagsKey(scope, key), [tag]);
    }
    await this.client.del(tagKey);
  }

  private tagKey(scope: string, tag: string): string {
    return `${this.prefix}:${scope}:${tag}`;
  }

  private keyTagsKey(scope: string, key: string): string {
    return `${this.prefix}:keys:${scope}:${key}`;
  }
}
