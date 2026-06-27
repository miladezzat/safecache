import { describe, expect, test } from "vitest";
import { parseDuration } from "./duration";
import type { DurationInput } from "./types";

describe("parseDuration", () => {
  test("converts each supported unit to milliseconds", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("5s")).toBe(5_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("3h")).toBe(10_800_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  test("treats zero as a valid duration for every unit", () => {
    expect(parseDuration("0ms")).toBe(0);
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("0d")).toBe(0);
    expect(parseDuration(0)).toBe(0);
  });

  test("passes through a non-negative finite number unchanged", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(1_500)).toBe(1_500);
    expect(parseDuration(86_400_000)).toBe(86_400_000);
  });

  test("rejects negative numeric input", () => {
    expect(() => parseDuration(-1)).toThrow("must be a non-negative finite number");
  });

  test("rejects non-finite numeric input (NaN, Infinity)", () => {
    expect(() => parseDuration(Number.NaN)).toThrow("must be a non-negative finite number");
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(
      "must be a non-negative finite number",
    );
    expect(() => parseDuration(Number.NEGATIVE_INFINITY)).toThrow(
      "must be a non-negative finite number",
    );
  });

  test("rejects a string with no unit or an unsupported unit", () => {
    // The cast routes deliberately malformed strings past the compile-time template
    // type so the runtime guard itself is exercised.
    expect(() => parseDuration("10" as DurationInput)).toThrow("must use ms, s, m, h, or d units");
    expect(() => parseDuration("10w" as DurationInput)).toThrow("must use ms, s, m, h, or d units");
    expect(() => parseDuration("abc" as DurationInput)).toThrow("must use ms, s, m, h, or d units");
    expect(() => parseDuration("" as DurationInput)).toThrow("must use ms, s, m, h, or d units");
    // A negative sign is not part of the accepted pattern.
    expect(() => parseDuration("-5s" as DurationInput)).toThrow("must use ms, s, m, h, or d units");
    // Fractional values are rejected: the pattern matches whole digits only.
    expect(() => parseDuration("1.5s" as DurationInput)).toThrow(
      "must use ms, s, m, h, or d units",
    );
  });

  test("includes the custom label in error messages", () => {
    expect(() => parseDuration(-1, "ttl")).toThrow("ttl must be a non-negative finite number");
    expect(() => parseDuration("nope" as DurationInput, "timeout")).toThrow(
      "timeout must use ms, s, m, h, or d units",
    );
  });

  test("rejects a duration too large to remain a safe integer", () => {
    // 104249991375 days * 86_400_000 ms/day exceeds Number.MAX_SAFE_INTEGER, so the
    // result can no longer be represented exactly and must be rejected rather than
    // silently rounded.
    const tooManyDays = `${104_249_991_375}d` as DurationInput;
    const product = 104_249_991_375 * 86_400_000;
    expect(Number.isSafeInteger(product)).toBe(false);
    expect(() => parseDuration(tooManyDays)).toThrow("is too large");
    expect(() => parseDuration(tooManyDays, "ttl")).toThrow("ttl is too large");
  });

  test("accepts the largest unit value that stays within the safe-integer range", () => {
    // The boundary case just under the guard must still parse successfully.
    const maxSafeDays = Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000);
    expect(Number.isSafeInteger(maxSafeDays * 86_400_000)).toBe(true);
    const input = `${maxSafeDays}d` as DurationInput;
    expect(parseDuration(input)).toBe(maxSafeDays * 86_400_000);
  });
});
