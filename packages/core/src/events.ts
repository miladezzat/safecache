import type { CacheRuntimeEvent, CacheRuntimeEventHandler, CacheRuntimeEventName } from "./types";

export class RuntimeEvents {
  private readonly handlers = new Map<CacheRuntimeEventName, Set<CacheRuntimeEventHandler>>();

  on(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void {
    const handlers = this.handlers.get(name) ?? new Set<CacheRuntimeEventHandler>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
  }

  off(name: CacheRuntimeEventName, handler: CacheRuntimeEventHandler): void {
    this.handlers.get(name)?.delete(handler);
  }

  emit(event: CacheRuntimeEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(event);
    }
  }
}
