import { toError } from "@safecache/core";
import type { Cache, DurationInput } from "@safecache/core";

const SAFE_CACHE = Symbol("SafeCache.instance");

/**
 * Optional notifier for failures that occur *inside the decorator* (e.g.
 * `cache.query` throwing despite core being fail-open, or an invalidation
 * rejecting in `@CacheSync`). It is invoked defensively — if the notifier
 * itself throws, the throw is swallowed so it can never break the caller.
 */
export type DecoratorErrorHandler = (error: Error) => void;

export interface CachedOptions<Args extends unknown[] = unknown[]> {
  key: (...args: Args) => string;
  tags?: (...args: Args) => string[];
  /**
   * Time-to-live for the cached value. REQUIRED unless the underlying cache was
   * created with a `defaultTtl`. When both are absent, `cache.query` throws on
   * the first call ("query() requires ttl unless defaultTtl is configured");
   * `@Cached` is fail-safe and will still return the real value by invoking the
   * original method, but the cache read/write is skipped until `ttl` is supplied.
   */
  ttl?: DurationInput;
  tenant?: (...args: Args) => string | undefined;
  /** Per-decorator failure notifier; falls back to the module-level handler. */
  onError?: DecoratorErrorHandler;
}

export interface CacheSyncOptions<Args extends unknown[] = unknown[]> {
  tags?: (...args: Args) => string[];
  keys?: (...args: Args) => string[];
  tenant?: (...args: Args) => string | undefined;
  /** Per-decorator failure notifier; falls back to the module-level handler. */
  onError?: DecoratorErrorHandler;
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

let moduleErrorHandler: DecoratorErrorHandler | undefined;

/**
 * Install a process-wide notifier for decorator-side failures. Used when a
 * decorator was not given its own `onError`. Pass `undefined` to clear it.
 */
export function setSafeCacheDecoratorErrorHandler(
  handler: DecoratorErrorHandler | undefined,
): void {
  moduleErrorHandler = handler;
}

/**
 * Route a decorator-side failure to the per-decorator notifier (preferred) or
 * the module-level one. Both invocations are guarded: a throwing notifier is
 * swallowed so error reporting can never break the decorated method.
 */
function notifyDecoratorError(error: unknown, handler: DecoratorErrorHandler | undefined): void {
  const normalized = toError(error);
  const target = handler ?? moduleErrorHandler;
  if (!target) {
    return;
  }
  try {
    target(normalized);
  } catch {
    // A notifier must never break the caller; swallow its failure.
  }
}

/**
 * Best-effort detection of TC39/standard decorators. These decorators are
 * written against the legacy ("experimental") decorator signature, where the
 * third argument is a `PropertyDescriptor`. Under the standard proposal the
 * third argument is a `ClassMethodDecoratorContext` object instead, so we can
 * tell the environments apart and warn rather than silently no-op.
 */
function isLegacyMethodDescriptor(descriptor: unknown): descriptor is PropertyDescriptor {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "value" in (descriptor as Record<string, unknown>)
  );
}

function warnIfStandardDecorators(name: string, descriptor: unknown): boolean {
  if (isLegacyMethodDescriptor(descriptor)) {
    return true;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `${name} requires legacy decorators (experimentalDecorators / "useDefineForClassFields": false). ` +
      "It is a no-op under TC39/standard decorators. See @safecache/decorators README.",
  );
  return false;
}

/**
 * Cache a method's result through the injected SafeCache instance.
 *
 * Legacy-decorators only: this is implemented against the experimental
 * (`experimentalDecorators`) decorator signature and is a no-op under
 * TC39/standard decorators (it will warn at decoration time when it can detect
 * the mismatch).
 *
 * Fail-safe: SafeCache core is fail-open, so `cache.query` does not normally
 * throw. If it ever does — for any reason — the decorated method still returns
 * the real value by invoking the original method directly, and the cache error
 * is routed to the notifier (`options.onError` or the module-level handler).
 */
export function Cached<Args extends unknown[] = unknown[]>(
  options: CachedOptions<Args>,
): MethodDecorator {
  return (_target, propertyKey, descriptor) => {
    if (!warnIfStandardDecorators("@Cached", descriptor)) {
      return;
    }
    const original = descriptor.value as ((...args: Args) => Promise<unknown>) | undefined;
    if (!original) {
      throw new Error("@Cached can only decorate methods");
    }

    // `ttl` is only validated by core at the first call. We cannot see the
    // cache's `defaultTtl` at decoration time, so warn early to surface the
    // latent misconfiguration before any traffic hits the method.
    if (options.ttl === undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `@Cached on "${String(propertyKey)}" has no ttl; cache.query() will throw unless the ` +
          "cache was created with a defaultTtl. The method stays fail-safe (real value is still " +
          "returned) but caching is effectively disabled until ttl or defaultTtl is provided.",
      );
    }

    (descriptor as PropertyDescriptor).value = async function cachedMethod(
      this: object,
      ...args: Args
    ) {
      const cache = getSafeCache(this);
      try {
        return await cache.query({
          key: options.key(...args),
          tags: options.tags?.(...args),
          ttl: options.ttl,
          tenant: options.tenant?.(...args),
          fetcher: () => original.apply(this, args),
        });
      } catch (error) {
        // Bulletproof fail-safe: never let a cache failure deny the real value.
        notifyDecoratorError(error, options.onError);
        return original.apply(this, args);
      }
    };
  };
}

/**
 * Run a mutating method, then invalidate the associated keys/tags.
 *
 * Legacy-decorators only (see `@Cached`).
 *
 * Fail-safe: the original method runs first and its result is captured. The
 * invalidations then run via `Promise.allSettled`, so one failing key/tag never
 * stops the rest, and no invalidation error is ever propagated — failures are
 * routed to the notifier and the original result is returned regardless.
 */
export function CacheSync<Args extends unknown[] = unknown[]>(
  options: CacheSyncOptions<Args>,
): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    if (!warnIfStandardDecorators("@CacheSync", descriptor)) {
      return;
    }
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
      // Run the real work first and capture its result; its success must not be
      // undone by a failing invalidation below.
      const result = await original.apply(this, args);

      const invalidations: Array<Promise<void>> = [];
      for (const key of options.keys?.(...args) ?? []) {
        invalidations.push(cache.invalidate(key, { tenant }));
      }
      for (const tag of options.tags?.(...args) ?? []) {
        invalidations.push(cache.invalidateByTag(tag, { tenant }));
      }

      if (invalidations.length > 0) {
        // allSettled: one failing key/tag must not stop the others, and an
        // invalidation error must never propagate out of the decorated method.
        const outcomes = await Promise.allSettled(invalidations);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            notifyDecoratorError(outcome.reason, options.onError);
          }
        }
      }

      return result;
    };
  };
}
