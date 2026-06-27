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
    try {
      void Promise.resolve(plugin.setup({ cache: this.cache, emit: this.emit })).catch((error) => {
        this.emit({
          type: "error",
          operation: `plugin:${plugin.name}:setup`,
          error: toError(error),
        });
      });
    } catch (error) {
      this.emit({
        type: "error",
        operation: `plugin:${plugin.name}:setup`,
        error: toError(error),
      });
    }
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
