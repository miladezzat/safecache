import type { CacheTagIndex } from "./types";

/**
 * Delimiter used to compose `(scope, tag)` and `(scope, key)` into flat map
 * keys. NUL cannot occur via normal scope/key composition, so it is safe as a
 * separator and prevents collisions between e.g. scope "a" + key "b\0c" and
 * scope "a\0b" + key "c".
 */
const DELIMITER = "\u0000";

function composite(scope: string, value: string): string {
  return `${scope}${DELIMITER}${value}`;
}

/**
 * In-memory implementation of `CacheTagIndex`. Maintains a forward index
 * (`scope\0tag -> Set<key>`) and a reverse index (`scope\0key -> Set<tag>`) so
 * that tag-based lookups and exact-key removals are both O(1) amortized.
 *
 * Suitable for single-process deployments and tests. For distributed setups,
 * back the index with a shared store (the `ttlMs` argument is provided for
 * such implementations and is intentionally ignored here).
 */
export class InMemoryTagIndex implements CacheTagIndex {
  private readonly forward = new Map<string, Set<string>>();
  private readonly reverse = new Map<string, Set<string>>();

  /**
   * Associate `tags` with `(scope, key)` in both the forward and reverse
   * indexes. `ttlMs` is ignored for the in-memory index (entries live until
   * explicitly removed); it exists for store-backed implementations.
   */
  async addTags(scope: string, key: string, tags: string[], ttlMs: number): Promise<void> {
    void ttlMs; // ignored for in-memory index
    const reverseKey = composite(scope, key);
    let reverseSet = this.reverse.get(reverseKey);
    if (reverseSet === undefined) {
      reverseSet = new Set<string>();
      this.reverse.set(reverseKey, reverseSet);
    }
    for (const tag of tags) {
      reverseSet.add(tag);
      const forwardKey = composite(scope, tag);
      let forwardSet = this.forward.get(forwardKey);
      if (forwardSet === undefined) {
        forwardSet = new Set<string>();
        this.forward.set(forwardKey, forwardSet);
      }
      forwardSet.add(key);
    }
  }

  /** Return all keys currently tagged with `tag` within `scope`. */
  async getKeysByTag(scope: string, tag: string): Promise<string[]> {
    return [...(this.forward.get(composite(scope, tag)) ?? [])];
  }

  /**
   * Remove the EXACT `(scope, key)` from the reverse index and from each
   * associated tag's forward set. When `tags` is provided, only those tags are
   * touched; otherwise the reverse-map set is used. Operates strictly on exact
   * composite keys (no suffix/prefix matching). Empty sets are pruned.
   */
  async removeKey(scope: string, key: string, tags?: string[]): Promise<void> {
    const reverseKey = composite(scope, key);
    const reverseSet = this.reverse.get(reverseKey);
    const tagsToRemove = tags ?? (reverseSet !== undefined ? [...reverseSet] : []);
    for (const tag of tagsToRemove) {
      const forwardKey = composite(scope, tag);
      const forwardSet = this.forward.get(forwardKey);
      if (forwardSet !== undefined) {
        forwardSet.delete(key);
        if (forwardSet.size === 0) {
          this.forward.delete(forwardKey);
        }
      }
      if (reverseSet !== undefined) {
        reverseSet.delete(tag);
      }
    }
    if (reverseSet !== undefined && reverseSet.size === 0) {
      this.reverse.delete(reverseKey);
    }
  }

  /**
   * Remove `tag` entirely from `scope`: delete its forward set and strip the
   * tag from the reverse set of every key it referenced. Empty reverse sets are
   * pruned.
   */
  async removeTag(scope: string, tag: string): Promise<void> {
    const forwardKey = composite(scope, tag);
    const forwardSet = this.forward.get(forwardKey);
    if (forwardSet === undefined) {
      return;
    }
    for (const key of forwardSet) {
      const reverseKey = composite(scope, key);
      const reverseSet = this.reverse.get(reverseKey);
      if (reverseSet !== undefined) {
        reverseSet.delete(tag);
        if (reverseSet.size === 0) {
          this.reverse.delete(reverseKey);
        }
      }
    }
    this.forward.delete(forwardKey);
  }
}
