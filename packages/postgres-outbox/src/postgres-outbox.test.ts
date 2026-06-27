import { describe, expect, test, vi } from "vitest";
import {
  cacheOutboxTableSql,
  createPostgresOutbox,
  mapPostgresOutboxRow,
  type CacheOutboxRow,
  type PostgresClientLike,
  type PostgresQueryResult,
} from "./index";

type FakeClient = PostgresClientLike & {
  query: ReturnType<typeof vi.fn> & PostgresClientLike["query"];
  rows: OutboxStoreRow[];
};

type OutboxStoreRow = CacheOutboxRow & { locked: boolean };

/**
 * Minimal in-memory fake that mimics the slice of Postgres semantics the outbox
 * relies on: transactional claim queries that respect `for update skip locked`,
 * plus the processed / retry / dead-letter updates. Locking is simulated so two
 * concurrent polls cannot claim the same row.
 */
function createFakeClient(initialRows: CacheOutboxRow[], maxRetries?: number): FakeClient {
  const rows: OutboxStoreRow[] = initialRows.map((row) => ({ ...row, locked: false }));

  async function query<TRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    const text = sql.trim().toLowerCase();

    if (text === "begin" || text === "commit" || text === "rollback") {
      return { rows: [] };
    }

    if (text.startsWith("select")) {
      // Only a SELECT ... FOR UPDATE SKIP LOCKED takes/honors row locks, exactly
      // like real Postgres. A plain SELECT ignores locks, so two concurrent
      // pollers would both read the same unprocessed row (the original bug).
      const claims = text.includes("for update skip locked");
      const limit = typeof params[0] === "number" ? params[0] : rows.length;
      const claimed: OutboxStoreRow[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        if (row.processed_at !== null) continue;
        if (claims && row.locked) continue; // skip locked
        if (maxRetries !== undefined && row.retry_count >= maxRetries) continue;
        if (claims) row.locked = true;
        claimed.push(row);
      }
      return { rows: claimed as unknown as TRow[] };
    }

    if (text.startsWith("update")) {
      const id = params[0];
      const target = rows.find((row) => row.id === id);
      if (target) {
        if (text.includes("processed_at = now()")) {
          target.processed_at = new Date();
        }
        if (text.includes("retry_count = retry_count + 1")) {
          target.retry_count += 1;
          target.last_error = typeof params[1] === "string" ? params[1] : null;
        }
        target.locked = false;
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  return { query: vi.fn(query) as FakeClient["query"], rows };
}

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
    const client = createFakeClient([
      {
        id: "1",
        event_type: "user.updated",
        payload: { keys: ["user:1"], tags: ["users"] },
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      },
    ]);
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

  test("claims rows with for update skip locked inside a transaction", async () => {
    const client = createFakeClient([
      {
        id: "1",
        event_type: "user.updated",
        payload: { tags: ["users"] },
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      },
    ]);
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };

    await createPostgresOutbox({ client }).poll(cache);

    const calls = client.query.mock.calls.map((call) => String(call[0]).trim().toLowerCase());
    expect(calls[0]).toBe("begin");
    expect(calls.some((sql) => sql.includes("for update skip locked"))).toBe(true);
    expect(calls.at(-1)).toBe("commit");
  });

  test("retries failed rows without marking them processed", async () => {
    const client = createFakeClient([
      {
        id: "1",
        event_type: "user.updated",
        payload: { tags: ["users"] },
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      },
    ]);
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
    expect(client.rows[0]?.processed_at).toBeNull();
  });

  test("does not double-process a row claimed by a concurrent poll", async () => {
    // Single shared store: the fake locks claimed rows, so a second concurrent
    // poll must skip the row already claimed by the first (skip locked).
    const client = createFakeClient([
      {
        id: "1",
        event_type: "user.updated",
        payload: { keys: ["user:1"] },
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      },
    ]);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalClaimed: () => void = () => {};
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    let invalidateCalls = 0;
    const cache = {
      invalidate: vi.fn(async () => {
        invalidateCalls += 1;
        // First poll has now claimed and locked the row; let the test start the
        // second poll, then hold this poll mid-flight against the locked row.
        signalClaimed();
        await gate;
      }),
      invalidateByTag: vi.fn(async () => {}),
    };

    // Two independent instances simulate two HA workers sharing one DB.
    const pollA = createPostgresOutbox({ client }).poll(cache);
    // Wait until poll A has claimed (locked) the row before poll B starts.
    await claimed;
    const resultB = await createPostgresOutbox({ client }).poll(cache);

    release();
    const resultA = await pollA;

    // Only one poll processed the row; the other saw zero claimable rows.
    expect(resultA.processed + resultB.processed).toBe(1);
    expect(resultB.rows).toBe(0);
    expect(invalidateCalls).toBe(1);
  });

  test("dead-letters a poison row past maxRetries so a newer row is processed", async () => {
    const client = createFakeClient(
      [
        {
          id: "poison",
          event_type: "user.updated",
          payload: { tags: ["users"] },
          created_at: new Date("2024-01-01T00:00:00Z"),
          processed_at: null,
          retry_count: 2, // already at the cap; this attempt exceeds maxRetries
          last_error: "boom",
        },
        {
          id: "good",
          event_type: "user.updated",
          payload: { keys: ["user:2"] },
          created_at: new Date("2024-01-01T00:00:01Z"),
          processed_at: null,
          retry_count: 0,
          last_error: null,
        },
      ],
      3,
    );
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => Promise.reject(new Error("still failing"))),
    };
    const outbox = createPostgresOutbox({ client, maxRetries: 3 });

    const result = await outbox.poll(cache);

    // Poison row dead-lettered (marked processed), good row processed.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    const poison = client.rows.find((row) => row.id === "poison");
    const good = client.rows.find((row) => row.id === "good");
    expect(poison?.processed_at).not.toBeNull();
    expect(good?.processed_at).not.toBeNull();
    expect(cache.invalidate).toHaveBeenCalledWith("user:2", { tenant: undefined });

    // A subsequent poll no longer sees the poison row (excluded by the cap),
    // proving it can never block the FIFO head again.
    const second = await outbox.poll(cache);
    expect(second.rows).toBe(0);
  });
});
