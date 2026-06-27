import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cache } from "@safecache/core";
import {
  isNonResumableChangeStreamError,
  mapMongoChangeToInvalidation,
  mongoChangeStreams,
  MongoUnsafeDeleteError,
  requiresMongoReplicaSet,
} from "./index";

interface FakeStream {
  onChange?: (change: unknown) => Promise<void> | void;
  onError?: (error: unknown) => void;
  close: ReturnType<typeof vi.fn>;
}

interface FakeWatch {
  watch: ReturnType<typeof vi.fn>;
  streams: FakeStream[];
  watchOptions: Array<Record<string, unknown> | undefined>;
}

function fakeCollection(): FakeWatch {
  const streams: FakeStream[] = [];
  const watchOptions: Array<Record<string, unknown> | undefined> = [];
  const watch = vi.fn((_pipeline?: unknown[], options?: Record<string, unknown>) => {
    watchOptions.push(options);
    const stream: FakeStream = {
      close: vi.fn(async () => {}),
      on(event: string, handler: (arg: unknown) => Promise<void> | void) {
        if (event === "change") {
          stream.onChange = handler;
        } else {
          stream.onError = handler as (error: unknown) => void;
        }
        return stream;
      },
    } as unknown as FakeStream;
    streams.push(stream);
    return stream;
  });
  return { watch, streams, watchOptions };
}

