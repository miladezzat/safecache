import { describe, expect, test, vi } from "vitest";
import { createPrismaCacheSync, inferPrismaMutationId, prismaModelTags } from "./index";

describe("Prisma cache sync", () => {
  test("creates model and entity tags", () => {
    expect(prismaModelTags("User", "123")).toEqual(["User", "User:123"]);
    expect(prismaModelTags("User")).toEqual(["User"]);
  });

  test("invalidates model tags after successful mutations only", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {}),
    };
    const sync = createPrismaCacheSync(cache);

    await expect(
      sync.mutate({
        model: "User",
        id: "123",
        action: async () => ({ id: "123" }),
      }),
    ).resolves.toEqual({ id: "123" });
    await expect(
      sync.mutate({
        model: "User",
        id: "456",
        action: async () => Promise.reject(new Error("db")),
      }),
    ).rejects.toThrow("db");

    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
    expect(cache.invalidateByTag).not.toHaveBeenCalledWith("User:456");
  });

  test("invalidates remaining tags when the first tag throws and routes the error", async () => {
    const cache = {
      invalidateByTag: vi.fn(async (tag: string) => {
        if (tag === "User") {
          throw new Error("model tag failure");
        }
      }),
    };
    const onInvalidationError = vi.fn();
    const sync = createPrismaCacheSync(cache, { onInvalidationError });

    await expect(sync.invalidate("User", "123")).resolves.toBeUndefined();

    // The entity tag is still invalidated even though the model tag threw first.
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
    expect(onInvalidationError).toHaveBeenCalledTimes(1);
    expect(onInvalidationError).toHaveBeenCalledWith(expect.any(Error), "User");
    expect(onInvalidationError.mock.calls[0]?.[0]).toMatchObject({ message: "model tag failure" });
  });

  test("propagates an aggregated error after invalidating every tag", async () => {
    const cache = {
      invalidateByTag: vi.fn(async (tag: string) => {
        if (tag === "User") {
          throw new Error("model tag failure");
        }
      }),
    };
    const sync = createPrismaCacheSync(cache, { propagateInvalidationErrors: true });

    await expect(sync.invalidate("User", "123")).rejects.toThrow("model tag failure");

    // Best-effort: the entity tag is still attempted before the error propagates.
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
  });

  test("handles Prisma mutation extension calls without caching reads", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {}),
    };
    const sync = createPrismaCacheSync(cache);

    await expect(
      sync.handleQuery({
        model: "User",
        operation: "findMany",
        args: {},
        query: async () => [{ id: "1" }],
      }),
    ).resolves.toEqual([{ id: "1" }]);

    await sync.handleQuery({
      model: "User",
      operation: "update",
      args: { where: { id: "123" }, data: { name: "Ada" } },
      query: async () => ({ id: "123" }),
    });

    expect(cache.invalidateByTag).toHaveBeenCalledTimes(2);
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
  });
});

describe("Prisma id resolution", () => {
  test("resolves a custom (non-`id`) primary key via idField", () => {
    expect(
      inferPrismaMutationId({ where: { uuid: "abc" } }, undefined, { idField: "uuid" }),
    ).toEqual(["abc"]);
    // The literal-`id` default would miss a non-`id` key entirely.
    expect(inferPrismaMutationId({ where: { uuid: "abc" } })).toEqual([]);
  });

  test("resolves a compound key from flat and nested (Prisma wrapper) args", () => {
    const options = { idField: ["tenantId", "userId"] as const };
    expect(
      inferPrismaMutationId({ data: { tenantId: "t1", userId: "u1" } }, undefined, options),
    ).toEqual(["t1:u1"]);
    expect(
      inferPrismaMutationId(
        { where: { tenantId_userId: { tenantId: "t1", userId: "u1" } } },
        undefined,
        options,
      ),
    ).toEqual(["t1:u1"]);
    // A partial compound key yields no precise id.
    expect(inferPrismaMutationId({ data: { tenantId: "t1" } }, undefined, options)).toEqual([]);
  });

  test("idExtractor takes precedence and may return several ids", () => {
    const ids = inferPrismaMutationId({ ids: ["a", "b"] }, undefined, {
      idField: "uuid",
      idExtractor: (args) => (args as { ids: string[] }).ids,
    });
    expect(ids).toEqual(["a", "b"]);
  });

  test("invalidates an entity tag per compound-key mutation", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const sync = createPrismaCacheSync(cache, { idField: ["tenantId", "userId"] });

    await sync.handleQuery({
      model: "Membership",
      operation: "update",
      args: { where: { tenantId_userId: { tenantId: "t1", userId: "u1" } }, data: {} },
      query: async () => ({ tenantId: "t1", userId: "u1" }),
    });

    expect(cache.invalidateByTag).toHaveBeenCalledWith("Membership");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("Membership:t1:u1");
  });
});

