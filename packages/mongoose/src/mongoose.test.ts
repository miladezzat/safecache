import { describe, expect, test, vi } from "vitest";
import { createMongooseCacheSync, mongooseModelTags } from "./index";

describe("Mongoose cache sync", () => {
  test("creates model and document tags", () => {
    expect(mongooseModelTags("User", "123")).toEqual(["User", "User:123"]);
    expect(mongooseModelTags("User")).toEqual(["User"]);
  });

  test("hook helpers invalidate after successful mutations only", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {}),
    };
    const sync = createMongooseCacheSync(cache);

    await sync.save("User", { _id: "123" });
    await sync.deleteMany("User");

    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
  });

  test("registers expected Mongoose post hooks", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {}),
    };
    const sync = createMongooseCacheSync(cache);
    const hooks = new Map<string, Function>();
    const schema = {
      post: vi.fn((hook: string, handler: Function) => {
        hooks.set(hook, handler);
      }),
    };

    const { registerMongooseHooks } = await import("./index");
    registerMongooseHooks(schema, sync, { modelName: "User" });

    expect(schema.post).toHaveBeenCalledTimes(6);
    await hooks.get("findOneAndUpdate")?.call({ getQuery: () => ({ _id: "123" }) }, { _id: "123" });

    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
  });

  test("does not reject a committed write when invalidation throws (default)", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const onInvalidationError = vi.fn();
    const sync = createMongooseCacheSync(cache, { onInvalidationError });
    const hooks = new Map<string, Function>();
    const schema = {
      post: vi.fn((hook: string, handler: Function) => {
        hooks.set(hook, handler);
      }),
    };

    const { registerMongooseHooks } = await import("./index");
    registerMongooseHooks(schema, sync, { modelName: "User" });

    await expect(hooks.get("save")?.call({}, { _id: "123" })).resolves.toBeUndefined();
    expect(onInvalidationError).toHaveBeenCalledTimes(1);
    expect(onInvalidationError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test("does not reject a committed write when model resolution throws (default)", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {}),
    };
    const sync = createMongooseCacheSync(cache);
    const hooks = new Map<string, Function>();
    const schema = {
      post: vi.fn((hook: string, handler: Function) => {
        hooks.set(hook, handler);
      }),
    };
    const onInvalidationError = vi.fn();

    const { registerMongooseHooks } = await import("./index");
    // No modelName configured and no resolvable context -> resolveModelName throws.
    registerMongooseHooks(schema, sync, { onInvalidationError });

    await expect(hooks.get("updateOne")?.call({})).resolves.toBeUndefined();
    expect(onInvalidationError).toHaveBeenCalledTimes(1);
    expect(cache.invalidateByTag).not.toHaveBeenCalled();
  });

  test("propagateInvalidationErrors re-throws from the post hook when opted in", async () => {
    const cache = {
      invalidateByTag: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const sync = createMongooseCacheSync(cache, { propagateInvalidationErrors: true });
    const hooks = new Map<string, Function>();
    const schema = {
      post: vi.fn((hook: string, handler: Function) => {
        hooks.set(hook, handler);
      }),
    };

    const { registerMongooseHooks } = await import("./index");
    registerMongooseHooks(schema, sync, {
      modelName: "User",
      propagateInvalidationErrors: true,
    });

    await expect(hooks.get("save")?.call({}, { _id: "123" })).rejects.toThrow("redis down");
  });
});
