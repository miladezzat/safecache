import type { CacheEntry, CacheSerializer } from "./types";

export function jsonSerializer(): CacheSerializer {
  return {
    serialize(entry: CacheEntry) {
      return JSON.stringify(entry);
    },
    deserialize<T>(raw: string | Uint8Array) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text) as CacheEntry<T>;
      if (!parsed || typeof parsed !== "object" || !("expiresAt" in parsed)) {
        throw new Error("Invalid cache entry");
      }
      return parsed;
    },
  };
}
