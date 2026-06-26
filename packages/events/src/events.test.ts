import { describe, expect, test } from "vitest";
import { createCacheEvent, createSourceId, EventDeduper } from "./index";

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
});