describe("MongoDB change stream sync", () => {
  test("documents the replica set requirement", () => {
    expect(requiresMongoReplicaSet()).toBe(true);
  });

  test("maps inserts, updates, replaces, and deletes to configured tags", () => {
    const config = {
      id: (doc: { _id: string }) => doc._id,
      tags: (doc: { _id: string }) => [`user:${doc._id}`, "users"],
    };

    expect(
      mapMongoChangeToInvalidation(
        {
          operationType: "insert",
          fullDocument: { _id: "1" },
          documentKey: { _id: "1" },
        },
        config,
      ),
    ).toEqual({ keys: [], tags: ["user:1", "users"] });

    expect(
      mapMongoChangeToInvalidation(
        {
          operationType: "delete",
          documentKey: { _id: "2" },
        },
        config,
      ),
    ).toEqual({ keys: [], tags: ["user:2", "users"] });
  });

  test("watches collections, invalidates tags, tracks resume tokens, and closes streams", async () => {
    const handlers = new Map<string, (change: unknown) => Promise<void> | void>();
    const close = vi.fn(async () => {});
    const watch = vi.fn(() => ({
      close,
      on: vi.fn((event: string, handler: (change: unknown) => Promise<void> | void) => {
        handlers.set(event, handler);
      }),
    }));
    const db = {
      collection: vi.fn(() => ({ watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const resumeTokens: unknown[] = [];
    const plugin = mongoChangeStreams({
      db,
      resumeToken: "token-1",
      onResumeToken: (token) => {
        resumeTokens.push(token);
      },
      collections: {
        users: {
          id: (doc: { _id: string }) => doc._id,
          tags: (doc: { _id: string }) => [`user:${doc._id}`, "users"],
        },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit: vi.fn() });
    await handlers.get("change")?.({
      _id: "token-2",
      operationType: "update",
      documentKey: { _id: "123" },
    });
    await plugin.shutdown?.();

    expect(db.collection).toHaveBeenCalledWith("users");
    expect(watch).toHaveBeenCalledWith([], {
      fullDocument: "updateLookup",
      resumeAfter: "token-1",
    });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("user:123");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("users");
    expect(resumeTokens).toEqual(["token-2"]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("tracks resume tokens per collection so they stay distinct", async () => {
    const users = fakeCollection();
    const orders = fakeCollection();
    const collections: Record<string, FakeWatch> = { users, orders };
    const db = {
      collection: vi.fn((name: string) => ({
        watch: collections[name]!.watch,
      })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const seen: Array<[string, unknown]> = [];

    const plugin = mongoChangeStreams({
      db,
      // Per-collection initial tokens (Mongo tokens are opaque objects).
      resumeToken: {
        users: { _data: "users-start" },
        orders: { _data: "orders-start" },
      },
      onResumeToken: (token, collection) => {
        seen.push([collection, token]);
      },
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
        orders: { tags: (doc: { _id: string }) => [`order:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit: vi.fn() });

    // Each collection must resume from its OWN initial token.
    expect(users.watchOptions[0]).toEqual({
      fullDocument: "updateLookup",
      resumeAfter: { _data: "users-start" },
    });
    expect(orders.watchOptions[0]).toEqual({
      fullDocument: "updateLookup",
      resumeAfter: { _data: "orders-start" },
    });

    await users.streams[0]!.onChange?.({
      _id: { _data: "users-1" },
      operationType: "update",
      documentKey: { _id: "u1" },
    });
    await orders.streams[0]!.onChange?.({
      _id: { _data: "orders-1" },
      operationType: "update",
      documentKey: { _id: "o1" },
    });

    // Tokens must be reported tagged with the originating collection and kept
    // distinct rather than collapsed onto a single shared token.
    expect(seen).toEqual([
      ["users", { _data: "users-1" }],
      ["orders", { _data: "orders-1" }],
    ]);

    const health = plugin.getHealth();
    expect(health.collections.users?.lastResumeToken).toEqual({ _data: "users-1" });
    expect(health.collections.orders?.lastResumeToken).toEqual({ _data: "orders-1" });

    await plugin.shutdown?.();
  });

  test("re-watches a collection from its last token after a stream error", async () => {
    vi.useFakeTimers();
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const emit = vi.fn();

    const plugin = mongoChangeStreams({
      db,
      reconnect: { initialDelayMs: 10, maxDelayMs: 10 },
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit });

    // Advance the resume token before the failure.
    await users.streams[0]!.onChange?.({
      _id: { _data: "users-5" },
      operationType: "update",
      documentKey: { _id: "u1" },
    });

    // A transient (resumable) error: the stored token is still valid, so the
    // re-watch must resume from the LAST per-collection token.
    users.streams[0]!.onError?.(new Error("connection reset"));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", operation: "mongodb-streams" }),
    );
    expect(plugin.getHealth().ok).toBe(false);

    // The bounded backoff timer should re-watch from the LAST per-collection token.
    await vi.advanceTimersByTimeAsync(10);

    expect(users.watch).toHaveBeenCalledTimes(2);
    expect(users.watchOptions[1]).toEqual({
      fullDocument: "updateLookup",
      resumeAfter: { _data: "users-5" },
    });
    expect(plugin.getHealth().ok).toBe(true);

    await plugin.shutdown?.();
  });

  test("classifies dead-token errors as non-resumable", () => {
    expect(isNonResumableChangeStreamError(new Error("ChangeStreamHistoryLost"))).toBe(true);
    expect(isNonResumableChangeStreamError({ codeName: "ChangeStreamHistoryLost" })).toBe(true);
    expect(isNonResumableChangeStreamError({ code: 286 })).toBe(true);
    expect(
      isNonResumableChangeStreamError({ errorLabels: ["NonResumableChangeStreamError"] }),
    ).toBe(true);
    expect(isNonResumableChangeStreamError(new Error("invalidate"))).toBe(true);
    // Transient/resumable errors must NOT be classified as dead-token.
    expect(isNonResumableChangeStreamError(new Error("connection reset"))).toBe(false);
    expect(isNonResumableChangeStreamError({ code: 6 })).toBe(false);
  });

  test("a known-dead token triggers a token reset instead of an infinite loop", async () => {
    vi.useFakeTimers();
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const emit = vi.fn();

    const plugin = mongoChangeStreams({
      db,
      // Seed an initial (about-to-be-dead) token.
      resumeTokens: { users: { _data: "dead-token" } },
      reconnect: { initialDelayMs: 10, maxDelayMs: 10 },
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit });

    // First watch resumes from the seeded token.
    expect(users.watchOptions[0]).toEqual({
      fullDocument: "updateLookup",
      resumeAfter: { _data: "dead-token" },
    });

    // The server reports the token's history is gone. Re-watching with the dead
    // token would fail forever; instead the token must be cleared.
    const fatal = Object.assign(new Error("history lost"), {
      codeName: "ChangeStreamHistoryLost",
      code: 286,
    });
    users.streams[0]!.onError?.(fatal);
    expect(plugin.getHealth().ok).toBe(false);
    // The dead token must no longer be advertised as a resume position.
    expect(plugin.getHealth().collections.users?.lastResumeToken).toBeUndefined();

    // The bounded backoff re-watch must NOT reuse the dead token — it resumes
    // from "now" (no resumeAfter), breaking the would-be infinite loop.
    await vi.advanceTimersByTimeAsync(10);
    expect(users.watch).toHaveBeenCalledTimes(2);
    expect(users.watchOptions[1]).toEqual({ fullDocument: "updateLookup" });
    expect(users.watchOptions[1]).not.toHaveProperty("resumeAfter");

    await plugin.shutdown?.();
  });

  test("delete with an insufficient resolver warns rather than mis-invalidating", async () => {
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const emit = vi.fn();
    const onError = vi.fn();

    const plugin = mongoChangeStreams({
      db,
      onError,
      collections: {
        users: {
          // tenant is derived from a field that is ABSENT on delete; deriving it
          // from the key-only document would invalidate the wrong (default) scope.
          requiresDocumentForDelete: true,
          tenant: (doc: { tenantId?: string }) => doc.tenantId,
          tags: (doc: { tenantId?: string; _id: string }) => [`tenant:${doc.tenantId}:user`],
        },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit });

    await users.streams[0]!.onChange?.({
      _id: { _data: "del-1" },
      operationType: "delete",
      documentKey: { _id: "u1" },
    });

    // It must NOT silently invalidate the wrong scope.
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(cache.invalidateByTag).not.toHaveBeenCalled();

    // It must route the problem to BOTH the notifier and the runtime emit.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(MongoUnsafeDeleteError);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", operation: "mongodb-streams" }),
    );

    // The resume token still advances so the (already-notified) event is not
    // re-processed on a later reconnect.
    expect(plugin.getHealth().collections.users?.lastResumeToken).toEqual({ _data: "del-1" });

    await plugin.shutdown?.();
  });

  test("a delete with a sufficient (key-only) resolver still invalidates normally", async () => {
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const onError = vi.fn();

    const plugin = mongoChangeStreams({
      db,
      onError,
      collections: {
        // No requiresDocumentForDelete: every resolver derives from documentKey.
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit: vi.fn() });

    await users.streams[0]!.onChange?.({
      operationType: "delete",
      documentKey: { _id: "u9" },
    });

    expect(cache.invalidateByTag).toHaveBeenCalledWith("user:u9");
    expect(onError).not.toHaveBeenCalled();

    await plugin.shutdown?.();
  });

  test("a thrown cache error is swallowed + notified and never breaks the watch loop", async () => {
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const boom = new Error("cache provider down");
    const cache = {
      invalidate: vi.fn(async () => {}),
      // The cache side throws on invalidation — this must NOT propagate.
      invalidateByTag: vi.fn(async (): Promise<void> => {
        throw boom;
      }),
    };
    const emit = vi.fn();
    const onError = vi.fn();

    const plugin = mongoChangeStreams({
      db,
      onError,
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit });

    // The host operation (delivering a change) must complete as if the cache
    // were absent — awaiting the handler must not reject.
    await expect(
      users.streams[0]!.onChange?.({
        _id: { _data: "tok-1" },
        operationType: "update",
        documentKey: { _id: "u1" },
      }),
    ).resolves.toBeUndefined();

    // The cache failure was observed via both sinks...
    expect(onError).toHaveBeenCalledWith(boom);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", operation: "mongodb-streams", error: boom }),
    );

    // ...and the resume token was deliberately NOT advanced, so the missed
    // invalidation is retried on the next reconnect rather than skipped
    // (fail-open: a duplicate invalidation is safer than a dropped one).
    expect(plugin.getHealth().collections.users?.lastResumeToken).toBeUndefined();

    // The watch loop is still alive: a subsequent successful change is handled.
    cache.invalidateByTag.mockImplementationOnce(async () => {});
    await users.streams[0]!.onChange?.({
      _id: { _data: "tok-1b" },
      operationType: "update",
      documentKey: { _id: "u2" },
    });
    expect(plugin.getHealth().collections.users?.lastResumeToken).toEqual({ _data: "tok-1b" });

    await plugin.shutdown?.();
  });

  test("a throwing onError notifier never breaks the watch loop", async () => {
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async (): Promise<void> => {
        throw new Error("cache down");
      }),
    };
    const onError = vi.fn(() => {
      throw new Error("notifier exploded");
    });

    const plugin = mongoChangeStreams({
      db,
      onError,
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit: vi.fn() });

    await expect(
      users.streams[0]!.onChange?.({
        _id: { _data: "tok-2" },
        operationType: "update",
        documentKey: { _id: "u1" },
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    // The notifier threw, but the loop is still alive: a later successful change
    // is handled and advances the token.
    cache.invalidateByTag.mockImplementationOnce(async () => {});
    await users.streams[0]!.onChange?.({
      _id: { _data: "tok-2b" },
      operationType: "update",
      documentKey: { _id: "u2" },
    });
    expect(plugin.getHealth().collections.users?.lastResumeToken).toEqual({ _data: "tok-2b" });

    await plugin.shutdown?.();
  });

  test("explicit resumeTokens map disambiguates a bare-looking token", async () => {
    const users = fakeCollection();
    const db = {
      collection: vi.fn(() => ({ watch: users.watch })),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };

    const plugin = mongoChangeStreams({
      db,
      // Explicit per-collection map is authoritative, no heuristic involved.
      resumeTokens: { users: { _data: "explicit" } },
      collections: {
        users: { tags: (doc: { _id: string }) => [`user:${doc._id}`] },
      },
    });

    await plugin.setup({ cache: cache as unknown as Cache, emit: vi.fn() });

    expect(users.watchOptions[0]).toEqual({
      fullDocument: "updateLookup",
      resumeAfter: { _data: "explicit" },
    });

    await plugin.shutdown?.();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
