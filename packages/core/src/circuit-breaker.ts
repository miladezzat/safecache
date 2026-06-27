import { parseDuration } from "./duration";
import type { CacheSafetyOptions, Clock, DurationInput } from "./types";

type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failures = 0;
  private firstFailureAt = 0;
  private openedUntil = 0;
  // Set once the open window elapses and a single trial probe is permitted.
  private halfOpen = false;
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

  /**
   * Current circuit state. Reading it lazily transitions OPEN -> HALF_OPEN once
   * `openedUntil` elapses so callers observe the same view as `isOpen`.
   */
  get state(): CircuitState {
    if (!this.enabled) {
      return "closed";
    }
    if (this.halfOpen) {
      return "half-open";
    }
    if (this.openedUntil === 0) {
      return "closed";
    }
    if (this.clock.now() >= this.openedUntil) {
      // Open window has elapsed: allow exactly one trial probe.
      this.halfOpen = true;
      this.openedUntil = 0;
      return "half-open";
    }
    return "open";
  }

  /** True only while OPEN and before `openedUntil`; HALF_OPEN reads as not open. */
  get isOpen(): boolean {
    return this.state === "open";
  }

  recordSuccess(): void {
    if (!this.enabled) {
      return;
    }
    if (this.halfOpen) {
      // A successful probe in HALF_OPEN closes the breaker and clears history.
      this.reset();
      return;
    }
    // In CLOSED we use a sliding window rather than zeroing on every success:
    // decrement so isolated successes do not erase a building failure streak,
    // but a clean run still drains the counter back toward zero.
    if (this.failures > 0) {
      this.failures -= 1;
      if (this.failures === 0) {
        this.firstFailureAt = 0;
      }
    }
  }

  recordFailure(): void {
    if (!this.enabled) {
      return;
    }
    if (this.halfOpen) {
      // A failed probe re-opens immediately without re-reaching the threshold.
      this.halfOpen = false;
      this.openedUntil = this.clock.now() + this.resetAfterMs;
      return;
    }

    const now = this.clock.now();
    // Reset the window only when `resetAfterMs` has elapsed since the FIRST
    // failure of the current window, so interleaved success/failure that
    // accumulates enough failures within the window still trips the breaker.
    if (this.failures === 0 || now - this.firstFailureAt >= this.resetAfterMs) {
      this.failures = 0;
      this.firstFailureAt = now;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedUntil = now + this.resetAfterMs;
      this.failures = 0;
      this.firstFailureAt = 0;
    }
  }

  private reset(): void {
    this.failures = 0;
    this.firstFailureAt = 0;
    this.openedUntil = 0;
    this.halfOpen = false;
  }
}
