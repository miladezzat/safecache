import type { Cache, DurationInput } from "@safecache/core";

const SAFE_CACHE = Symbol("SafeCache.instance");

export interface CachedOptions<Args extends unknown[] = unknown[]> {
  key: (...args: Args) => string;
  tags?: (...args: Args) => string[];
  ttl?: DurationInput;
  tenant?: (...args: Args) => string | undefined;
}

export interface CacheSyncOptions<Args extends unknown[] = unknown[]> {
  tags?: (...args: Args) => string[];
  keys?: (...args: Args) => string[];
  tenant?: (...args: Args) => string | undefined;
}

export type WithSafeCache<T> = T & { [SAFE_CACHE]: Cache };

export function withSafeCache<T extends object>(target: T, cache: Cache): WithSafeCache<T> {
  Object.defineProperty(target, SAFE_CACHE, {
    configurable: true,
    enumerable: false,
    value: cache,
  });
  return target as WithSafeCache<T>;
}

export function getSafeCache(target: object): Cache {
  const cache = (target as Partial<WithSafeCache<object>>)[SAFE_CACHE];
  if (!cache) {
    throw new Error("SafeCache decorators require withSafeCache(instance, cache)");
  }
  return cache;
}

export function Cached<Args extends unknown[] = unknown[]>(
  options: CachedOptions<Args>,
): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const original = descriptor.value as ((...args: Args) => Promise<unknown>) | undefined;
    if (!original) {
      throw new Error("@Cached can only decorate methods");
    }

    (descriptor as PropertyDescriptor).value = async function cachedMethod(
      this: object,
      ...args: Args
    ) {
      const cache = getSafeCache(this);
      return cache.query({
        key: options.key(...args),
        tags: options.tags?.(...args),
        ttl: options.ttl,
        tenant: options.tenant?.(...args),
        fetcher: () => original.apply(this, args),
      });
    };
  };
}

export function CacheSync<Args extends unknown[] = unknown[]>(
  options: CacheSyncOptions<Args>,
): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const original = descriptor.value as ((...args: Args) => Promise<unknown>) | undefined;
    if (!original) {
      throw new Error("@CacheSync can only decorate methods");
    }

    (descriptor as PropertyDescriptor).value = async function cacheSyncMethod(
      this: object,
      ...args: Args
    ) {
      const cache = getSafeCache(this);
      const tenant = options.tenant?.(...args);
      const result = await original.apply(this, args);
      for (const key of options.keys?.(...args) ?? []) {
        await cache.invalidate(key, { tenant });
      }
      for (const tag of options.tags?.(...args) ?? []) {
        await cache.invalidateByTag(tag, { tenant });
      }
      return result;
    };
  };
}
