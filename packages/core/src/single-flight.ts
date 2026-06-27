export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Coalesce concurrent calls for the same `key` onto a single execution of
   * `task`. Callers that join an in-flight call intentionally share the FIRST
   * caller's outcome — both its resolved value and its rejection — rather than
   * running `task` again. The `.finally` cleanup clears the slot once settled so
   * the next call after completion starts a fresh execution.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const promise = task().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
