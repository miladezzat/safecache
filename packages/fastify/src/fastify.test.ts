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

  test("marks the plugin to skip Fastify encapsulation", () => {
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

    const plugin = safeCacheFastifyPlugin(cache) as unknown as Record<symbol, unknown>;

    expect(plugin[Symbol.for("skip-override")]).toBe(true);
    expect(plugin[Symbol.for("fastify.display-name")]).toBe("safecache");
  });

  test("registers the decorator on the top-level scope under simulated encapsulation", async () => {
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

    // Minimal fake Fastify that honours the `skip-override` symbol: when a
    // plugin sets it, decorations land on the top-level scope; otherwise they
    // are confined to an encapsulated child scope.
    const topLevel: Record<string, unknown> = {};
    const makeScope = (decorated: Record<string, unknown>): SafeCacheFastifyInstance => ({
      decorateRequest(name) {
        decorated[name] = null;
      },
      addHook() {},
    });

    const register = async (
      plugin: (instance: SafeCacheFastifyInstance) => Promise<void>,
    ): Promise<void> => {
      const skipOverride = (plugin as unknown as Record<symbol, unknown>)[
        Symbol.for("skip-override")
      ];
      const scope = skipOverride ? topLevel : ({} as Record<string, unknown>);
      await plugin(makeScope(scope));
    };

    await register(safeCacheFastifyPlugin(cache));

    // Because skip-override is set, the decorator landed on the top-level scope.
    expect("safeCache" in topLevel).toBe(true);
  });
});
