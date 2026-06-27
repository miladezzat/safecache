import type { Cache } from "@safecache/core";

export interface SafeCacheFastifyRequest {
  safeCache?: Cache;
}

export interface SafeCacheFastifyInstance {
  decorateRequest(name: "safeCache", value: null): void;
  addHook(
    name: "onRequest",
    hook: (request: SafeCacheFastifyRequest, reply: unknown, done: () => void) => void,
  ): void;
}

// Well-known symbols that `fastify-plugin` sets to opt a plugin out of
// Fastify's encapsulation. Setting them directly avoids a runtime dependency
// on `fastify-plugin`. Typed as `unique symbol` so they can key the plugin's
// type while remaining `Symbol.for(...)` registry symbols at runtime.
const kSkipOverride: unique symbol = Symbol.for("skip-override") as typeof kSkipOverride;
const kDisplayName: unique symbol = Symbol.for("fastify.display-name") as typeof kDisplayName;
const kPluginMeta: unique symbol = Symbol.for("plugin-meta") as typeof kPluginMeta;

export type SafeCacheFastifyPlugin = ((fastify: SafeCacheFastifyInstance) => Promise<void>) & {
  [kSkipOverride]: true;
  [kDisplayName]: string;
  [kPluginMeta]: { name: string };
};

export function safeCacheFastifyPlugin(cache: Cache): SafeCacheFastifyPlugin {
  const plugin = async (fastify: SafeCacheFastifyInstance): Promise<void> => {
    fastify.decorateRequest("safeCache", null);
    fastify.addHook("onRequest", (request, _reply, done) => {
      request.safeCache = cache;
      done();
    });
  };

  // Mark the plugin so Fastify skips encapsulation, registering the decorator
  // and hook on the parent scope. This mirrors what `fastify-plugin` sets
  // internally, avoiding a runtime dependency on that package.
  return Object.assign(plugin, {
    [kSkipOverride]: true as const,
    [kDisplayName]: "safecache",
    [kPluginMeta]: { name: "safecache" },
  });
}
