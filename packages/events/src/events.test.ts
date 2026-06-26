import { describe, expect, test } from "vitest";
import { createCacheAuditLogEntry, createCacheEvent, createSourceId, EventDeduper } from "./index";

describe("event helpers", () => {
  test("creates cache events with ids, source, namespace, and timestamp", () => {
    const event = createCacheEvent({
      type: "invalidate:key",
      namespace: "app",
      source: "source-a",
      timestamp: 10,
      key: "user:1",
    });

    expect(event).toMatchObject({
      type: "invalidate:key",
      namespace: "app",
      source: "source-a",
      timestamp: 10,
      key: "user:1",
    });
    expect(event.id).toContain("source-a");
  });

  test("source ids are distinct and deduper rejects duplicate event ids", () => {
    expect(createSourceId()).not.toBe(createSourceId());
    const deduper = new EventDeduper(2);

    expect(deduper.seen("one")).toBe(false);
    expect(deduper.seen("one")).toBe(true);
    deduper.seen("two");
    deduper.seen("three");
    expect(deduper.seen("one")).toBe(false);
  });

  test("creates audit log entries with actor, reason, source, and region", () => {
    const event = createCacheEvent({
      type: "invalidate:tag",
      namespace: "app",
      source: "worker-a",
      timestamp: 10,
      tag: "users",
      actor: "user:1",
      reason: "profile update",
      region: "us-east-1",
    });

    expect(createCacheAuditLogEntry(event)).toEqual({
      actor: "user:1",
      eventId: event.id,
      key: undefined,
      namespace: "app",
      reason: "profile update",
      region: "us-east-1",
      source: "worker-a",
      tag: "users",
      tenant: undefined,
      timestamp: 10,
      type: "invalidate:tag",
    });
  });
});
