import { describe, expect, test } from "vitest";
import {
  createCacheAuditLogEntry,
  createCacheEvent,
  createSourceId,
  isCacheEvent,
  parseCacheEvent,
} from "./index";

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

  test("source ids are distinct", () => {
    expect(createSourceId()).not.toBe(createSourceId());
  });

  test("re-exports core validation helpers that accept created events", () => {
    const event = createCacheEvent({
      type: "invalidate:key",
      namespace: "app",
      source: "source-a",
      timestamp: 10,
      key: "user:1",
    });

    expect(isCacheEvent(event)).toBe(true);
    expect(parseCacheEvent(JSON.stringify(event))).toEqual(event);
  });

  test("re-exported validation helpers reject malformed events", () => {
    expect(isCacheEvent({ id: "x", type: "bogus" })).toBe(false);
    expect(() => parseCacheEvent("{not json")).toThrow(/invalid cache event/);
    expect(() => parseCacheEvent({ id: 1 })).toThrow(/invalid cache event/);
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
