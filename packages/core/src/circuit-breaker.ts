import { parseDuration } from "./duration";
import type { CacheSafetyOptions, Clock, DurationInput } from "./types";

export class CircuitBreaker {
  private failures = 0;
  private openedUntil = 0;
  private readonly enabled: boolean;
  private readonly failureThreshold: number;
  private readonly resetAfterMs: number;

  constructor(
    safety: CacheSafetyOptions | undefined,
    private readonly clock: Clock,
  ) {
    const options = safety?.circuitBreaker;
    if (!options) {
      this.enabled = false;
      this.failureThreshold = 0;
      this.resetAfterMs = 0;
      return;
    }

    if (options === true) {
      this.enabled = true;
      this.failureThreshold = 5;
      this.resetAfterMs = parseDuration("30s");
      return;
    }

    this.enabled = options.enabled ?? true;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetAfterMs = parseDuration((options.resetAfter ?? "30s") as DurationInput);
  }

  get isOpen(): boolean {
    if (!this.enabled) {
      return false;
    }
    if (this.openedUntil === 0) {
      return false;
    }
    if (this.clock.now() >= this.openedUntil) {
      this.openedUntil = 0;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedUntil = 0;
  }

  recordFailure(): void {
    if (!this.enabled) {
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedUntil = this.clock.now() + this.resetAfterMs;
    }
  }
}
