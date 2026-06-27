import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cache, CachePluginContext, CacheRuntimeEvent } from "@safecache/core";
import {
  cacheOutboxTableSql,
  createPostgresOutbox,
  mapPostgresOutboxRow,
  postgresOutbox,
  type CacheOutboxRow,
  type PostgresClientLike,
  type PostgresQueryResult,
} from "./index";

type FakeCache = Pick<Cache, "invalidate" | "invalidateByTag">;

/**
 * Builds a minimal {@link CachePluginContext} around a cache fake, capturing
 * every emitted runtime event so plugin-lifecycle tests can assert on them.
 */
function createPluginContext(cache: FakeCache): {
  ctx: CachePluginContext;
  emitted: CacheRuntimeEvent[];
} {
  const emitted: CacheRuntimeEvent[] = [];
  const ctx = {
    cache: cache as Cache,
    emit: (event: CacheRuntimeEvent) => {
      emitted.push(event);
    },
  } satisfies CachePluginContext;
  return { ctx, emitted };
}

type FakeClient = PostgresClientLike & {
  query: ReturnType<typeof vi.fn> & PostgresClientLike["query"];
  rows: OutboxStoreRow[];
};

type OutboxStoreRow = CacheOutboxRow & { locked: boolean; claimed_at: Date | null };

/**
 * Minimal in-memory fake that mimics the slice of Postgres semantics the outbox
 * relies on: a claim CTE (`with claimed as (select ... for update skip locked)
 * update ... returning`) that respects skip-locked AND the `claimed_at` lease,
 * plus the processed / retry / dead-letter updates. Row locks are released by
 * `commit`/`rollback`, mirroring the claim-then-dispatch flow where invalidation
 * happens OUTSIDE the transaction.
 */
