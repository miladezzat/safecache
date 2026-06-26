import { describe, expect, test } from "vitest";
import { createDashboard, createEmptyDashboardSnapshot, renderDashboard } from "./index";

describe("SafeCache dashboard", () => {
  test("renders all required dashboard panels", () => {
    const html = renderDashboard({
      ...createEmptyDashboardSnapshot(),
      hitRate: 0.75,
      missRate: 0.25,
      hotKeys: [{ key: "user:1", hits: 10 }],
      tags: [{ tag: "users", keys: 5 }],
      invalidationEvents: [{ type: "tag", target: "users", timestamp: 1 }],
      staleServed: 2,
      errors: [{ operation: "get", message: "redis down", timestamp: 1 }],
      lockContention: [{ lock: "user:1", waitMs: 12 }],
      slowCacheCalls: [{ operation: "redis.get", durationMs: 40 }],
      providerHealth: [{ name: "redis", ok: true }],
      pluginHealth: [{ name: "mongodb-streams", ok: true }],
    });

    for (const label of [
      "Hit rate",
      "Miss rate",
      "Hot keys",
      "Tags",
      "Invalidation events",
      "Stale served",
      "Errors",
      "Lock contention",
      "Slow cache calls",
      "Provider health",
      "Plugin health",
    ]) {
      expect(html).toContain(label);
    }
  });

  test("dashboard handler is read-only by default", async () => {
    const dashboard = createDashboard({
      snapshot: async () => createEmptyDashboardSnapshot(),
    });

    await expect(dashboard.handle({ method: "POST", path: "/invalidate" })).resolves.toEqual({
      body: "Dashboard is read-only",
      headers: { "content-type": "text/plain" },
      status: 405,
    });
  });

  test("serves html and json snapshots", async () => {
    const dashboard = createDashboard({
      snapshot: async () => ({
        ...createEmptyDashboardSnapshot(),
        hitRate: 1,
      }),
    });

    await expect(dashboard.handle({ method: "GET", path: "/" })).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    await expect(dashboard.handle({ method: "GET", path: "/api/snapshot" })).resolves.toMatchObject(
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
});
