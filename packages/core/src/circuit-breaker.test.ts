import { describe, expect, test } from "vitest";
import { CircuitBreaker } from "./circuit-breaker";
import type { CacheSafetyOptions, Clock } from "./types";

// A manually advanced clock so the breaker's time-based transitions (open window,
// half-open probe) are deterministic without relying on wall-clock timers.
class ManualClock implements Clock {
  private current = 0;

  now() {
    return this.current;
  }

  advance(ms: number) {
    this.current += ms;
  }
}

function makeBreaker(
  circuitBreaker: CacheSafetyOptions["circuitBreaker"],
  clock: Clock,
): CircuitBreaker {
  return new CircuitBreaker({ circuitBreaker }, clock);
}

describe("CircuitBreaker", () => {
  test("trips once failures reach failureThreshold", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 3, resetAfter: "10ms" }, clock);

    breaker.recordFailure();
    breaker.recordFailure();
    // Below the threshold the breaker stays closed.
    expect(breaker.isOpen).toBe(false);
    expect(breaker.state).toBe("closed");

    breaker.recordFailure();
    // The third failure reaches the threshold and opens the circuit.
    expect(breaker.isOpen).toBe(true);
    expect(breaker.state).toBe("open");
  });

  test("recordSuccess in CLOSED only decrements: interleaved success/failure still trips", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 3, resetAfter: "1m" }, clock);

    // A sliding window: a single success does not erase a building failure streak,
    // it only decrements the counter by one.
    breaker.recordFailure(); // failures = 1
    breaker.recordFailure(); // failures = 2
    breaker.recordSuccess(); // failures = 1 (decrement, not reset)
    breaker.recordFailure(); // failures = 2
    expect(breaker.isOpen).toBe(false);

    breaker.recordFailure(); // failures = 3 -> trips
    expect(breaker.isOpen).toBe(true);
  });

  test("a clean run of successes drains the counter back toward zero", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 2, resetAfter: "1m" }, clock);

    breaker.recordFailure(); // failures = 1
    breaker.recordSuccess(); // failures = 0 (fully drained)
    // Extra successes on an already-clean window are harmless.
    breaker.recordSuccess();
    breaker.recordSuccess();

    // One fresh failure is now the start of a new window, not the second strike.
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);
  });

  test("resets the window only after resetAfter elapses since the first failure", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 3, resetAfter: "10ms" }, clock);

    breaker.recordFailure(); // failures = 1, window opens at t=0
    clock.advance(5);
    breaker.recordFailure(); // failures = 2, still inside the window
    clock.advance(6); // t=11, > resetAfter(10) since first failure
    breaker.recordFailure(); // window reset: failures = 1 again
    expect(breaker.isOpen).toBe(false);

    breaker.recordFailure(); // failures = 2
    breaker.recordFailure(); // failures = 3 -> trips
    expect(breaker.isOpen).toBe(true);
  });

  test("transitions OPEN -> HALF_OPEN once resetAfter elapses, and a success closes it", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 1, resetAfter: "10ms" }, clock);

    breaker.recordFailure(); // single failure trips the threshold-1 breaker
    expect(breaker.state).toBe("open");
    expect(breaker.isOpen).toBe(true);

    // Before the open window elapses the breaker remains OPEN.
    clock.advance(9);
    expect(breaker.state).toBe("open");
    expect(breaker.isOpen).toBe(true);

    // Once openedUntil elapses, reading state lazily admits a single probe.
    clock.advance(1); // t=10 == openedUntil
    expect(breaker.state).toBe("half-open");
    // HALF_OPEN reads as not open so a probe request is allowed through.
    expect(breaker.isOpen).toBe(false);

    // A successful probe closes the breaker and clears history.
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(breaker.isOpen).toBe(false);
  });

  test("a failed HALF_OPEN probe re-opens immediately without re-reaching the threshold", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 5, resetAfter: "10ms" }, clock);

    // Build up to the threshold to open the circuit.
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.state).toBe("open");

    clock.advance(10); // open window elapses -> HALF_OPEN on read
    expect(breaker.state).toBe("half-open");

    // A single failed probe re-opens at once, even though the threshold is 5.
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.isOpen).toBe(true);

    // The new open window runs from the probe's failure time.
    clock.advance(9);
    expect(breaker.state).toBe("open");
    clock.advance(1);
    expect(breaker.state).toBe("half-open");
  });

  test("HALF_OPEN admits exactly one probe (the state read latches half-open)", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 1, resetAfter: "10ms" }, clock);

    breaker.recordFailure();
    clock.advance(10);
    // First read transitions to HALF_OPEN and clears openedUntil.
    expect(breaker.state).toBe("half-open");
    // Subsequent reads (even after more time) stay HALF_OPEN until a probe settles.
    clock.advance(100);
    expect(breaker.state).toBe("half-open");
    expect(breaker.isOpen).toBe(false);
  });

  test("enabled:false is a no-op: never opens and always reads closed", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: false, failureThreshold: 1, resetAfter: "10ms" }, clock);

    for (let i = 0; i < 10; i += 1) {
      breaker.recordFailure();
    }
    breaker.recordSuccess();

    expect(breaker.isOpen).toBe(false);
    expect(breaker.state).toBe("closed");
  });

  test("absent circuitBreaker config is disabled", () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker(undefined, clock);

    for (let i = 0; i < 10; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen).toBe(false);
    expect(breaker.state).toBe("closed");
  });

  test("circuitBreaker:true enables defaults (threshold 5, 30s reset)", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker(true, clock);

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure(); // fifth failure hits the default threshold of 5
    expect(breaker.isOpen).toBe(true);

    // The default reset window is 30s: still open just before, half-open at the edge.
    clock.advance(29_999);
    expect(breaker.state).toBe("open");
    clock.advance(1);
    expect(breaker.state).toBe("half-open");
  });

  test("full lifecycle: closed -> open -> half-open -> closed across resetAfter", () => {
    const clock = new ManualClock();
    const breaker = makeBreaker({ enabled: true, failureThreshold: 2, resetAfter: "10ms" }, clock);

    expect(breaker.state).toBe("closed");
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    clock.advance(10);
    expect(breaker.state).toBe("half-open");

    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");

    // After closing, the breaker is fully usable again from scratch.
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
  });
});
