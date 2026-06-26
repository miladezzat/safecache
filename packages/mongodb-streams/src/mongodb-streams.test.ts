import { describe, expect, test, vi } from "vitest";
import type { Cache } from "@safecache/core";
import { mapMongoChangeToInvalidation, mongoChangeStreams, requiresMongoReplicaSet } from "./index";

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
});