function createFakeClient(initialRows: CacheOutboxRow[], maxRetries?: number): FakeClient {
  const rows: OutboxStoreRow[] = initialRows.map((row) => ({
    ...row,
    locked: false,
    claimed_at: null,
  }));
  // Rows locked by the currently-open transaction (released on commit/rollback).
  let txLocked: OutboxStoreRow[] = [];

  async function query<TRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    const text = sql.trim().toLowerCase();

    if (text === "begin") {
      return { rows: [] };
    }
    if (text === "commit" || text === "rollback") {
      // Releasing the claim transaction drops the FOR UPDATE locks; the lease
      // (`claimed_at`) is what now keeps the row from being re-claimed.
      for (const row of txLocked) row.locked = false;
      txLocked = [];
      return { rows: [] };
    }

    // The claim is a CTE: `with claimed as (select ... for update skip locked)
    // update ... set claimed_at = now() returning ...`.
    if (text.startsWith("with") && text.includes("for update skip locked")) {
      const limit = typeof params[0] === "number" ? params[0] : rows.length;
      const leaseBoundary = params[1] instanceof Date ? params[1] : new Date(0);
      const claimed: OutboxStoreRow[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        if (row.processed_at !== null) continue;
        if (row.locked) continue; // skip locked
        // Re-claimable only if never claimed or the lease has expired.
        if (row.claimed_at !== null && row.claimed_at >= leaseBoundary) continue;
        if (maxRetries !== undefined && row.retry_count >= maxRetries) continue;
        row.locked = true;
        row.claimed_at = new Date();
        txLocked.push(row);
        claimed.push(row);
      }
      // `returning` projects the row columns (without the simulated lock fields).
      return { rows: claimed.map(projectRow) as unknown as TRow[] };
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
        if (text.includes("claimed_at = null")) {
          target.claimed_at = null;
        }
        if (text.includes("last_error = null")) {
          target.last_error = null;
        }
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  return { query: vi.fn(query) as FakeClient["query"], rows };
}

function projectRow(row: OutboxStoreRow): CacheOutboxRow {
  return {
    id: row.id,
    event_type: row.event_type,
    payload: row.payload,
    created_at: row.created_at,
    processed_at: row.processed_at,
    retry_count: row.retry_count,
    last_error: row.last_error,
  };
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
      deadLettered: 0,
      failed: 0,
      processed: 1,
      rows: 1,
    });

    expect(cache.invalidate).toHaveBeenCalledWith("user:1", { tenant: undefined });
    expect(cache.invalidateByTag).toHaveBeenCalledWith("users", { tenant: undefined });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("processed_at"), ["1"]);
  });

  test("claims with for update skip locked then commits BEFORE invalidating (no lock held across cache I/O)", async () => {
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
    let committedBeforeInvalidate = false;
    const calls: string[] = [];
    const originalQuery = client.query;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.trim().toLowerCase());
      return originalQuery(sql, params);
    }) as FakeClient["query"];
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {
        // By the time invalidation runs, the claim transaction must already be
        // committed — that is the whole point of claim-then-dispatch.
        committedBeforeInvalidate = calls.includes("commit");
      }),
    };

    await createPostgresOutbox({ client }).poll(cache);

    expect(calls[0]).toBe("begin");
    const claimIdx = calls.findIndex((sql) => sql.includes("for update skip locked"));
    const commitIdx = calls.indexOf("commit");
    expect(claimIdx).toBeGreaterThan(0);
    // The claim is committed immediately after claiming, before any mark update.
    expect(commitIdx).toBe(claimIdx + 1);
    expect(committedBeforeInvalidate).toBe(true);
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
      deadLettered: 0,
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

  function singleRowClient(payload: unknown, id: string | number = "1") {
    return createFakeClient([
      {
        id,
        event_type: "user.updated",
        payload,
        created_at: new Date(),
        processed_at: null,
        retry_count: 0,
        last_error: null,
      },
    ]);
  }

  test("SAFETY: a thrown cache error never breaks the host poll and is routed to onError", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    const cacheError = new Error("redis exploded");
    const cache = {
      invalidate: vi.fn(async () => {
        throw cacheError;
      }),
      invalidateByTag: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const outbox = createPostgresOutbox({ client, onError });

    // The host operation (poll) resolves normally — the cache failure does NOT
    // throw into the caller.
    await expect(outbox.poll(cache)).resolves.toEqual({
      deadLettered: 0,
      failed: 1,
      processed: 0,
      rows: 1,
    });

    // The error was routed to the notifier and the row is left for retry.
    expect(onError).toHaveBeenCalledTimes(1);
    const routed = onError.mock.calls[0]?.[0] as CacheRuntimeEvent | undefined;
    expect(routed?.type).toBe("error");
    if (routed?.type === "error") {
      expect(routed.error).toBe(cacheError);
    }
    expect(client.rows[0]?.processed_at).toBeNull();
    expect(client.rows[0]?.retry_count).toBe(1);
  });

  test("SAFETY: defaults to a silent no-op notifier (no throw) when none is provided", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    const cache = {
      invalidate: vi.fn(async () => {
        throw new Error("cache down");
      }),
      invalidateByTag: vi.fn(async () => {}),
    };
    // No onError option: must still not throw.
    const outbox = createPostgresOutbox({ client });
    await expect(outbox.poll(cache)).resolves.toMatchObject({ failed: 1, processed: 0 });
  });

  test("SAFETY: a throwing onError notifier can never break the worker", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    const cache = {
      invalidate: vi.fn(async () => {
        throw new Error("cache down");
      }),
      invalidateByTag: vi.fn(async () => {}),
    };
    const outbox = createPostgresOutbox({
      client,
      onError: () => {
        throw new Error("notifier blew up");
      },
    });
    await expect(outbox.poll(cache)).resolves.toMatchObject({ failed: 1 });
  });

  test("propagateInvalidationErrors opt-in re-throws a cache error after notifying", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    const cacheError = new Error("redis exploded");
    const cache = {
      invalidate: vi.fn(async () => {
        throw cacheError;
      }),
      invalidateByTag: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const outbox = createPostgresOutbox({
      client,
      onError,
      propagateInvalidationErrors: true,
    });

    await expect(outbox.poll(cache)).rejects.toBe(cacheError);
    // Still routed to the notifier and recorded as a failure before re-throwing.
    expect(onError).toHaveBeenCalled();
    expect(client.rows[0]?.retry_count).toBe(1);
  });

  test("treats a malformed JSON payload as a (non-retryable) dead-letter, not a generic failure", async () => {
    // A string payload that is not valid JSON makes mapPostgresOutboxRow throw.
    const client = singleRowClient("{not valid json");
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const outbox = createPostgresOutbox({ client, onError });

    const result = await outbox.poll(cache);

    // Dead-lettered immediately (no retry budget burned forever) even without
    // maxRetries configured, because a parse failure can never succeed.
    expect(result).toEqual({ deadLettered: 1, failed: 1, processed: 0, rows: 1 });
    expect(client.rows[0]?.processed_at).not.toBeNull();
    // A parse-specific signal is emitted so it is observable.
    const ops = onError.mock.calls.map((call) => (call[0] as { operation: string }).operation);
    expect(ops).toContain("postgres-outbox:dead-letter:parse");
    // The cache was never touched for an unparseable row.
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(cache.invalidateByTag).not.toHaveBeenCalled();
    // A parse failure is never re-thrown even with propagateInvalidationErrors.
    const second = await createPostgresOutbox({
      client: singleRowClient("{still bad"),
      onError: vi.fn(),
      propagateInvalidationErrors: true,
    }).poll(cache);
    expect(second.deadLettered).toBe(1);
  });

  test("emits an observable dead-letter signal when a poison row exceeds maxRetries", async () => {
    const client = singleRowClient({ tags: ["users"] });
    client.rows[0]!.retry_count = 2; // one more failure crosses maxRetries = 3
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {
        throw new Error("still failing");
      }),
    };
    const onError = vi.fn();
    const outbox = createPostgresOutbox({ client, maxRetries: 3, onError });

    const result = await outbox.poll(cache);

    expect(result.deadLettered).toBe(1);
    const ops = onError.mock.calls.map((call) => (call[0] as { operation: string }).operation);
    expect(ops).toContain("postgres-outbox:dead-letter");
  });

  test("a mark-failure on one row is isolated and surfaced, not fatal to the batch", async () => {
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
    // Make the markProcessed UPDATE throw, but leave begin/claim/commit working.
    const realQuery = client.query;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.trim().toLowerCase().startsWith("update") && sql.includes("processed_at = now()")) {
        throw new Error("db write failed");
      }
      return realQuery(sql, params);
    }) as FakeClient["query"];
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };
    const onError = vi.fn();

    // poll() resolves; the mark failure is reported, not thrown.
    await expect(createPostgresOutbox({ client, onError }).poll(cache)).resolves.toMatchObject({
      rows: 1,
    });
    const ops = onError.mock.calls.map((call) => (call[0] as { operation: string }).operation);
    expect(ops).toContain("postgres-outbox:mark");
  });

  test("a committed claim is leased: a second poll cannot re-claim within claimMs", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalClaimed: () => void = () => {};
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    const cache = {
      invalidate: vi.fn(async () => {
        signalClaimed();
        await gate;
      }),
      invalidateByTag: vi.fn(async () => {}),
    };

    // Poll A claims + commits, then hangs in invalidation (lock released, lease held).
    const pollA = createPostgresOutbox({ client }).poll(cache);
    await claimed;
    // Poll B runs while A is mid-invalidation: the row is unlocked but leased.
    const resultB = await createPostgresOutbox({ client }).poll(cache);
    expect(resultB.rows).toBe(0);

    release();
    const resultA = await pollA;
    expect(resultA.processed).toBe(1);
  });

  test("an expired claim lease lets the row be re-claimed (at-least-once redelivery)", async () => {
    const client = singleRowClient({ keys: ["user:1"] });
    const cache = {
      invalidate: vi.fn(async () => {}),
      invalidateByTag: vi.fn(async () => {}),
    };

    // Simulate a worker that claimed the row long ago then died before marking
    // it processed: the lease is well past claimMs.
    client.rows[0]!.claimed_at = new Date(Date.now() - 60_000);

    const result = await createPostgresOutbox({ client, claimMs: 1_000 }).poll(cache);
    expect(result.processed).toBe(1);
    expect(cache.invalidate).toHaveBeenCalledWith("user:1", { tenant: undefined });
  });

  describe("plugin poll loop (fake timers)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("pollOnStart + interval loop polls repeatedly without piling up", async () => {
      vi.useFakeTimers();
      const client = createFakeClient([]);
      const cache: FakeCache = {
        invalidate: vi.fn(async () => {}),
        invalidateByTag: vi.fn(async () => {}),
      };
      const outbox = createPostgresOutbox({
        client,
        pollIntervalMs: 1_000,
        pollOnStart: true,
      });
      const plugin = outbox.plugin();
      const { ctx } = createPluginContext(cache);

      plugin.setup(ctx);
      // pollOnStart fired one claim immediately.
      await vi.advanceTimersByTimeAsync(0);
      const claimCallsAfterStart = claimCount(client);
      expect(claimCallsAfterStart).toBeGreaterThanOrEqual(1);

      // Advancing three intervals schedules three more ticks (self-rescheduling
      // setTimeout chain), each polling exactly once.
      await vi.advanceTimersByTimeAsync(3_000);
      const claimCallsLater = claimCount(client);
      expect(claimCallsLater).toBeGreaterThan(claimCallsAfterStart);

      await plugin.shutdown?.();
      const afterShutdown = claimCount(client);
      // No further ticks fire once shut down.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(claimCount(client)).toBe(afterShutdown);
    });

    test("overlapping ticks cannot pile up: a slow tick blocks the next from claiming twice", async () => {
      vi.useFakeTimers();
      const client = singleRowClient({ keys: ["user:1"] });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inInvalidate = 0;
      const cache: FakeCache = {
        invalidate: vi.fn(async () => {
          inInvalidate += 1;
          await gate;
        }),
        invalidateByTag: vi.fn(async () => {}),
      };
      const outbox = createPostgresOutbox({
        client,
        pollIntervalMs: 1_000,
        pollOnStart: true,
      });
      const plugin = outbox.plugin();
      const { ctx } = createPluginContext(cache);

      plugin.setup(ctx);
      await vi.advanceTimersByTimeAsync(0); // first tick claims + hangs in invalidate
      // Drive several more intervals while the first tick is still mid-flight.
      await vi.advanceTimersByTimeAsync(3_000);
      // The in-flight guard means only ONE invalidation is ever running.
      expect(inInvalidate).toBe(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      await plugin.shutdown?.();
    });

    test("a failing tick surfaces via emit + onError and backs off", async () => {
      vi.useFakeTimers();
      const client = createFakeClient([]);
      // Make the claim transaction fail so the whole poll() rejects.
      client.query = vi.fn(async (sql: string) => {
        if (sql.trim().toLowerCase() === "begin") {
          throw new Error("connection refused");
        }
        return { rows: [] };
      }) as FakeClient["query"];
      const cache: FakeCache = {
        invalidate: vi.fn(async () => {}),
        invalidateByTag: vi.fn(async () => {}),
      };
      const onError = vi.fn();
      const plugin = postgresOutbox({
        client,
        pollIntervalMs: 1_000,
        pollOnStart: true,
        onError,
        pollBackoffBaseMs: 1_000,
      });
      const { ctx, emitted } = createPluginContext(cache);

      plugin.setup(ctx);
      await vi.advanceTimersByTimeAsync(0);
      // The pollOnStart failure was both emitted to the runtime and the notifier.
      expect(emitted.some((e) => e.type === "error" && e.operation === "postgres-outbox")).toBe(
        true,
      );
      expect(onError).toHaveBeenCalled();

      // Advance generously to let backed-off ticks fire; each keeps failing but
      // the worker never crashes (we just keep getting error events).
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onError.mock.calls.length).toBeGreaterThan(1);

      await plugin.shutdown?.();
    });
  });
});

function claimCount(client: FakeClient): number {
  return client.query.mock.calls.filter((call) =>
    String(call[0]).trim().toLowerCase().includes("for update skip locked"),
  ).length;
}
