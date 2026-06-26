import { describe, expect, test, vi } from "vitest";
import { cliCommands, createMemoryCliAdapter, runSafeCacheCli } from "./index";

describe("SafeCache CLI", () => {
  test("lists the required commands", () => {
    expect(cliCommands).toEqual([
      "doctor",
      "stats",
      "inspect",
      "invalidate",
      "invalidate-tag",
      "warm",
      "benchmark",
    ]);
  });

  test("doctor returns non-zero for failed checks", async () => {
    const result = await runSafeCacheCli(["doctor"], {
      doctor: async () => ({ ok: false, checks: [{ name: "redis", ok: false }] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("redis");
  });

  test("invalidate-tag calls the adapter", async () => {
    const invalidateTag = vi.fn(async () => {});

    const result = await runSafeCacheCli(["invalidate-tag", "users"], {
      invalidateTag,
    });

    expect(result.exitCode).toBe(0);
    expect(invalidateTag).toHaveBeenCalledWith("users");
  });

  test("memory adapter supports stats and inspect", async () => {
    const adapter = createMemoryCliAdapter({
      entries: new Map([["user:1", { value: { id: "1" }, tags: ["users"] }]]),
      stats: { hits: 1, misses: 2 },
    });

    await expect(runSafeCacheCli(["stats"], adapter)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(runSafeCacheCli(["inspect", "user:1"], adapter)).resolves.toMatchObject({
      exitCode: 0,
    });
  });
});
