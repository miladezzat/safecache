import { InMemoryTagIndex, toError, type CacheProvider, type CacheTagIndex } from "@safecache/core";

export interface MemcachedClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  flush?(): Promise<void>;
  version?(): Promise<string>;
}

export interface MemcachedProviderOptions {
  /**
   * Notifier for cache-side failures. Every error raised on the cache path
   * (get/set/delete/clear) is caught, routed here, and then swallowed so the
   * host operation continues as if the cache were absent — this is the core
   * SafeCache guarantee. Defaults to a silent no-op (library code never logs by
   * default); wire it to your logger / Sentry / metrics to observe a degraded
   * cache. The notifier is invoked defensively: if it throws, the throw is
   * swallowed so the notifier itself can never break the caller.
   */
  onError?: (error: Error) => void;
  /**
   * Opt in to fail-closed clear(): when true, a `clear()` with no underlying
   * `client.flush` rejects instead of routing to `onError`. Default false keeps
   * the SafeCache contract (swallow + notify).
   */
  propagateInvalidationErrors?: boolean;
}

export interface MemcachedProvider extends CacheProvider {
  tagIndex: CacheTagIndex;
  clear(): Promise<void>;
  health(): Promise<{ ok: boolean; details?: { version: string } }>;
}

/**
 * Memcached treats a TTL of more than 30 days (in seconds) as an absolute Unix
 * timestamp rather than a relative offset, which would cause large SWR/refresh
 * windows to expire immediately. Anything at or below this bound stays relative.
 */
const RELATIVE_TTL_MAX_SECONDS = 2_592_000; // 30 days

/**
 * Single-character sentinels written as the first byte of every stored value so
 * reads can losslessly distinguish a plain UTF-8 string from binary bytes that a
 * `TextDecoder` round-trip would otherwise corrupt. Binary payloads are
 * base64-encoded; strings are stored verbatim after the marker.
 */
const STRING_SENTINEL = "s";
const BINARY_SENTINEL = "b";

function encodeValue(value: string | Uint8Array): string {
  if (typeof value === "string") {
    return STRING_SENTINEL + value;
  }
  return BINARY_SENTINEL + Buffer.from(value).toString("base64");
}

function decodeValue(stored: string): string | Uint8Array {
  const marker = stored.charAt(0);
  const payload = stored.slice(1);
  if (marker === BINARY_SENTINEL) {
    return new Uint8Array(Buffer.from(payload, "base64"));
  }
  if (marker === STRING_SENTINEL) {
    return payload;
  }
  // Unmarked legacy value (written before this encoding existed): pass through
  // verbatim rather than risk dropping data.
  return stored;
}

/**
 * Convert a relative TTL in milliseconds to the seconds value Memcached expects.
 * Values above the 30-day relative bound are passed as an absolute epoch
 * (`now + seconds`) so Memcached does not reinterpret them as a timestamp and
 * expire the entry instantly.
 */
function toMemcachedTtlSeconds(ttlMs: number): number {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1_000));
  if (seconds > RELATIVE_TTL_MAX_SECONDS) {
    return Math.floor(Date.now() / 1_000) + seconds;
  }
  return seconds;
}

export function memcachedProvider(
  client: MemcachedClient,
  options: MemcachedProviderOptions = {},
): MemcachedProvider {
  const tagIndex = new InMemoryTagIndex();
  const notify = options.onError ?? (() => {});

  function reportError(error: unknown): void {
    try {
      notify(toError(error));
    } catch {
      // A throwing notifier must never break the host application.
    }
  }

  return {
    name: "memcached",
    tagIndex,
    async get(key) {
      try {
        const stored = await client.get(key);
        return stored === null ? null : decodeValue(stored);
      } catch (error) {
        reportError(error);
        return null;
      }
    },
    async set(key, value, setOptions) {
      try {
        await client.set(key, encodeValue(value), toMemcachedTtlSeconds(setOptions.ttlMs));
      } catch (error) {
        reportError(error);
      }
    },
    async delete(key) {
      try {
        await client.delete(key);
      } catch (error) {
        reportError(error);
      }
    },
    async clear() {
      if (!client.flush) {
        const error = new Error(
          "memcached clear() is unavailable: the client does not implement flush(); stale data cannot be invalidated",
        );
        if (options.propagateInvalidationErrors) {
          throw error;
        }
        reportError(error);
        return;
      }
      try {
        await client.flush();
      } catch (error) {
        if (options.propagateInvalidationErrors) {
          throw toError(error);
        }
        reportError(error);
      }
    },
    async health() {
      if (!client.version) {
        return { ok: true };
      }
      return { ok: true, details: { version: await client.version() } };
    },
  };
}
