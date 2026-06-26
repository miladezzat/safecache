import { describe, expect, test, vi } from "vitest";
import { cacheOutboxTableSql, createPostgresOutbox, mapPostgresOutboxRow } from "./index";

describe("Postgres outbox sync", () => {
  test("defines the required outbox table fields", () => {
    const sql = cacheOutboxTableSql();

    expect(sql).toContain("cache_outbox");
    expect(sql).toContain("event_type");
    expect(sql).toContain("payload");
    expect(sql).toContain("processed_at");
    expect(sql).toContain("retry_count");
    expect(sql).toContain("last_error");
  });

  test("maps row payloads to keys, tags, and tenant", () => {
    expect(
      mapPostgresOutboxRow({
        id: "1",
        event_type: "user.updated",
        payload: { keys: ["user:1"], tags: ["users"], tenant: "acme" },
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      }),
    ).toEqual({ keys: ["user:1"], tags: ["users"], tenant: "acme" });
  });

  test("polls unprocessed rows, invalidates, and marks success", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "1",
              event_type: "user.updated",
              payload: { keys: ["user:1"], tags: ["users"] },
              created_at: new Date(),
              processed_at: null,
              retry_count: 0,
              last_error: null,
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const outbox = createPostgresOutbox({ client });

    await expect(outbox.poll(cache)).resolves.toEqual({
      failed: 0,
      processed: 1,
      rows: 1,
    });

    expect(cache.invalidate).toHaveBeenCalledWith("user:1", { tenant: undefined });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("users", { tenant: undefined });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("processed_at"), ["1"]);
  });

  test("retries failed rows without marking them processed", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "1",
              event_type: "user.updated",
              payload: { tags: ["users"] },
              created_at: new Date(),
              processed_at: null,
              retry_count: 0,
              last_error: null,
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => Promise.reject(new Error("cache down"))),
    };
    const outbox = createPostgresOutbox({ client });

    await expect(outbox.poll(cache)).resolves.toEqual({
      failed: 1,
      processed: 0,
      rows: 1,
    });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("retry_count"), [
      "1",
      "cache down",
    ]);
  });
});
