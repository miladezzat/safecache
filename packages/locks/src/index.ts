import type { CacheLock } from "@safecache/core";

export interface RedisLockClient {
  set(
    key: string,
    value: string,
    options: { NX: true; PX: number },
  ): Promise<"OK" | null | unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval?(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | null>;
}

export interface RedisLockOptions {
  prefix?: string;
  tokenFactory?: () => string;
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export function redisLock(client: RedisLockClient, options: RedisLockOptions = {}): CacheLock {
  const prefix = options.prefix ?? "__safecache:locks";
  const tokenFactory =
    options.tokenFactory ??
    (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  return {
    async acquire(key, ttlMs) {
      const lockKey = `${prefix}:${key}`;
      const token = tokenFactory();
      const result = await client.set(lockKey, token, { NX: true, PX: ttlMs });
      if (result !== "OK") {
        return null;
      }

      return {
        async release() {
          if (client.eval) {
            await client.eval(RELEASE_SCRIPT, { keys: [lockKey], arguments: [token] });
            return;
          }
          if ((await client.get(lockKey)) === token) {
            await client.del(lockKey);
          }
        },
      };
    },
  };
}
