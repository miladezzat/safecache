import { describe, expect, test, vi } from "vitest";
import { createCache, toError } from "@safecache/core";
import type { Cache, CacheErrorEvent, CacheProvider } from "@safecache/core";
import {
  safeCacheFastifyPlugin,
  type SafeCacheFastifyInstance,
  type SafeCacheFastifyRequest,
} from "./index";

/**
 * A noop provider that always misses. Used when we want a real `Cache` whose
 * behavior is deterministic and never errors.
 */
function noopProvider(): CacheProvider {
  return {
    name: "noop",
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
}

/**
 * A provider whose every operation rejects. Used to prove that a cache-side
 * failure is swallowed by SafeCache's fail-open core and therefore never
 * escapes into a Fastify request handler.
 */
function explodingProvider(): CacheProvider {
  return {
    name: "exploding",
    get: async () => {
      throw new Error("provider get failed");
    },
    set: async () => {
      throw new Error("provider set failed");
    },
    delete: async () => {
      throw new Error("provider delete failed");
    },
  };
}

function makeCache(provider: CacheProvider, onError?: (event: CacheErrorEvent) => void): Cache {
  return createCache({
    namespace: "fastify",
    provider,
    defaultTtl: "1m",
    ...(onError ? { onError } : {}),
  });
}

/**
 * Minimal Fastify test double that faithfully reproduces the parts of the
 * lifecycle this adapter relies on:
 *   - `decorateRequest(name, default)` registers a per-request property and its
 *     initial value, applied freshly to every newly-created request object;
 *   - `addHook("onRequest", fn)` registers request-lifecycle hooks that run, in
 *     registration order, before the route handler;
 *   - `inject()` simulates a single request: it builds a fresh request object
 *     seeded with the registered decorators, runs the onRequest hooks, then the
 *     handler. Hooks call `done()` to advance (mirroring Fastify's callback
 *     style). This lets us assert real per-request isolation and ordering
 *     instead of poking a single hand-rolled request object.
 */
interface FakeFastify extends SafeCacheFastifyInstance {
  setHandler(handler: (request: SafeCacheFastifyRequest) => Promise<unknown> | unknown): void;
  inject(): Promise<{ statusCode: number; payload: unknown; error?: Error }>;
}

function createFakeFastify(): FakeFastify {
  const decorators: Record<string, unknown> = {};
  const hooks: Array<(request: SafeCacheFastifyRequest, reply: unknown, done: () => void) => void> =
    [];
  let handler: (request: SafeCacheFastifyRequest) => Promise<unknown> | unknown = () => undefined;

  const runHooks = (request: SafeCacheFastifyRequest): Promise<void> =>
    new Promise((resolve, reject) => {
      let index = 0;
      const next = (): void => {
        if (index >= hooks.length) {
          resolve();
          return;
        }
        const hook = hooks[index];
        index += 1;
        if (!hook) {
          next();
          return;
        }
        try {
          // A real onRequest hook signals completion by invoking `done()`.
          hook(request, {}, next);
        } catch (error) {
          reject(toError(error));
        }
      };
      next();
    });

  return {
    decorateRequest(name: "safeCache", value: null) {
      decorators[name] = value;
    },
    addHook(_name: "onRequest", hook) {
      hooks.push(hook);
    },
    setHandler(next) {
      handler = next;
    },
    async inject() {
      // Fastify builds a fresh request per call, seeded with the decorators.
      const request: SafeCacheFastifyRequest = { ...(decorators as SafeCacheFastifyRequest) };
      try {
        await runHooks(request);
        const payload = await handler(request);
        return { statusCode: 200, payload };
      } catch (error) {
        // Anything that escapes the handler/hooks becomes a 500 — exactly what we
        // must never see for a *cache-side* failure.
        return { statusCode: 500, payload: undefined, error: toError(error) };
      }
    },
  };
}

async function register(app: FakeFastify, cache: Cache): Promise<void> {
  await safeCacheFastifyPlugin(cache)(app);
}

describe("safeCacheFastifyPlugin", () => {
  test("decorates requests with cache", async () => {
    const cache = makeCache(noopProvider());
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
    const cache = makeCache(noopProvider());

    const plugin = safeCacheFastifyPlugin(cache) as unknown as Record<symbol, unknown>;

    expect(plugin[Symbol.for("skip-override")]).toBe(true);
    expect(plugin[Symbol.for("fastify.display-name")]).toBe("safecache");
  });

  test("registers the decorator on the top-level scope under simulated encapsulation", async () => {
    const cache = makeCache(noopProvider());

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

  test("lifecycle: decorateRequest registers a null default before onRequest binds the cache", async () => {
    const cache = makeCache(noopProvider());
    const order: string[] = [];

    // Trace the relative order of decorateRequest vs addHook so we know the
    // per-request property exists (defaulted to null) before any hook can run.
    const app: SafeCacheFastifyInstance = {
      decorateRequest(name, value) {
        order.push(`decorate:${name}`);
        expect(value).toBeNull();
      },
      addHook(name) {
        order.push(`hook:${name}`);
      },
    };

    await safeCacheFastifyPlugin(cache)(app);

    expect(order).toEqual(["decorate:safeCache", "hook:onRequest"]);
  });

  test("per-request availability: every request receives the cache via onRequest", async () => {
    const cache = makeCache(noopProvider());
    const app = createFakeFastify();
    await register(app, cache);

    const seen: Array<Cache | undefined> = [];
    app.setHandler((request) => {
      seen.push(request.safeCache);
      return "ok";
    });

    const a = await app.inject();
    const b = await app.inject();

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Two independent requests, each got the same cache instance wired in.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(cache);
    expect(seen[1]).toBe(cache);
  });

  test("per-request isolation: mutating one request's decorator does not leak into the next", async () => {
    const cache = makeCache(noopProvider());
    const app = createFakeFastify();
    await register(app, cache);

    let secondRequestSaw: Cache | undefined;
    app.setHandler((request) => {
      // By the time the handler runs the hook has already assigned the cache.
      expect(request.safeCache).toBe(cache);
      // Mutating this request's property must not affect a later request, because
      // each request is a fresh object seeded from the decorator default.
      request.safeCache = undefined;
      return "ok";
    });

    await app.inject();
    // Swap in a one-shot handler that records what the second request observed.
    app.setHandler((request) => {
      secondRequestSaw = request.safeCache;
      return "ok";
    });
    await app.inject();

    // The second request still received the cache; the first request's mutation
    // did not bleed across requests.
    expect(secondRequestSaw).toBe(cache);
  });

  test("fail-safe: a cache-side provider failure does NOT break request handling", async () => {
    const onError = vi.fn<(event: CacheErrorEvent) => void>();
    // Real cache whose provider throws on every operation.
    const cache = makeCache(explodingProvider(), onError);
    const app = createFakeFastify();
    await register(app, cache);

    // The route handler uses the cache exactly as an app would: it tries to read
    // through the cache and falls back to the origin fetcher. The provider blows
    // up internally, but SafeCache is fail-open, so the fetcher result is what
    // the handler — and thus the response — sees.
    app.setHandler(async (request) => {
      expect(request.safeCache).toBe(cache);
      // A defensive handler would guard the decorator before use; do the same so
      // the test mirrors real adapter usage under strict null checks.
      if (!request.safeCache) {
        throw new Error("cache not decorated");
      }
      const value = await request.safeCache.query({
        key: "user:1",
        fetcher: async () => "origin-value",
      });
      return value;
    });

    const result = await app.inject();

    // The host request completed successfully despite the cache being broken.
    expect(result.statusCode).toBe(200);
    expect(result.payload).toBe("origin-value");
    expect(result.error).toBeUndefined();
    // And the failure was observable through the notifier rather than thrown.
    expect(onError).toHaveBeenCalled();
    const firstCall = onError.mock.calls[0];
    expect(firstCall).toBeDefined();
    const event = firstCall?.[0];
    expect(event?.type).toBe("error");
    expect(event?.error).toBeInstanceOf(Error);
  });

  test("fail-safe: the user's own fetcher throwing IS allowed to propagate", async () => {
    // The single exception to the swallow-everything rule: the host's own code
    // (the fetcher) is the application's responsibility, so its error must reach
    // the handler rather than being silently eaten.
    const cache = makeCache(noopProvider());
    const app = createFakeFastify();
    await register(app, cache);

    app.setHandler(async (request) => {
      return request.safeCache?.query({
        key: "user:2",
        fetcher: async () => {
          throw new Error("origin database is down");
        },
      });
    });

    const result = await app.inject();

    // This surfaces as a 500 — the user's code failed, not the cache.
    expect(result.statusCode).toBe(500);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("origin database is down");
  });

  test("fail-safe: a broken cache still serves repeated requests (no cumulative breakage)", async () => {
    const onError = vi.fn<(event: CacheErrorEvent) => void>();
    const cache = makeCache(explodingProvider(), onError);
    const app = createFakeFastify();
    await register(app, cache);

    let calls = 0;
    app.setHandler(async (request) => {
      calls += 1;
      return request.safeCache?.query({
        key: "list",
        fetcher: async () => `result-${calls}`,
      });
    });

    const first = await app.inject();
    const second = await app.inject();

    expect(first.statusCode).toBe(200);
    expect(first.payload).toBe("result-1");
    expect(second.statusCode).toBe(200);
    expect(second.payload).toBe("result-2");
  });

  test("the onRequest hook itself never throws into the lifecycle", async () => {
    const cache = makeCache(noopProvider());
    const app = createFakeFastify();
    await register(app, cache);

    // A handler that does no cache work at all still completes; the hook's only
    // job (assigning the cache + calling done) is pure and cannot fail.
    app.setHandler(() => "no-cache-used");

    const result = await app.inject();
    expect(result.statusCode).toBe(200);
    expect(result.payload).toBe("no-cache-used");
    expect(result.error).toBeUndefined();
  });
});
