import { describe, expect, test } from "vitest";
import { createCache } from "@safecache/core";
import {
  safeCacheFastifyPlugin,
  type SafeCacheFastifyInstance,
  type SafeCacheFastifyRequest,
} from "./index";

describe("safeCacheFastifyPlugin", () => {
  test("decorates requests with cache", async () => {
    const cache = createCache({
      namespace: "fastify",
      provider: {
        name: "noop",
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      defaultTtl: "1m",
    });
    const hooks: Array<
      (request: SafeCacheFastifyRequest, reply: unknown, done: () => void) => void
    > = [];
    const app: SafeCacheFastifyInstance = {
      decorateRequest(name: string) {
        expect(name).toBe("safeCache");
      },
      addHook(
        name: "onRequest",
        hook: (request: SafeCacheFastifyRequest, reply: unknown, done: () => void) => void,
      ) {
        expect(name).toBe("onRequest");
        hooks.push(hook);
      },
    };

    await safeCacheFastifyPlugin(cache)(app);
    const request: SafeCacheFastifyRequest = {};
    hooks[0]?.(request, {}, () => {});

    expect(request.safeCache).toBe(cache);
  });
});
