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

export function safeCacheFastifyPlugin(cache: Cache) {
  return async (fastify: SafeCacheFastifyInstance): Promise<void> => {
    fastify.decorateRequest("safeCache", null);
    fastify.addHook("onRequest", (request, _reply, done) => {
      request.safeCache = cache;
      done();
    });
  };
}
