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

  test("authorize hook allows and denies requests", async () => {
    const dashboard = createDashboard({
      snapshot: async () => createEmptyDashboardSnapshot(),
      authorize: (request) => request.path === "/api/snapshot",
    });

    // Allowed request renders normally.
    await expect(dashboard.handle({ method: "GET", path: "/api/snapshot" })).resolves.toMatchObject(
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

    // Denied request never reaches the snapshot and returns 401.
    await expect(dashboard.handle({ method: "GET", path: "/" })).resolves.toEqual({
      status: 401,
      headers: { "content-type": "text/plain" },
      body: "Unauthorized",
    });
  });

  test("never reads the snapshot when authorization is denied", async () => {
    let snapshotCalls = 0;
    const dashboard = createDashboard({
      snapshot: async () => {
        snapshotCalls += 1;
        return createEmptyDashboardSnapshot();
      },
      authorize: () => false,
    });

    await dashboard.handle({ method: "GET", path: "/" });
    expect(snapshotCalls).toBe(0);
  });

  test("a thrown authorize hook denies with 403 and notifies, never throwing", async () => {
    const seen: Error[] = [];
    const dashboard = createDashboard({
      snapshot: async () => createEmptyDashboardSnapshot(),
      authorize: () => {
        throw new Error("auth backend down");
      },
      onError: (error) => seen.push(error),
    });

    await expect(dashboard.handle({ method: "GET", path: "/" })).resolves.toEqual({
      status: 403,
      headers: { "content-type": "text/plain" },
      body: "Forbidden",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe("auth backend down");
  });

  test("a thrown cache error does not break the host operation", async () => {
    const seen: Error[] = [];
    const dashboard = createDashboard({
      snapshot: async () => {
        throw new Error("redis connection refused");
      },
      onError: (error) => seen.push(error),
    });

    // The host operation (handling the request) resolves with a safe response
    // instead of rejecting/throwing into the host HTTP server.
    const htmlResponse = await dashboard.handle({ method: "GET", path: "/" });
    expect(htmlResponse.status).toBe(503);
    expect(htmlResponse.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(htmlResponse.body).not.toContain("redis connection refused");

    const jsonResponse = await dashboard.handle({ method: "GET", path: "/api/snapshot" });
    expect(jsonResponse.status).toBe(503);
    expect(jsonResponse.headers["content-type"]).toBe("application/json");
    expect(jsonResponse.body).not.toContain("redis connection refused");

    // The cache error was routed to the notifier as a real Error, not swallowed.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.message).toBe("redis connection refused");
  });

  test("non-Error cache failures are normalized before notifying", async () => {
    const seen: Error[] = [];
    const dashboard = createDashboard({
      snapshot: async () => {
        throw "string failure";
      },
      onError: (error) => seen.push(error),
    });

    const response = await dashboard.handle({ method: "GET", path: "/" });
    expect(response.status).toBe(503);
    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0]?.message).toBe("string failure");
  });

  test("defaults to a silent no-op notifier (does not throw without onError)", async () => {
    const dashboard = createDashboard({
      snapshot: async () => {
        throw new Error("boom");
      },
    });

    await expect(dashboard.handle({ method: "GET", path: "/" })).resolves.toMatchObject({
      status: 503,
    });
  });
});
