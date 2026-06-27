import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cache } from "@safecache/core";
import { mapMongoChangeToInvalidation, mongoChangeStreams, requiresMongoReplicaSet } from "./index";

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

    // A non-resumable error would otherwise terminate the stream permanently.
    users.streams[0]!.onError?.(new Error("invalidate"));
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
});

afterEach(() => {
  vi.useRealTimers();
});
