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

  let result: number;
  switch (unit) {
    case "ms":
      result = value;
      break;
    case "s":
      result = value * 1_000;
      break;
    case "m":
      result = value * 60_000;
      break;
    case "h":
      result = value * 3_600_000;
      break;
    case "d":
      result = value * 86_400_000;
      break;
    default:
      throw new Error(`${label} has an unsupported unit`);
  }

  // Guard against overflow/precision loss: a value large enough to leave the safe
  // integer range can no longer be reasoned about as a millisecond count, so reject
  // it rather than silently rounding to an imprecise (or Infinity) duration.
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} is too large`);
  }

  return result;
}
