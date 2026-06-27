import type { CacheLock, CacheLockHandle } from "@safecache/core";

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

// Compare-and-delete: only delete the lock if it still holds our fencing token.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Compare-and-extend: only PEXPIRE the lock if it still holds our fencing token.
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
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
    async acquire(key, ttlMs): Promise<CacheLockHandle | null> {
      const lockKey = `${prefix}:${key}`;
      const token = tokenFactory();
      const result = await client.set(lockKey, token, { NX: true, PX: ttlMs });
      if (result !== "OK") {
        return null;
      }

      return {
        token,
        async renew(renewTtlMs) {
          // Renewal must be atomic and token-fenced: extend only if we still own the
          // lock. Without eval we cannot do the compare-and-extend safely, so report
          // that the lock is no longer guaranteed held rather than blindly extending.
          if (!client.eval) {
            return false;
          }
          const renewed = await client.eval(RENEW_SCRIPT, {
            keys: [lockKey],
            arguments: [token, String(renewTtlMs)],
          });
          return renewed === 1;
        },
        async release() {
          // Release must be atomic and token-fenced so we never delete a lock owned by
          // another acquisition. The non-atomic GET-then-DEL fallback has a race
          // (the lock can expire and be re-acquired between GET and DEL), so when eval
          // is unavailable we fail safe and leave the lock to expire on its own.
          if (!client.eval) {
            return;
          }
          await client.eval(RELEASE_SCRIPT, { keys: [lockKey], arguments: [token] });
        },
      };
    },
  };
}
