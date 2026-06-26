import { describe, expect, test, vi } from "vitest";
import { createPrismaCacheSync, prismaModelTags } from "./index";

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
