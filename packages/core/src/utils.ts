import type { CacheEvent } from "./types";

/**
 * Normalize an unknown thrown value into an Error instance. Non-Error values
 * (strings, objects, etc.) are wrapped via `String()` so downstream handlers
 * always receive a real Error.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const CACHE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "invalidate:key",
  "invalidate:tag",
  "refresh:key",
]);

const OPTIONAL_STRING_FIELDS = [
  "key",
  "tag",
  "tenant",
  "actor",
  "reason",
  "region",
  "signature",
] as const;

/**
 * Runtime type guard for `CacheEvent`. Verifies the required shape (string
 * `id`/`source`/`namespace`, number `timestamp`, known `type`) and that any
 * present optional fields are strings. Used to validate events arriving from
 * untrusted transports before they are dispatched.
 */
export function isCacheEvent(value: unknown): value is CacheEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (typeof event["id"] !== "string") {
    return false;
  }
  if (typeof event["source"] !== "string") {
    return false;
  }
  if (typeof event["timestamp"] !== "number") {
    return false;
  }
  if (typeof event["namespace"] !== "string") {
    return false;
  }
  if (typeof event["type"] !== "string" || !CACHE_EVENT_TYPES.has(event["type"])) {
    return false;
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const present = event[field];
    if (present !== undefined && typeof present !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Parse and validate a cache event from an untrusted source. Strings are
 * JSON-parsed first (malformed JSON throws a clear Error), then the result is
 * validated via `isCacheEvent`. Throws `Error("invalid cache event: ...")` when
 * validation fails. Returns the typed event on success.
 */
export function parseCacheEvent(raw: unknown): CacheEvent {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid cache event: malformed JSON (${toError(error).message})`);
    }
  }
  if (!isCacheEvent(candidate)) {
    throw new Error("invalid cache event: does not match CacheEvent shape");
  }
  return candidate;
}
