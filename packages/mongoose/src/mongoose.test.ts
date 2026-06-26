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
});
