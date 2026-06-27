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

    expect(schema.post).toHaveBeenCalledTimes(10);
    for (const hook of [
      "save",
      "insertMany",
      "updateOne",
      "updateMany",
      "replaceOne",
      "findOneAndUpdate",
      "findOneAndReplace",
      "findOneAndDelete",
      "deleteOne",
      "deleteMany",
    ]) {
      expect(hooks.has(hook)).toBe(true);
    }
    await hooks.get("findOneAndUpdate")?.call({ getQuery: () => ({ _id: "123" }) }, { _id: "123" });

    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:123");
  });

  test("newly registered write hooks invalidate (query ops fall back to model tag)", async () => {
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

    // updateMany / replaceOne: filter without a resolvable id -> model tag only.
    await hooks.get("updateMany")?.call({ getQuery: () => ({ name: "x" }) });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).not.toHaveBeenCalledWith("User:undefined");

    cache.invalidateByTag.mockClear();
    await hooks.get("replaceOne")?.call({ getQuery: () => ({ _id: "9" }) });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:9");

    // findOneAndReplace: replacement document id wins.
    cache.invalidateByTag.mockClear();
    await hooks.get("findOneAndReplace")?.call({ getQuery: () => ({ name: "x" }) }, { _id: "42" });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:42");

    // findOneAndDelete: removed document is passed as the first arg.
    cache.invalidateByTag.mockClear();
    await hooks.get("findOneAndDelete")?.call({ getQuery: () => ({}) }, { _id: "7" });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User:7");
  });

  test("insertMany always invalidates the model tag even when docs carry no _id", async () => {
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

    // Plain objects without _id at post-hook time: per-document tags are skipped
    // but the model-level tag fallback must still fire.
    await hooks.get("insertMany")?.call({}, [{ name: "a" }, { name: "b" }]);
    expect(cache.invalidateByTag).toHaveBeenCalledWith("User");
    expect(cache.invalidateByTag).toHaveBeenCalledTimes(1);
  });

  test("insertMany model-resolution failure on empty/plain batch is contained (default)", async () => {
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
    // No modelName and an empty batch with no resolvable context -> resolveModelName throws.
    registerMongooseHooks(schema, sync, { onInvalidationError });

    await expect(hooks.get("insertMany")?.call({}, [])).resolves.toBeUndefined();
    expect(onInvalidationError).toHaveBeenCalledTimes(1);
    expect(cache.invalidateByTag).not.toHaveBeenCalled();
  });

  test("a thrown cache error does not break the host write on the new hooks (default)", async () => {
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

    for (const hook of ["updateMany", "replaceOne", "findOneAndReplace", "findOneAndDelete"]) {
      await expect(
        hooks.get(hook)?.call({ getQuery: () => ({ _id: "1" }) }, { _id: "1" }),
      ).resolves.toBeUndefined();
    }
    expect(onInvalidationError).toHaveBeenCalledTimes(4);
    expect(onInvalidationError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
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
