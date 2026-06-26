import type { Cache, CachePlugin, CacheRuntimeEvent } from "./types";

export class PluginRegistry {
  private readonly plugins = new Map<string, CachePlugin>();
  private shutdownComplete = false;

  constructor(
    private readonly cache: Cache,
    private readonly emit: (event: CacheRuntimeEvent) => void,
  ) {}

  use(plugin: CachePlugin): void {
    if (this.plugins.has(plugin.name)) {
      return;
    }
    this.plugins.set(plugin.name, plugin);
    void plugin.setup({ cache: this.cache, emit: this.emit });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownComplete) {
      return;
    }
    this.shutdownComplete = true;
    for (const plugin of [...this.plugins.values()].reverse()) {
      await plugin.shutdown?.();
    }
  }
}
