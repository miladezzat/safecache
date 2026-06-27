import { describe, expect, test } from "vitest";
import { jsonSerializer, msgpackSerializer, superJsonSerializer } from "./index";

const entry = {
  value: { id: "1", createdAt: new Date("2026-06-26T00:00:00.000Z") },
  tags: ["user:1"],
  createdAt: 1,
  expiresAt: 2,
  version: "v1",
};

describe("serializers", () => {
  test("json serializer round-trips JSON-safe values", () => {
    const serializer = jsonSerializer();

    expect(serializer.deserialize(serializer.serialize({ ...entry, value: { id: "1" } }))).toEqual({
      ...entry,
      value: { id: "1" },
    });
  });

  test("superJson serializer preserves Date values", () => {
    const serializer = superJsonSerializer();

    expect(
      serializer.deserialize<typeof entry.value>(serializer.serialize(entry)).value.createdAt,
    ).toEqual(entry.value.createdAt);
  });

  test("superJson serializer round-trips real Dates and date-marker collisions losslessly", () => {
    const serializer = superJsonSerializer();
    const value = {
      realDate: new Date("2026-06-26T00:00:00.000Z"),
      collision: { __safecache_date: "x", other: 1 },
      onlyMarker: { __safecache_date: "should stay an object" },
    };

    const decoded = serializer.deserialize<typeof value>(
      serializer.serialize({ ...entry, value }),
    ).value;

    expect(decoded.realDate).toBeInstanceOf(Date);
    expect(decoded.realDate).toEqual(value.realDate);
    expect(decoded.collision).toEqual({ __safecache_date: "x", other: 1 });
    expect(decoded.onlyMarker).toEqual({ __safecache_date: "should stay an object" });
  });

  test("msgpack serializer returns bytes and round-trips values", () => {
    const serializer = msgpackSerializer();
    const raw = serializer.serialize({ ...entry, value: { id: "1" } });

    expect(raw).toBeInstanceOf(Uint8Array);
    expect(serializer.deserialize(raw).value).toEqual({ id: "1" });
  });
});
