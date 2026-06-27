import type { CacheProvider, CacheTagIndex } from "@safecache/core";

/**
 * Structured expiration for node-redis v6's SET command. The flat top-level
 * `PX`/`NX` options are deprecated in v6 in favour of the structured shape
 * `{ expiration: { type: "PX", value }, condition: "NX" }`.
 */
export interface RedisSetExpiration {
  type: "EX" | "PX" | "EXAT" | "PXAT";
  value: number;
}

export interface RedisSetOptions {
  /** node-redis v6 structured expiration. */
  expiration?: RedisSetExpiration;
  /** node-redis v6 structured condition. */
  condition?: "NX" | "XX";
  /**
   * Deprecated node-redis v5/flat shape. Retained as a fallback for clients
   * that have not migrated to the v6 structured options.
   * @deprecated Use `expiration` instead.
   */
  PX?: number;
}

/**
 * A buffered, chainable transaction handle (the object returned by node-redis'
 * `multi()`). Commands are queued and applied atomically when `exec()` runs.
 */
export interface RedisMulti {
  sAdd(key: string, members: string[]): RedisMulti;
  sRem(key: string, members: string[]): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  del(...keys: string[]): RedisMulti;
  exec(): Promise<unknown[]>;
}

export interface RedisProviderClient {
  get(key: string): Promise<string | Uint8Array | null>;
  set(key: string, value: string | Uint8Array, options?: RedisSetOptions): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sAdd(key: string, members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  /** Starts a MULTI/EXEC transaction. Optional: a non-atomic fallback is used when absent. */
  multi?(): RedisMulti;
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
      // Redis rejects PX:0; a non-positive TTL means "no expiry" here.
      if (setOptions.ttlMs > 0) {
        await client.set(key, value, { expiration: { type: "PX", value: setOptions.ttlMs } });
      } else {
        await client.set(key, value);
      }
    },
    async delete(key) {
      await client.del(key);
    },
    async health() {
      if (!client.ping) {
        return { ok: true };
      }
      const pong = await client.ping();
      // ping() may resolve to a non-string (e.g. a Buffer or RESP3 reply); coerce defensively.
      const response = String(pong);
      return { ok: response.toUpperCase() === "PONG", details: { response } };
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

    const multi = this.client.multi?.();
    if (multi) {
      // Atomic: all set memberships and their TTLs commit together or not at all.
      multi.sAdd(keyTagsKey, tags).expire(keyTagsKey, seconds);
      for (const tag of tags) {
        const redisKey = this.tagKey(scope, tag);
        multi.sAdd(redisKey, [key]).expire(redisKey, seconds);
      }
      await multi.exec();
      return;
    }

    // Fallback for clients without MULTI support (non-atomic).
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
    // The reverse index must be read before the transaction so the membership
    // removals below are derived from a consistent snapshot.
    const tagsToRemove = tags.length > 0 ? tags : await this.client.sMembers(keyTagsKey);

    const multi = this.client.multi?.();
    if (multi) {
      // Atomic: drop the key from every tag set and delete its reverse index together.
      for (const tag of tagsToRemove) {
        multi.sRem(this.tagKey(scope, tag), [key]);
      }
      multi.del(keyTagsKey);
      await multi.exec();
      return;
    }

    // Fallback for clients without MULTI support (non-atomic).
    for (const tag of tagsToRemove) {
      await this.client.sRem(this.tagKey(scope, tag), [key]);
    }
    await this.client.del(keyTagsKey);
  }

  async removeTag(scope: string, tag: string): Promise<void> {
    const tagKey = this.tagKey(scope, tag);
    // Snapshot members before mutating so reverse-index cleanup stays consistent.
    const keys = await this.client.sMembers(tagKey);

    const multi = this.client.multi?.();
    if (multi) {
      // Atomic: drop the tag from every key's reverse index and delete the tag set together.
      for (const key of keys) {
        multi.sRem(this.keyTagsKey(scope, key), [tag]);
      }
      multi.del(tagKey);
      await multi.exec();
      return;
    }

    // Fallback for clients without MULTI support (non-atomic).
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