describe("Prisma unmappable-mutation signal", () => {
  test("signals `no-id` when no key can be inferred and no explicit tags are given", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const onUnmappableMutation = vi.fn();
    const sync = createPrismaCacheSync(cache, { onUnmappableMutation });

    await sync.handleQuery({
      model: "User",
      operation: "create",
      args: { data: { name: "Ada" } },
      query: async () => ({ name: "Ada" }),
    });

    // Only the model tag could be invalidated.
    expect(cache.invalidateByTag).toHaveBeenCalledTimes(1);
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(onUnmappableMutation).toHaveBeenCalledTimes(1);
    expect(onUnmappableMutation).toHaveBeenCalledWith({
      model: "User",
      operation: "create",
      reason: "no-id",
      tags: ["User"],
    });
  });

  test("signals `scope` for bulk updateMany/deleteMany operations", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const onUnmappableMutation = vi.fn();
    const sync = createPrismaCacheSync(cache, { onUnmappableMutation });

    await sync.handleQuery({
      model: "User",
      operation: "deleteMany",
      args: { where: { active: false } },
      query: async () => ({ count: 9 }),
    });

    expect(onUnmappableMutation).toHaveBeenCalledWith({
      model: "User",
      operation: "deleteMany",
      reason: "scope",
      tags: ["User"],
    });
  });

  test("explicit tags suppress the unmappable signal", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const onUnmappableMutation = vi.fn();
    const sync = createPrismaCacheSync(cache, { onUnmappableMutation });

    await sync.mutate({
      model: "User",
      tags: ["User:tenant:42"],
      action: async () => ({ name: "Ada" }),
    });

    expect(onUnmappableMutation).not.toHaveBeenCalled();
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:tenant:42");
  });
});

describe("SafeCache safety guarantee (fail-open by default)", () => {
  test("a thrown cache error does NOT break the host mutation", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {
        throw new Error("cache exploded");
      }),
    };
    const onInvalidationError = vi.fn();
    const sync = createPrismaCacheSync(cache, { onInvalidationError });

    // The host write committed; invalidation failing must not surface as a failure.
    await expect(
      sync.mutate({
        model: "User",
        id: "123",
        action: async () => ({ id: "123" }),
      }),
    ).resolves.toEqual({ id: "123" });

    expect(onInvalidationError).toHaveBeenCalled();
    expect(onInvalidationError).toHaveBeenCalledWith(expect.any(Error), "User");
  });

  test("a throwing notifier never escapes into the host operation", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {
        throw new Error("cache exploded");
      }),
    };
    const sync = createPrismaCacheSync(cache, {
      onInvalidationError: () => {
        throw new Error("notifier exploded");
      },
    });

    await expect(
      sync.mutate({ model: "User", id: "123", action: async () => ({ id: "123" }) }),
    ).resolves.toEqual({ id: "123" });
  });

  test("a throwing unmappable signal never escapes into the host operation", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const sync = createPrismaCacheSync(cache, {
      onUnmappableMutation: () => {
        throw new Error("signal exploded");
      },
    });

    await expect(
      sync.mutate({ model: "User", action: async () => ({ name: "Ada" }) }),
    ).resolves.toEqual({ name: "Ada" });
  });

  test("the user's own action error still propagates (their code, not ours)", async () => {
    const cache = { invalidateByTag: vi.fn(async () => {}) };
    const sync = createPrismaCacheSync(cache);

    await expect(
      sync.mutate({ model: "User", id: "1", action: async () => Promise.reject(new Error("db")) }),
    ).rejects.toThrow("db");
    // Nothing was invalidated because the write never committed.
    expect(cache.invalidateByTag).not.toHaveBeenCalled();
  });

  test("opt-in propagateInvalidationErrors re-throws cache failures", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {
        throw new Error("cache exploded");
      }),
    };
    const sync = createPrismaCacheSync(cache, { propagateInvalidationErrors: true });

    // A single failing tag re-throws the original error verbatim...
    await expect(
      sync.mutate({ model: "User", action: async () => ({ name: "Ada" }) }),
    ).rejects.toThrow("cache exploded");

    // ...while multiple failing tags surface an AggregateError of the originals.
    await expect(
      sync.mutate({ model: "User", id: "1", action: async () => ({ id: "1" }) }),
    ).rejects.toThrow(AggregateError);
  });
});
