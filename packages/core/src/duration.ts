import type { DurationInput } from "./types";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

export function parseDuration(input: DurationInput, label = "duration"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`${label} must be a non-negative finite number`);
    }
    return input;
  }

  const match = DURATION_PATTERN.exec(input);
  if (!match) {
    throw new Error(`${label} must use ms, s, m, h, or d units`);
  }

  const value = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      throw new Error(`${label} has an unsupported unit`);
  }
}
