import { isCacheEvent, parseCacheEvent } from "@safecache/core";
import type { CacheEvent, CacheEventType } from "@safecache/core";

/**
 * Re-export core's event validation helpers so transports and consumers have a
 * single shared validation surface. Event dedupe lives inside the core cache
 * runtime (`createCache`), so this package intentionally does not ship its own
 * deduper.
 */
export { isCacheEvent, parseCacheEvent };
export type { CacheEvent, CacheEventType };

let sourceCounter = 0;
let eventCounter = 0;

export interface CreateCacheEventOptions {
  type: CacheEventType;
  namespace: string;
  source: string;
  timestamp?: number;
  tenant?: string;
  key?: string;
  tag?: string;
  actor?: string;
  reason?: string;
  region?: string;
}

export interface CacheAuditLogEntry {
  eventId: string;
  type: CacheEventType;
  namespace: string;
  source: string;
  timestamp: number;
  tenant?: string;
  key?: string;
  tag?: string;
  actor?: string;
  reason?: string;
  region?: string;
}

export function createSourceId(prefix = "safecache"): string {
  sourceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${sourceCounter.toString(36)}`;
}

export function createCacheEvent(options: CreateCacheEventOptions): CacheEvent {
  eventCounter += 1;
  return {
    id: `${options.source}:${options.timestamp ?? Date.now()}:${eventCounter}`,
    timestamp: options.timestamp ?? Date.now(),
    type: options.type,
    source: options.source,
    namespace: options.namespace,
    ...(options.tenant ? { tenant: options.tenant } : {}),
    ...(options.key ? { key: options.key } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.region ? { region: options.region } : {}),
  };
}

export function createCacheAuditLogEntry(event: CacheEvent): CacheAuditLogEntry {
  return {
    actor: event.actor,
    eventId: event.id,
    key: event.key,
    namespace: event.namespace,
    reason: event.reason,
    region: event.region,
    source: event.source,
    tag: event.tag,
    tenant: event.tenant,
    timestamp: event.timestamp,
    type: event.type,
  };
}
