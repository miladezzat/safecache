import type { CacheEvent, CacheEventType } from "@safecache/core";

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
  };
}

export class EventDeduper {
  private readonly ids = new Set<string>();

  constructor(private readonly maxSize = 1_000) {}

  seen(id: string): boolean {
    if (this.ids.has(id)) {
      return true;
    }
    this.ids.add(id);
    if (this.ids.size > this.maxSize) {
      const oldest = this.ids.values().next().value;
      if (oldest) {
        this.ids.delete(oldest);
      }
    }
    return false;
  }
}
